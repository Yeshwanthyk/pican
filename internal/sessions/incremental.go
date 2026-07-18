package sessions

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"io"
	"os"
)

// This file implements tail-append incremental parsing for the Cache: when a
// session file's mtime has only advanced because pi appended more lines
// (the common case while a worker streams a reply), Cache.LoadAll and
// Cache.Resolve re-fold just the newly appended bytes onto the previous
// parse's running state instead of re-scanning the whole file from byte 0.
//
// Safety net: every incremental attempt first re-validates two cheap signals
// against the file as it is right now — the current size must be >= the
// size recorded last time, and a fingerprint of the first bytes must be
// unchanged. Either check failing (a shrink, or a different header) falls
// back to a full from-scratch parse, so a truncated/rewritten file is never
// misread as a plain append. Session JSONL files are otherwise append-only
// once written (renames/labels append new entries rather than mutating
// existing lines — see AGENTS.md), so this pair of checks is sufficient in
// practice; it does not defend against an external rewrite that keeps the
// same first bytes and total size but changes content in between, which pi
// itself never does.

// headerFingerprintBytes bounds how much of the file's start is hashed to
// detect a rewrite. 64 bytes reliably covers the {"type":"session",...}
// header's leading fields (type/version/id) without reading much on every
// revalidation.
const headerFingerprintBytes = 64

// headerFingerprint hashes up to headerFingerprintBytes from the current
// read position of f (typically the start of the file). Returns the hash and
// the number of bytes actually read (shorter for a file smaller than
// headerFingerprintBytes) — both must match a prior fingerprint for the
// files to be considered "the same header".
func headerFingerprint(f *os.File) (sum uint64, n int, err error) {
	buf := make([]byte, headerFingerprintBytes)
	n, err = io.ReadFull(f, buf)
	if err != nil {
		if err == io.ErrUnexpectedEOF || err == io.EOF {
			err = nil
		} else {
			return 0, 0, err
		}
	}
	h := fnv.New64a()
	h.Write(buf[:n])
	return h.Sum64(), n, nil
}

// scanAppendedLines reads complete (newline-terminated) lines from f
// starting at byte offset, invoking onLine with each trimmed non-empty line.
// It returns the byte offset just past the last complete line consumed.
//
// A trailing line with no newline yet (the writer hasn't flushed it) is left
// unconsumed: the returned offset stops before it, so the next call — once
// the line is complete — reads it whole instead of folding a half-written
// JSON value into the running state or skipping half of it.
func scanAppendedLines(f *os.File, offset int64, onLine func(line []byte)) (int64, error) {
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, err
	}
	r := bufio.NewReaderSize(f, scanInitialBufferBytes)
	consumed := offset
	var pending []byte
	for {
		chunk, err := r.ReadSlice('\n')
		pending = append(pending, chunk...)
		if len(pending) > maxScanLineBytes {
			return consumed, fmt.Errorf("session line exceeds %d bytes", maxScanLineBytes)
		}
		switch err {
		case nil:
			consumed += int64(len(pending))
			if trimmed := bytes.TrimSpace(pending); len(trimmed) > 0 {
				onLine(trimmed)
			}
			pending = pending[:0]
		case bufio.ErrBufferFull:
			// The line doesn't fit bufio's internal buffer yet; pending already
			// holds everything read so far, keep accumulating.
			continue
		case io.EOF:
			// Nothing after `pending` — if it's non-empty, it's a partial final
			// line (no trailing newline yet); leave it unconsumed.
			return consumed, nil
		default:
			return consumed, err
		}
	}
}

// parseState is the incremental-parse checkpoint cached alongside a
// SessionSummary: the byte offset already folded into the running summary,
// the file size at that point, and a header fingerprint — enough for a
// later revalidation to tell "purely appended" apart from "truncated or
// rewritten" without re-reading the whole file.
type parseState struct {
	offset        int64
	size          int64
	headerHash    uint64
	headerHashLen int
	fold          summaryFoldState
}

// canExtend reports whether cur (the file's current size/fingerprint) is
// consistent with having only grown since ps was captured.
func (ps parseState) canExtend(size int64, hash uint64, hashLen int) bool {
	return ps.offset > 0 && size >= ps.size && hash == ps.headerHash && hashLen == ps.headerHashLen
}

