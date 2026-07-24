# Synthetic Claude transcript fixtures

These fixtures are derived from Claude Code 2.1.215 record shapes but contain only synthetic IDs, paths, timestamps, and content.

- `transcript-unknown-malformed.jsonl` includes a known user record, an unknown future record, one malformed complete line, and a later valid assistant record.
- `transcript-incomplete-tail.jsonl` ends with an incomplete JSON object and intentionally has no final newline.
- `transcript-tools.jsonl` covers text, thinking, tool use/result translation, usage, model metadata, and a native custom title.

Wave 4 parser tests should prove that malformed or incomplete records degrade locally without hiding or deleting the session, while unknown records remain available as opaque payloads.
