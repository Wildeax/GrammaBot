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

export function listEntries(chatId: string, limit = 20): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT id, chat_id AS chatId, direction, amount, currency,
              category, counterparty, note, occurred_on AS occurredOn,
              raw_transcript AS rawTranscript, created_at AS createdAt
       FROM ledger WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(chatId, limit);
  return rows as LedgerEntry[];
}

export default db;
