-- Rover CNC · LLM Chatbot Veritabanı Şeması
-- SQLite3

CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key     TEXT    UNIQUE NOT NULL,
    machine_type    TEXT    NOT NULL DEFAULT 'mill',   -- 'mill' | 'lathe'
    project_name    TEXT    DEFAULT '',
    material        TEXT    DEFAULT 'steel',
    stock_w         REAL    DEFAULT 200,
    stock_d         REAL    DEFAULT 140,
    stock_h         REAL    DEFAULT 60,
    stock_r         REAL    DEFAULT 45,
    stock_len       REAL    DEFAULT 200,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role            TEXT    NOT NULL,  -- 'user' | 'assistant' | 'system'
    content         TEXT    NOT NULL,
    summary         TEXT    DEFAULT NULL,
    has_gcode       INTEGER DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS operations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    gcode_raw       TEXT    NOT NULL,
    description     TEXT    DEFAULT '',
    op_index        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_ops_session  ON operations(session_id);
