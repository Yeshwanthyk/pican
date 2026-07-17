PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  context TEXT,
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('low','normal','high','secret')),
  source TEXT,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);

CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY,
  event_type TEXT NOT NULL,
  table_name TEXT,
  row_id INTEGER,
  summary TEXT,
  raw_input TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schema_changes (
  id INTEGER PRIMARY KEY,
  change_type TEXT NOT NULL CHECK (change_type IN ('create_table','create_index','alter_table_add_column','other_additive')),
  object_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  sql TEXT NOT NULL,
  applied_by TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_context ON memories(context);
CREATE INDEX IF NOT EXISTS idx_memories_sensitivity ON memories(sensitivity);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
CREATE INDEX IF NOT EXISTS idx_memories_archived_updated ON memories(archived, updated_at);
CREATE INDEX IF NOT EXISTS idx_memory_events_table_row ON memory_events(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_memory_events_created_at ON memory_events(created_at);
CREATE INDEX IF NOT EXISTS idx_schema_changes_object ON schema_changes(object_name);
CREATE INDEX IF NOT EXISTS idx_schema_changes_created_at ON schema_changes(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  category,
  context,
  source,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_ai
AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category, context, source)
  VALUES (new.id, new.content, new.category, new.context, new.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_ad
AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, context, source)
  VALUES('delete', old.id, old.content, old.category, old.context, old.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_au
AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, context, source)
  VALUES('delete', old.id, old.content, old.category, old.context, old.source);
  INSERT INTO memories_fts(rowid, content, category, context, source)
  VALUES (new.id, new.content, new.category, new.context, new.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_updated_at
AFTER UPDATE ON memories
FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE memories SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;


