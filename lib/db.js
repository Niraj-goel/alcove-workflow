// SQLite storage using Node's built-in driver (no native packages to compile).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(config.DATA_DIR, 'workflow.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  email TEXT DEFAULT '',
  department TEXT DEFAULT '',
  reporting_to TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT UNIQUE NOT NULL,
  frequency TEXT NOT NULL,
  doer TEXT NOT NULL,
  department TEXT DEFAULT '',
  reporting_to TEXT DEFAULT '',
  description TEXT NOT NULL,
  alias TEXT DEFAULT '',
  company TEXT DEFAULT '',
  cost_centre TEXT DEFAULT '',
  daily_time TEXT DEFAULT '',
  weekdays TEXT DEFAULT '',
  month_days TEXT DEFAULT '',
  year_sched TEXT DEFAULT '',
  once_date TEXT DEFAULT '',
  category TEXT DEFAULT 'Other',
  approval_required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  deactivated_at TEXT DEFAULT '',
  remarks TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  due_date TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  submitted_at TEXT DEFAULT '',
  submitted_by TEXT DEFAULT '',
  remarks TEXT DEFAULT '',
  reviewed_at TEXT DEFAULT '',
  reviewed_by TEXT DEFAULT '',
  review_note TEXT DEFAULT '',
  reject_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(task_id, due_date)
);
CREATE INDEX IF NOT EXISTS idx_inst_due ON instances(due_date);
CREATE INDEX IF NOT EXISTS idx_inst_status ON instances(status);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT DEFAULT '',
  extracted TEXT DEFAULT '{}',
  fields TEXT DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL REFERENCES instances(id),
  user TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applicability (
  company TEXT NOT NULL,
  category TEXT NOT NULL,
  applicable INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company, category)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, getSetting, setSetting, transaction };
