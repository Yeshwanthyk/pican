#!/usr/bin/env python3
"""Unit tests for memory.py CLI script."""

import argparse
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Add the scripts directory to sys.path so we can import memory
sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory


class TestMakeFtsQuery(unittest.TestCase):
    """Tests for make_fts_query — a pure function, no DB needed."""

    def test_single_token(self):
        self.assertEqual(memory.make_fts_query("hello"), '"hello"')

    def test_multiple_tokens(self):
        self.assertEqual(memory.make_fts_query("hello world"), '"hello" OR "world"')

    def test_punctuation_stripped(self):
        self.assertEqual(memory.make_fts_query("hello-world!"), '"hello" OR "world"')

    def test_empty_string(self):
        self.assertEqual(memory.make_fts_query(""), '""')

    def test_unicode(self):
        self.assertEqual(memory.make_fts_query("caf\u00e9 r\u00e9sum\u00e9"), '"caf\u00e9" OR "r\u00e9sum\u00e9"')

    def test_numbers(self):
        self.assertEqual(memory.make_fts_query("test 123"), '"test" OR "123"')

    def test_only_symbols(self):
        self.assertEqual(memory.make_fts_query("!@#$%"), '""')


class TestMemoryAutoInit(unittest.TestCase):
    """Tests for first-use behavior on a brand-new DB path."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "new.sqlite")
        os.environ["PI_MEMORY_DB"] = self.db_path

    def tearDown(self):
        self.tmpdir.cleanup()
        os.environ.pop("PI_MEMORY_DB", None)

    def test_add_memory_auto_initializes_new_database(self):
        args = argparse.Namespace(
            content="First use memory",
            category="general",
            context=None,
            cwd="/test/pi-web",
            project="pi-web",
            session_id=None,
            session_name=None,
            importance=3,
            sensitivity="normal",
            source="user request",
            confidence=1.0,
        )
        with patch("sys.stdout", io.StringIO()):
            memory.add_memory(args)

        search_args = argparse.Namespace(query="First", project="pi-web", limit=20)
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            memory.search(search_args)
        self.assertIn("First use memory", buf.getvalue())


class TestMemoryDB(unittest.TestCase):
    """Integration tests that exercise the full add → search pipeline on a temp DB."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmpdir.name) / "test.sqlite")
        os.environ["PI_MEMORY_DB"] = self.db_path
        # Suppress CLI output noise during setup/teardown
        self._stdout_patcher = patch("sys.stdout", io.StringIO())
        self._stdout_patcher.start()
        memory.init_db(None)

    def tearDown(self):
        self._stdout_patcher.stop()
        self.tmpdir.cleanup()
        os.environ.pop("PI_MEMORY_DB", None)

    # --- helpers ---

    def _add(self, content, **kwargs):
        args = argparse.Namespace(
            content=content,
            category=kwargs.get("category", "general"),
            context=kwargs.get("context", None),
            cwd=kwargs.get("cwd", None),
            project=kwargs.get("project", None),
            session_id=kwargs.get("session_id", None),
            session_name=kwargs.get("session_name", None),
            importance=kwargs.get("importance", 3),
            sensitivity=kwargs.get("sensitivity", "normal"),
            source=kwargs.get("source", "user request"),
            confidence=kwargs.get("confidence", 1.0),
        )
        memory.add_memory(args)

    def _search(self, query, project=None, limit=20):
        args = argparse.Namespace(query=query, project=project, limit=limit)
        buf = io.StringIO()
        with patch("sys.stdout", buf):
            memory.search(args)
        return buf.getvalue()

    # --- tests ---

    def test_add_and_search_basic(self):
        self._add("Test memory one", category="test", importance=4)
        self._add("Test memory two", category="test", importance=5)
        output = self._search("Test")
        self.assertIn("Test memory one", output)
        self.assertIn("Test memory two", output)

    def test_search_empty_database(self):
        output = self._search("nonexistent")
        self.assertEqual(output.strip(), "")

    def test_search_by_project(self):
        self._add("pi-web feature", project="pi-web", cwd="/Users/test/pi-web")
        self._add("other project idea", project="other-project", cwd="/other")

        output = self._search("", project="pi-web")
        self.assertIn("pi-web feature", output)
        self.assertNotIn("other project idea", output)

    def test_search_fallback_with_project_filter(self):
        """Regression: search with --project when FTS returns empty results."""
        self._add("A feature idea", category="idea", project="pi-web", cwd="/Users/test/pi-web")
        output = self._search("", project="pi-web")
        self.assertIn("A feature idea", output)

    def test_search_no_alias_bug_regression(self):
        """Exact scenario that was broken before fixing the m alias in fallback query."""
        self._add("pi-web roadmap item", category="plan", project="pi-web", cwd="/test/pi-web")
        output = self._search("", project="pi-web")
        self.assertIn("pi-web roadmap item", output)

    def test_project_filter_ignores_legacy_plain_text_context(self):
        """Regression: --project should not crash on pre-JSON context values."""
        with memory.conn() as c:
            c.execute(
                "INSERT INTO memories (content, category, context) VALUES (?, ?, ?)",
                ("legacy plain context", "general", "not-json"),
            )
        self._add("legacy json context", project="pi-web", cwd="/test/pi-web")

        output = self._search("legacy", project="pi-web")
        self.assertIn("legacy json context", output)
        self.assertNotIn("legacy plain context", output)

    def test_context_json_stored(self):
        self._add("Memory with context", context="extra note", project="test-proj", cwd="/test/proj")
        output = self._search("Memory with context")
        self.assertIn("Memory with context", output)

    def test_session_context_stored(self):
        self._add(
            "Session-linked memory",
            session_id="abc12345",
            session_name="Refactor auth",
            project="pi-web",
            cwd="/test/pi-web",
        )
        output = self._search("", project="pi-web")
        self.assertIn("Session-linked memory", output)

    def test_search_partial_word(self):
        self._add("Wonderland exploration", category="idea")
        output = self._search("wonder")  # LIKE matches partial
        self.assertIn("Wonderland exploration", output)

    def test_search_by_category(self):
        self._add("A bug report", category="bug")
        self._add("A feature request", category="feature")
        output = self._search("bug")
        self.assertIn("A bug report", output)

    def test_search_no_match(self):
        self._add("something")
        output = self._search("nope")
        self.assertEqual(output.strip(), "")


if __name__ == "__main__":
    unittest.main()
