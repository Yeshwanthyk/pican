#!/usr/bin/env python3
"""Small CLI for the pi-web memory database."""

import argparse
import json
import os
import re
import sqlite3
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
SCHEMA = SKILL_ROOT / "data" / "schema.sql"

# Mirror pi's getAgentDir() logic: respect PI_CODING_AGENT_DIR env var, default to ~/.pi/agent
def _agent_dir():
    env_dir = os.environ.get("PI_CODING_AGENT_DIR")
    if env_dir:
        return Path(env_dir).expanduser()
    return Path.home() / ".pi" / "agent"

DB = _agent_dir() / "pi-web-memory.sqlite"


def get_db_path():
    env = os.environ.get("PI_MEMORY_DB")
    return Path(env) if env else DB


def _schema_missing(c):
    row = c.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
    ).fetchone()
    return row is None


def _init_schema(c):
    c.executescript(SCHEMA.read_text())


def conn(auto_init=True):
    db_path = get_db_path()
    if db_path != Path(":memory:"):
        db_path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(db_path))
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    if auto_init and _schema_missing(c):
        _init_schema(c)
    return c


def init_db(_args):
    with conn(auto_init=False) as c:
        _init_schema(c)
    print(f"initialized {get_db_path()}")


def add_memory(args):
    # Build context JSON from project/session info
    ctx_parts = {}
    if args.cwd:
        ctx_parts["cwd"] = args.cwd
    if args.project:
        ctx_parts["project"] = args.project
    if args.session_id:
        ctx_parts["session_id"] = args.session_id
    if args.session_name:
        ctx_parts["session_name"] = args.session_name
    if args.context:
        ctx_parts["note"] = args.context
    context_json = json.dumps(ctx_parts) if ctx_parts else None

    with conn() as c:
        cur = c.execute(
            """
            INSERT INTO memories (content, category, context, importance, sensitivity, source, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                args.content,
                args.category,
                context_json,
                args.importance,
                args.sensitivity,
                args.source,
                args.confidence,
            ),
        )
        row_id = cur.lastrowid
        c.execute(
            "INSERT INTO memory_events (event_type, table_name, row_id, summary, raw_input) VALUES (?, ?, ?, ?, ?)",
            ("create", "memories", row_id, args.content[:200], args.content),
        )
    print(f"memory #{row_id} added")


def make_fts_query(query: str) -> str:
    tokens = re.findall(r"[\w]+", query, flags=re.UNICODE)
    return " OR ".join(f'"{token}"' for token in tokens) or '""'


def search(args):
    fts_q = make_fts_query(args.query)
    like_q = f"%{args.query}%"
    project_filter = ""
    params = [args.limit]
    if args.project:
        project_filter = (
            "AND (CASE WHEN json_valid(m.context) "
            "THEN json_extract(m.context, '$.project') END) = ?"
        )
        params.insert(0, args.project)

    with conn() as c:
        try:
            params_fts = [fts_q] + params
            rows = c.execute(
                f"""
                SELECT 'memory' AS type, m.id, m.content AS title, m.category, m.sensitivity,
                       m.created_at, bm25(memories_fts) AS rank
                FROM memories_fts
                JOIN memories m ON m.id = memories_fts.rowid
                WHERE memories_fts MATCH ? AND m.archived = 0 {project_filter}
                ORDER BY rank, m.importance DESC, m.updated_at DESC
                LIMIT ?
                """,
                params_fts,
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []

        if not rows:
            params_like = [like_q, like_q, like_q] + params
            rows = c.execute(
                f"""
                SELECT 'memory' AS type, m.id, m.content AS title, m.category, m.sensitivity, m.created_at, NULL AS rank
                FROM memories m
                WHERE m.archived = 0 AND (m.content LIKE ? OR m.category LIKE ? OR IFNULL(m.context,'') LIKE ?) {project_filter}
                ORDER BY m.importance DESC, m.updated_at DESC
                LIMIT ?
                """,
                params_like,
            ).fetchall()

    for r in rows:
        print(
            f"[{r['type']} #{r['id']}] {r['title']} ({r['category']}, {r['sensitivity']}, {r['created_at']})"
        )


def apply_schema_change(args):
    sql = args.sql.strip().rstrip(";")
    normalized = " ".join(sql.lower().split())
    allowed_prefixes = (
        "create table if not exists ",
        "create index if not exists ",
        "create unique index if not exists ",
        "alter table ",
    )
    blocked_words = (
        " drop ",
        " delete ",
        " update ",
        " insert ",
        " replace ",
        " truncate ",
        " vacuum",
        " attach ",
        " detach ",
    )

    if not normalized.startswith(allowed_prefixes):
        raise SystemExit(
            "Refusing schema change: only additive CREATE TABLE/INDEX or ALTER TABLE ADD COLUMN is allowed"
        )
    if normalized.startswith("alter table ") and " add column " not in normalized:
        raise SystemExit("Refusing ALTER TABLE: only ADD COLUMN is allowed")
    padded = f" {normalized} "
    if any(word in padded for word in blocked_words):
        raise SystemExit(
            "Refusing schema change: destructive or data-mutating SQL detected"
        )

    with conn() as c:
        c.execute(sql)
        c.execute(
            "INSERT INTO schema_changes (change_type, object_name, reason, sql, applied_by) VALUES (?, ?, ?, ?, ?)",
            (args.change_type, args.object_name, args.reason, sql, args.applied_by),
        )
        c.execute(
            "INSERT INTO memory_events (event_type, table_name, summary, raw_input) VALUES (?, ?, ?, ?)",
            (
                "schema_change",
                "schema_changes",
                f"{args.change_type}: {args.object_name}",
                args.reason,
            ),
        )
    print(f"schema change applied and logged: {args.object_name}")


def list_schema_changes(args):
    with conn() as c:
        rows = c.execute(
            "SELECT id, change_type, object_name, reason, created_at FROM schema_changes ORDER BY created_at DESC LIMIT ?",
            (args.limit,),
        ).fetchall()
    for r in rows:
        print(
            f"[schema #{r['id']}] {r['created_at']} {r['change_type']} {r['object_name']} - {r['reason']}"
        )


def main():
    p = argparse.ArgumentParser(description="Manage local agent memory")
    sub = p.add_subparsers(required=True)

    s = sub.add_parser("init")
    s.set_defaults(func=init_db)

    s = sub.add_parser("add-memory")
    s.add_argument("content")
    s.add_argument("--category", default="general")
    s.add_argument("--context", help="Free-form note for the context field")
    s.add_argument("--cwd", help="Working directory this memory belongs to")
    s.add_argument("--project", help="Project name (derived from cwd basename)")
    s.add_argument("--session-id", help="Pi session ID (from session header)")
    s.add_argument("--session-name", help="Pi session display name (/name)")
    s.add_argument("--importance", type=int, default=3)
    s.add_argument(
        "--sensitivity", choices=["low", "normal", "high", "secret"], default="normal"
    )
    s.add_argument("--source", default="user request")
    s.add_argument("--confidence", type=float, default=1.0)
    s.set_defaults(func=add_memory)

    s = sub.add_parser("search")
    s.add_argument("query")
    s.add_argument("--project", help="Filter results to a specific project name")
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(func=search)

    s = sub.add_parser("schema-change")
    s.add_argument(
        "--sql",
        required=True,
        help="Additive SQL only: CREATE TABLE/INDEX IF NOT EXISTS, or ALTER TABLE ADD COLUMN",
    )
    s.add_argument("--reason", required=True)
    s.add_argument("--object-name", required=True)
    s.add_argument(
        "--change-type",
        choices=[
            "create_table",
            "create_index",
            "alter_table_add_column",
            "other_additive",
        ],
        required=True,
    )
    s.add_argument("--applied-by", default="agent")
    s.set_defaults(func=apply_schema_change)

    s = sub.add_parser("schema-changes")
    s.add_argument("--limit", type=int, default=20)
    s.set_defaults(func=list_schema_changes)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
