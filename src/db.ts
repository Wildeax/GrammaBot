// SQLite-backed ledger storage.

import Database from "better-sqlite3";
import { config } from "./config.js";

export interface LedgerEntry {
  id?: number;
  chatId: string;
  direction: "income" | "expense";
  amount: number;
  currency: string;
  category: string | null;
  counterparty: string | null;
  note: string | null;
  occurredOn: string; // ISO date (YYYY-MM-DD)
  rawTranscript: string;
  createdAt?: string;
}

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id       TEXT    NOT NULL,
    direction     TEXT    NOT NULL CHECK (direction IN ('income','expense')),
    amount        REAL    NOT NULL,
    currency      TEXT    NOT NULL,
    category      TEXT,
    counterparty  TEXT,
    note          TEXT,
    occurred_on   TEXT    NOT NULL,
    raw_transcript TEXT   NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

export function insertEntry(entry: LedgerEntry): number {
  const stmt = db.prepare(`
    INSERT INTO ledger
      (chat_id, direction, amount, currency, category, counterparty, note, occurred_on, raw_transcript)
    VALUES
      (@chatId, @direction, @amount, @currency, @category, @counterparty, @note, @occurredOn, @rawTranscript)
  `);
  const result = stmt.run(entry);
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `id, chat_id AS chatId, direction, amount, currency,
  category, counterparty, note, occurred_on AS occurredOn,
  raw_transcript AS rawTranscript, created_at AS createdAt`;

export function listEntries(chatId: string, limit = 20): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(chatId, limit) as LedgerEntry[];
}

/** All entries on or after the given ISO date (YYYY-MM-DD), oldest first. */
export function entriesSince(chatId: string, sinceIso: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND occurred_on >= ? ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId, sinceIso) as LedgerEntry[];
}

/** Every entry for a chat, oldest first (used for CSV export). */
export function allEntries(chatId: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger WHERE chat_id = ? ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId) as LedgerEntry[];
}

/** Delete the most recent entry for a chat; returns it, or null if none. */
export function deleteLast(chatId: string): LedgerEntry | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger WHERE chat_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(chatId) as LedgerEntry | undefined;
  if (!row) return null;
  db.prepare(`DELETE FROM ledger WHERE id = ?`).run(row.id);
  return row;
}

export default db;