// parseSummaryCached is ParseSummary's incremental-aware counterpart, used by
// Cache.LoadAll. When prior is non-nil and the file only grew (same header
// fingerprint, size didn't shrink), it seeks to prior's recorded offset and
// folds only the newly appended complete lines onto a copy of prior's fold
// state — prior itself is never mutated, since a concurrent LoadAll/Resolve
// call may be reading the same cache entry. Any other case (first parse,
// shrunk file, mismatched header fingerprint) falls back to a full parse
// that still walks the file with the same offset-tracking scanner, so the
// resulting parseState is always valid input for a later incremental call.
func parseSummaryCached(path, dirName, fileName string, prior *cacheEntry) (SessionSummary, parseState, error) {
	f, err := os.Open(path)
	if err != nil {
		return SessionSummary{}, parseState{}, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return SessionSummary{}, parseState{}, err
	}
	size := info.Size()

	hash, hashLen, err := headerFingerprint(f)
	if err != nil {
		return SessionSummary{}, parseState{}, err
	}

	if prior != nil && prior.parse.canExtend(size, hash, hashLen) {
		fold := prior.parse.fold // value copy: SessionSummary + plain strings only.
		newOffset, scanErr := scanAppendedLines(f, prior.parse.offset, func(line []byte) {
			var raw summaryLine
			if json.Unmarshal(line, &raw) == nil {
				fold.foldLine(raw)
			}
		})
		if scanErr == nil {
			return fold.finalize(path, fileName), parseState{
				offset: newOffset, size: size, headerHash: hash, headerHashLen: hashLen, fold: fold,
			}, nil
		}
		// Fall through to a full reparse — treat a scan failure (e.g. a
		// pathologically long appended line) the same as a cold/mismatched
		// prior state rather than surfacing an error a from-scratch parse
		// could still recover from.
	}

	fold := newSummaryFoldState(dirName, fileName)
	newOffset, err := scanAppendedLines(f, 0, func(line []byte) {
		var raw summaryLine
		if json.Unmarshal(line, &raw) == nil {
			fold.foldLine(raw)
		}
	})
	if err != nil {
		return SessionSummary{}, parseState{}, err
	}
	return fold.finalize(path, fileName), parseState{
		offset: newOffset, size: size, headerHash: hash, headerHashLen: hashLen, fold: fold,
	}, nil
}

// fileParseState is parseState's counterpart for the full ParseFile-backed
// session cache (Cache.Resolve): same offset/size/fingerprint bookkeeping,
// folding a fileFoldState (which also carries the accumulated Entries slice
// and Header) instead of a summaryFoldState.
type fileParseState struct {
	offset        int64
	size          int64
	headerHash    uint64
	headerHashLen int
	fold          fileFoldState
}

func (ps fileParseState) canExtend(size int64, hash uint64, hashLen int) bool {
	return ps.offset > 0 && size >= ps.size && hash == ps.headerHash && hashLen == ps.headerHashLen
}

// parseFileCached is ParseFile's incremental-aware counterpart, used by
// Cache.Resolve. See parseSummaryCached for the shared incremental/fallback
// design; the only difference is the fold state also carries the full
// Entries slice and Header, so prior.parse.fold.clone() deep-copies those
// before extension (a value copy alone would still alias the cached slice's
// backing array with whatever this call appends).
func parseFileCached(path, dirName, fileName string, prior *sessionCacheEntry) (Session, fileParseState, error) {
	f, err := os.Open(path)
	if err != nil {
		return Session{}, fileParseState{}, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return Session{}, fileParseState{}, err
	}
	size := info.Size()

	hash, hashLen, err := headerFingerprint(f)
	if err != nil {
		return Session{}, fileParseState{}, err
	}

	if prior != nil && prior.parse.canExtend(size, hash, hashLen) {
		fold := prior.parse.fold.clone()
		newOffset, scanErr := scanAppendedLines(f, prior.parse.offset, func(line []byte) {
			var raw map[string]any
			if json.Unmarshal(line, &raw) == nil {
				fold.foldLine(raw)
			}
		})
		if scanErr == nil {
			return fold.finalize(path, fileName), fileParseState{
				offset: newOffset, size: size, headerHash: hash, headerHashLen: hashLen, fold: fold,
			}, nil
		}
	}

	fold := newFileFoldState(dirName, fileName)
	newOffset, err := scanAppendedLines(f, 0, func(line []byte) {
		var raw map[string]any
		if json.Unmarshal(line, &raw) == nil {
			fold.foldLine(raw)
		}
	})
	if err != nil {
		return Session{}, fileParseState{}, err
	}
	return fold.finalize(path, fileName), fileParseState{
		offset: newOffset, size: size, headerHash: hash, headerHashLen: hashLen, fold: fold,
	}, nil
}
