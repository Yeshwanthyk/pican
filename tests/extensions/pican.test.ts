import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// Mock node:fs before importing the module under test
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    chmodSync: vi.fn(),
    mkdirSync: vi.fn((path: string, options?: unknown) => {
      if (typeof path === 'string' && path.includes('/.tmp-test-')) {
        return (actual as any).mkdirSync(path, options as any);
      }
      return undefined;
    }),
    writeFileSync: vi.fn((path: string, content: string, options?: unknown) => {
      const tokenEnvPath = `${homedir()}/.config/pican/env`;
      if (typeof path === 'string' && path === tokenEnvPath) {
        (globalThis as any).__MOCK_PICAN_ENV_CONTENT__ = content;
        return undefined;
      }
      return (actual as any).writeFileSync(path, content, options);
    }),
    readFileSync: vi.fn((path: string, encoding: BufferEncoding) => {
      // Delegate to actual unless it's the token env file
      const tokenEnvPath = `${homedir()}/.config/pican/env`;
      if (typeof path === 'string' && path === tokenEnvPath) {
        const content = (globalThis as any).__MOCK_PICAN_ENV_CONTENT__;
        if (content !== undefined) return content;
        const token = (globalThis as any).__MOCK_PICAN_TOKEN__;
        if (token === undefined) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        if (token === null) return '';
        return `PICAN_TOKEN=${token}\n`;
      }
      return (actual as any).readFileSync(path, encoding);
    }),
  };
});

import {
  isTailscaleHost,
  isSSH,
  normalizeCommandArgs,
  withToken,
  readPicanToken,
  writePicanToken,
  picanAssetName,
  picanReleaseDownloadUrl,
  picanReleaseChecksumsUrl,
  checksumForAsset,
  sha256OfFile,
  updatePicanFromRelease,
} from '../../.pi/extensions/pican.ts';

declare global {
  var __MOCK_PICAN_TOKEN__: string | null | undefined;
  var __MOCK_PICAN_ENV_CONTENT__: string | undefined;
}

// ── isSSH ───────────────────────────────────────────────────────────
describe('isSSH', () => {
  const orig = { ...process.env };

  beforeEach(() => {
    delete process.env.SSH_TTY;
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
  });

  afterEach(() => {
    process.env = { ...orig };
  });

  it('returns false when no SSH env vars are set', () => {
    expect(isSSH()).toBe(false);
  });

  it('returns true when SSH_TTY is set', () => {
    process.env.SSH_TTY = '/dev/pts/0';
    expect(isSSH()).toBe(true);
  });

  it('returns true when SSH_CONNECTION is set', () => {
    process.env.SSH_CONNECTION = '192.168.1.1 1234 10.0.0.1 22';
    expect(isSSH()).toBe(true);
  });

  it('returns true when SSH_CLIENT is set', () => {
    process.env.SSH_CLIENT = '192.168.1.1 1234 22';
    expect(isSSH()).toBe(true);
  });
});

// ── isTailscaleHost ─────────────────────────────────────────────────
describe('isTailscaleHost', () => {
  it('detects Tailscale IPv4 CGNAT range', () => {
    expect(isTailscaleHost('100.64.0.1')).toBe(true);
    expect(isTailscaleHost('100.100.50.25')).toBe(true);
    expect(isTailscaleHost('100.127.255.254')).toBe(true);
  });

  it('rejects non-Tailscale IPv4 addresses', () => {
    expect(isTailscaleHost('127.0.0.1')).toBe(false);
    expect(isTailscaleHost('192.168.1.1')).toBe(false);
    expect(isTailscaleHost('10.0.0.1')).toBe(false);
    expect(isTailscaleHost('100.63.255.255')).toBe(false);
    expect(isTailscaleHost('100.128.0.0')).toBe(false);
  });

  it('rejects IPv6 addresses (only checks first : segment)', () => {
    // isTailscaleHost splits on ':' so IPv6 host:port strings like
    // '[fd7a:115c:a1e0::1]:31415' would have the '[' bracket as ip.
    // Pure IPv6 without brackets/port is not the expected input.
    expect(isTailscaleHost('::1')).toBe(false);
    expect(isTailscaleHost('fe80::1')).toBe(false);
  });
});

