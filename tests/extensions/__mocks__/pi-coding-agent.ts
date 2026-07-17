// Minimal mock of pi-coding-agent types used by the extension tests.
export interface ExtensionAPI {
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  setSessionName: (name: string) => void;
}

export interface ExtensionCommandContext {
  sessionManager: {
    getSessionFile: () => string | null;
    getCwd: () => string;
    getEntries: () => unknown[];
  };
  ui: {
    notify: (msg: string, level: string) => void;
    setTitle: (title: string) => void;
    theme: {
      fg: (color: string, text: string) => string;
      bold: (text: string) => string;
      dim: (text: string) => string;
    };
    custom: <T>(
      factory: Function,
      opts: unknown,
    ) => Promise<void>;
  };
  hasUI: boolean;
  sendMessage: (msg: unknown) => void;
  switchSession: (file: string) => Promise<void>;
  reload: () => Promise<void>;
}

export interface ExtensionContext {
  hasUI: boolean;
  ui: {
    setTitle: (title: string) => void;
  };
  sessionManager: {
    getCwd: () => string;
  };
}

export interface ExecOptions {
  cwd?: string;
}
