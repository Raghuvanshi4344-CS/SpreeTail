import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hashPassword } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const dataDir = path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'app.db');

fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath);

export function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      owner_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(owner_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS group_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      source_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      created_by_user_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      applied_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(created_by_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_job_id INTEGER NOT NULL,
      row_number INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      row_hash TEXT NOT NULL,
      is_applied INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(import_job_id) REFERENCES import_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS import_anomalies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_job_id INTEGER NOT NULL,
      row_number INTEGER,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      message TEXT NOT NULL,
      policy_action TEXT NOT NULL,
      decision TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      decided_by_user_id INTEGER,
      FOREIGN KEY(import_job_id) REFERENCES import_jobs(id)
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      import_row_id INTEGER,
      transaction_type TEXT NOT NULL,
      expense_date TEXT NOT NULL,
      description TEXT NOT NULL,
      payer_user_id INTEGER NOT NULL,
      counterparty_user_id INTEGER,
      amount_minor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      fx_rate REAL NOT NULL DEFAULT 1,
      base_amount_minor INTEGER NOT NULL,
      split_type TEXT NOT NULL,
      raw_json TEXT NOT NULL DEFAULT '{}',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(group_id) REFERENCES groups(id),
      FOREIGN KEY(import_row_id) REFERENCES import_rows(id),
      FOREIGN KEY(payer_user_id) REFERENCES users(id),
      FOREIGN KEY(counterparty_user_id) REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS transaction_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      share_minor INTEGER NOT NULL,
      share_kind TEXT NOT NULL,
      raw_value TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(transaction_id) REFERENCES transactions(id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);
  seedDemoData();
}

function seedDemoData() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count > 0) return;
  const people = ['Aisha', 'Rohan', 'Priya', 'Meera', 'Dev', 'Sam'];
  const insertUser = db.prepare('INSERT INTO users (name, username, password_hash) VALUES (?, ?, ?)');
  const lookup = new Map();
  for (const person of people) {
    const info = insertUser.run(person, person.toLowerCase(), hashPassword('demo1234'));
    lookup.set(person, info.lastInsertRowid);
  }
  const groupInfo = db.prepare('INSERT INTO groups (name, currency, owner_user_id) VALUES (?, ?, ?)').run('Flatshare', 'INR', lookup.get('Aisha'));
  const groupId = groupInfo.lastInsertRowid;
  const membership = db.prepare('INSERT INTO group_memberships (group_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?)');
  membership.run(groupId, lookup.get('Aisha'), '2026-02-01', null);
  membership.run(groupId, lookup.get('Rohan'), '2026-02-01', null);
  membership.run(groupId, lookup.get('Priya'), '2026-02-01', null);
  membership.run(groupId, lookup.get('Meera'), '2026-02-01', '2026-03-31');
  membership.run(groupId, lookup.get('Sam'), '2026-04-15', null);
}