// ── normalizeCommandArgs ────────────────────────────────────────────
describe('normalizeCommandArgs', () => {
  it('returns empty for undefined', () => {
    expect(normalizeCommandArgs(undefined)).toEqual([]);
  });

  it('returns empty for empty string', () => {
    expect(normalizeCommandArgs('')).toEqual([]);
  });

  it('returns empty for whitespace string', () => {
    expect(normalizeCommandArgs('   ')).toEqual([]);
  });

  it('splits a string into words', () => {
    expect(normalizeCommandArgs('hello world')).toEqual(['hello', 'world']);
  });

  it('handles array input', () => {
    expect(normalizeCommandArgs(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('converts numbers to strings', () => {
    expect(normalizeCommandArgs([1, 2])).toEqual(['1', '2']);
  });

  it('set-token destructure: [, token] from [subcommand, token]', () => {
    const [, token] = normalizeCommandArgs('set-token my-secret');
    expect(token).toBe('my-secret');
  });

  it('set-token destructure: token with special chars', () => {
    const [, token] = normalizeCommandArgs('set-token sec=ret&val');
    expect(token).toBe('sec=ret&val');
  });
});

// ── GitHub Releases update ─────────────────────────────────────────
describe('picanAssetName', () => {
  it('maps darwin/x64 to pican-darwin-amd64', () => {
    expect(picanAssetName('darwin', 'x64')).toBe('pican-darwin-amd64');
  });

  it('maps darwin/arm64 to pican-darwin-arm64', () => {
    expect(picanAssetName('darwin', 'arm64')).toBe('pican-darwin-arm64');
  });

  it('maps linux x64 and arm64', () => {
    expect(picanAssetName('linux', 'x64')).toBe('pican-linux-amd64');
    expect(picanAssetName('linux', 'arm64')).toBe('pican-linux-arm64');
  });

  it('maps win32 to windows with a .exe suffix', () => {
    expect(picanAssetName('win32', 'x64')).toBe('pican-windows-amd64.exe');
    expect(picanAssetName('win32', 'arm64')).toBe('pican-windows-arm64.exe');
  });

  it('rejects unsupported platforms and architectures', () => {
    expect(() => picanAssetName('freebsd', 'x64')).toThrow();
    expect(() => picanAssetName('darwin', 'ia32')).toThrow();
  });
});

describe('release URLs', () => {
  it('builds the /releases/latest/download URL for an asset', () => {
    expect(picanReleaseDownloadUrl('pican-darwin-arm64')).toBe(
      'https://github.com/Yeshwanthyk/pican/releases/latest/download/pican-darwin-arm64',
    );
  });

  it('builds the sha256sums.txt URL', () => {
    expect(picanReleaseChecksumsUrl()).toBe(
      'https://github.com/Yeshwanthyk/pican/releases/latest/download/sha256sums.txt',
    );
  });
});

describe('checksumForAsset', () => {
  const hash = 'a'.repeat(64);

  it('finds the hash in standard sha256sum output (hash first)', () => {
    expect(checksumForAsset(`${hash}  pican-darwin-arm64\n`, 'pican-darwin-arm64')).toBe(hash);
  });

  it('accepts the name-first column order', () => {
    expect(checksumForAsset(`pican-darwin-arm64  ${hash}\n`, 'pican-darwin-arm64')).toBe(hash);
  });

  it('ignores ./ and * name prefixes', () => {
    expect(checksumForAsset(`${hash}  ./pican-darwin-arm64\n`, 'pican-darwin-arm64')).toBe(hash);
    expect(checksumForAsset(`${hash}  *pican-darwin-arm64\n`, 'pican-darwin-arm64')).toBe(hash);
  });

  it('skips comments and blank lines', () => {
    const sums = `# generated by goreleaser\n\n${hash}  pican-darwin-arm64\n`;
    expect(checksumForAsset(sums, 'pican-darwin-arm64')).toBe(hash);
  });

  it('fails closed when the asset has no entry', () => {
    expect(() => checksumForAsset(`${hash}  pican-linux-amd64\n`, 'pican-darwin-arm64')).toThrow(
      'no entry',
    );
  });
});

describe('sha256OfFile', () => {
  it('computes the sha256 of a file', () => {
    const path = `${process.cwd()}/.tmp-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    writeFileSync(path, 'pican update bytes');
    try {
      const want = createHash('sha256').update('pican update bytes').digest('hex');
      expect(sha256OfFile(path)).toBe(want);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('updatePicanFromRelease', () => {
  const assetName = 'pican-darwin-arm64';
  const tmpDir = () => `${process.cwd()}/.tmp-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sumsFor = (hash: string, asset: string) => `${hash}  ${asset}\n`;

  function fakePi(opts: { sums: string | null }) {
    return {
      exec: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.some((a) => a.endsWith('sha256sums.txt'))) {
          if (opts.sums === null) throw new Error('curl: (22) The requested URL returned error: 404');
          return { stdout: opts.sums, stderr: '' };
        }
        throw new Error(`unexpected exec: ${args.join(' ')}`);
      }),
    };
  }

  it('downloads, verifies, and atomically replaces the binary', async () => {
    const dir = tmpDir();
    const binPath = join(dir, 'pican');
    mkdirSync(dir, { recursive: true });
    writeFileSync(binPath, 'old binary');
    const newBytes = 'new binary bytes';
    const want = createHash('sha256').update(newBytes).digest('hex');
    const pi = fakePi({ sums: sumsFor(want, assetName) });
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, newBytes));

    try {
      const result = await updatePicanFromRelease(pi, binPath, { assetName, download });
      expect(result).toEqual({ assetName, checksumVerified: true });
      expect(readFileSync(binPath, 'utf-8')).toBe(newBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proceeds with checksumVerified=false when sha256sums.txt is unavailable', async () => {
    const dir = tmpDir();
    const binPath = join(dir, 'pican');
    mkdirSync(dir, { recursive: true });
    writeFileSync(binPath, 'old');
    const pi = fakePi({ sums: null }); // 404 → no checksums asset
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, 'new'));

    try {
      const result = await updatePicanFromRelease(pi, binPath, { assetName, download });
      expect(result.checksumVerified).toBe(false);
      expect(readFileSync(binPath, 'utf-8')).toBe('new');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on checksum mismatch and leaves the old binary in place', async () => {
    const dir = tmpDir();
    const binPath = join(dir, 'pican');
    mkdirSync(dir, { recursive: true });
    writeFileSync(binPath, 'old');
    const pi = fakePi({ sums: sumsFor('b'.repeat(64), assetName) });
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, 'new'));

    try {
      await expect(updatePicanFromRelease(pi, binPath, { assetName, download })).rejects.toThrow(
        'sha256 mismatch',
      );
      expect(readFileSync(binPath, 'utf-8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when sha256sums.txt has no entry for the asset', async () => {
    const dir = tmpDir();
    const binPath = join(dir, 'pican');
    mkdirSync(dir, { recursive: true });
    writeFileSync(binPath, 'old');
    const pi = fakePi({ sums: sumsFor('b'.repeat(64), 'pican-linux-amd64') });
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, 'new'));

    try {
      await expect(updatePicanFromRelease(pi, binPath, { assetName, download })).rejects.toThrow(
        'no entry',
      );
      expect(readFileSync(binPath, 'utf-8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates download failures without touching the existing binary', async () => {
    const dir = tmpDir();
    const binPath = join(dir, 'pican');
    mkdirSync(dir, { recursive: true });
    writeFileSync(binPath, 'old');
    const pi = fakePi({ sums: null });
    const download = vi.fn(async () => {
      throw new Error('curl: (22) The requested URL returned error: 404');
    });

    try {
      await expect(updatePicanFromRelease(pi, binPath, { assetName, download })).rejects.toThrow(
        '404',
      );
      expect(readFileSync(binPath, 'utf-8')).toBe('old');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── withToken / readPicanToken ──────────────────────────────────────
describe('token helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__MOCK_PICAN_TOKEN__;
    delete (globalThis as any).__MOCK_PICAN_ENV_CONTENT__;
  });

  it('withToken appends token when available', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = 'my-token';

    expect(withToken('http://127.0.0.1:31415/session?id=abc')).toBe(
      'http://127.0.0.1:31415/session?id=abc&token=my-token',
    );
  });

  it('withToken adds token with ? when no existing query', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = 'my-token';

    expect(withToken('http://127.0.0.1:31415')).toBe(
      'http://127.0.0.1:31415?token=my-token',
    );
  });

  it('withToken returns URL unchanged when no token file', () => {
    // No mock set → ENOENT → no token
    (globalThis as any).__MOCK_PICAN_TOKEN__ = undefined;

    expect(withToken('http://127.0.0.1:31415/session?id=abc')).toBe(
      'http://127.0.0.1:31415/session?id=abc',
    );
  });

  it('withToken returns URL unchanged when env file has no token', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = null; // file exists but no token line

    expect(withToken('http://127.0.0.1:31415/session?id=abc')).toBe(
      'http://127.0.0.1:31415/session?id=abc',
    );
  });

  it('withToken URL-encodes the token value', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = 'tok en=val&ue';

    expect(withToken('http://127.0.0.1:31415')).toBe(
      'http://127.0.0.1:31415?token=tok%20en%3Dval%26ue',
    );
  });

  it('readPicanToken reads token from env file', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = 'secret-123';

    expect(readPicanToken()).toBe('secret-123');
  });

  it('readPicanToken returns null when file does not exist', () => {
    (globalThis as any).__MOCK_PICAN_TOKEN__ = undefined;

    expect(readPicanToken()).toBeNull();
  });

  it('readPicanToken prefers process.env over env file', () => {
    process.env['PICAN_TOKEN'] = 'from-env';
    (globalThis as any).__MOCK_PICAN_TOKEN__ = 'from-file';

    expect(readPicanToken()).toBe('from-env');

    delete process.env['PICAN_TOKEN'];
  });

  it('readPicanToken returns token from env var even when no file exists', () => {
    process.env['PICAN_TOKEN'] = 'env-only';
    (globalThis as any).__MOCK_PICAN_TOKEN__ = undefined;

    expect(readPicanToken()).toBe('env-only');

    delete process.env['PICAN_TOKEN'];
  });

  it('writePicanToken creates a private env file and directory', () => {
    const path = `${homedir()}/.config/pican/env`;

    writePicanToken('secret-123');

    expect(mkdirSync).toHaveBeenCalledWith(dirname(path), { recursive: true });
    expect(chmodSync).toHaveBeenCalledWith(dirname(path), 0o700);
    expect(writeFileSync).toHaveBeenCalledWith(path, 'PICAN_TOKEN=secret-123\n', {
      mode: 0o600,
    });
    expect(chmodSync).toHaveBeenCalledWith(path, 0o600);
  });
});
