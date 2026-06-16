// SQLite-backed ledger storage.

import Database from "better-sqlite3";
import { config } from "./config.js";

export interface LedgerEntry {
  id?: number;
  chatId: string;
  direction: "income" | "expense";
  amount: number; // 0 when status is "pending"
  currency: string;
  concept: string | null; // rich, concise description of what it was for
  category: string | null; // short bucket, e.g. "mano de obra", "insumos"
  counterparty: string | null;
  quantity: number | null; // e.g. 3 (jornales)
  unit: string | null; // e.g. "jornal", "kg", "bulto"
  unitPrice: number | null; // price per unit
  note: string | null;
  occurredOn: string; // ISO date (YYYY-MM-DD)
  status: "recorded" | "pending";
  rawTranscript: string;
  createdAt?: string;
}

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");

// Base table (original shape).
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

// Lightweight additive migration: add newer columns if they don't exist yet.
const existingCols = new Set(
  (db.prepare(`PRAGMA table_info(ledger)`).all() as { name: string }[]).map((c) => c.name)
);
function addColumn(name: string, def: string): void {
  if (!existingCols.has(name)) db.exec(`ALTER TABLE ledger ADD COLUMN ${name} ${def}`);
}
addColumn("concept", "TEXT");
addColumn("quantity", "REAL");
addColumn("unit", "TEXT");
addColumn("unit_price", "REAL");
addColumn("status", "TEXT NOT NULL DEFAULT 'recorded'");

const SELECT_COLUMNS = `id, chat_id AS chatId, direction, amount, currency,
  concept, category, counterparty, quantity, unit, unit_price AS unitPrice,
  note, occurred_on AS occurredOn, status,
  raw_transcript AS rawTranscript, created_at AS createdAt`;

export function insertEntry(entry: LedgerEntry): number {
  const stmt = db.prepare(`
    INSERT INTO ledger
      (chat_id, direction, amount, currency, concept, category, counterparty,
       quantity, unit, unit_price, note, occurred_on, status, raw_transcript)
    VALUES
      (@chatId, @direction, @amount, @currency, @concept, @category, @counterparty,
       @quantity, @unit, @unitPrice, @note, @occurredOn, @status, @rawTranscript)
  `);
  return Number(stmt.run(entry).lastInsertRowid);
}

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

/** Entries within an inclusive date range (YYYY-MM-DD), oldest first. */
export function entriesBetween(chatId: string, from: string, to: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND occurred_on >= ? AND occurred_on <= ?
       ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId, from, to) as LedgerEntry[];
}

export interface SearchFilters {
  text: string | null;
  counterparty: string | null;
  from: string | null;
  to: string | null;
}

/** Search past entries by keyword (concept/note/counterparty), person and/or date range. */
export function searchEntries(
  chatId: string,
  filters: SearchFilters,
  limit = 25
): LedgerEntry[] {
  const where: string[] = ["chat_id = ?"];
  const params: unknown[] = [chatId];

  if (filters.text) {
    where.push("(concept LIKE ? OR note LIKE ? OR counterparty LIKE ? OR category LIKE ?)");
    const like = `%${filters.text}%`;
    params.push(like, like, like, like);
  }
  if (filters.counterparty) {
    where.push("counterparty LIKE ?");
    params.push(`%${filters.counterparty}%`);
  }
  if (filters.from) {
    where.push("occurred_on >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("occurred_on <= ?");
    params.push(filters.to);
  }

  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger WHERE ${where.join(" AND ")}
       ORDER BY occurred_on DESC, id DESC LIMIT ?`
    )
    .all(...params, limit) as LedgerEntry[];
}

/** Every entry for a chat, oldest first (used for CSV export). */
export function allEntries(chatId: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger WHERE chat_id = ? ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId) as LedgerEntry[];
}

/** Entries still waiting for an amount. */
export function pendingEntries(chatId: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND status = 'pending' ORDER BY occurred_on ASC, id ASC`
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
