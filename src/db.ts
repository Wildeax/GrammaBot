// SQLite-backed ledger storage.

import Database from "better-sqlite3";
import { config } from "./config.js";

export interface LedgerEntry {
  id?: number;
  chatId: string;
  direction: "income" | "expense";
  amount: number; // whole pesos; 0 when status is "pending"
  currency: string;
  concept: string | null; // rich, concise description of what it was for
  category: string | null; // short bucket, e.g. "mano de obra", "insumos"
  counterparty: string | null;
  quantity: number | null; // e.g. 3 (jornales)
  unit: string | null; // e.g. "jornal", "kg", "bulto"
  unitPrice: number | null; // price per unit
  note: string | null;
  occurredOn: string; // ISO date (YYYY-MM-DD), the user's LOCAL day
  status: "recorded" | "pending";
  rawTranscript: string;
  // Set by the dispatcher, not the model:
  authorUserId: string | null;
  authorName: string | null;
  messageId: number | null;
  createdAt?: string;
  deletedAt?: string | null;
}

/** Fields produced by interpretation (everything the model decides about one movement). */
export type EntryFields = Omit<
  LedgerEntry,
  "id" | "chatId" | "rawTranscript" | "authorUserId" | "authorName" | "messageId" | "createdAt" | "deletedAt"
>;

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
addColumn("author_user_id", "TEXT");
addColumn("author_name", "TEXT");
addColumn("message_id", "INTEGER");
addColumn("deleted_at", "TEXT");

// Index the hot path (per-user, by date). Cheap and idempotent.
db.exec(`CREATE INDEX IF NOT EXISTS idx_ledger_chat ON ledger(chat_id, occurred_on)`);

// Idempotency: remember which Telegram messages we've already fully processed.
db.exec(`
  CREATE TABLE IF NOT EXISTS processed_messages (
    chat_id    TEXT    NOT NULL,
    message_id INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, message_id)
  );
`);

// Durable key/value (e.g. the Telegram long-poll offset).
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

// Nothing is ever silently lost: messages we couldn't interpret are kept here.
db.exec(`
  CREATE TABLE IF NOT EXISTS failed_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT    NOT NULL,
    message_id INTEGER,
    transcript TEXT    NOT NULL,
    error      TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

const SELECT_COLUMNS = `id, chat_id AS chatId, direction, amount, currency,
  concept, category, counterparty, quantity, unit, unit_price AS unitPrice,
  note, occurred_on AS occurredOn, status, author_user_id AS authorUserId,
  author_name AS authorName, message_id AS messageId,
  raw_transcript AS rawTranscript, created_at AS createdAt, deleted_at AS deletedAt`;

const insertStmt = db.prepare(`
  INSERT INTO ledger
    (chat_id, direction, amount, currency, concept, category, counterparty,
     quantity, unit, unit_price, note, occurred_on, status,
     author_user_id, author_name, message_id, raw_transcript)
  VALUES
    (@chatId, @direction, @amount, @currency, @concept, @category, @counterparty,
     @quantity, @unit, @unitPrice, @note, @occurredOn, @status,
     @authorUserId, @authorName, @messageId, @rawTranscript)
`);

export function insertEntry(entry: LedgerEntry): number {
  return Number(insertStmt.run(entry).lastInsertRowid);
}

export interface EntryMeta {
  chatId: string;
  messageId: number | null;
  authorUserId: string | null;
  authorName: string | null;
  rawTranscript: string;
}

/**
 * Atomically insert a batch of entries AND mark the source message processed,
 * so a mid-batch crash is all-or-nothing and the message can never double-record.
 */
export const recordEntries = db.transaction(
  (meta: EntryMeta, entries: EntryFields[]): void => {
    for (const e of entries) {
      insertStmt.run({
        ...e,
        amount: Math.round(e.amount),
        unitPrice: e.unitPrice === null ? null : Math.round(e.unitPrice),
        chatId: meta.chatId,
        messageId: meta.messageId,
        authorUserId: meta.authorUserId,
        authorName: meta.authorName,
        rawTranscript: meta.rawTranscript,
      });
    }
    if (meta.messageId !== null) markProcessed(meta.chatId, meta.messageId);
  }
);

// --- idempotency ----------------------------------------------------------

export function isProcessed(chatId: string, messageId: number): boolean {
  return !!db
    .prepare(`SELECT 1 FROM processed_messages WHERE chat_id = ? AND message_id = ?`)
    .get(chatId, messageId);
}

export function markProcessed(chatId: string, messageId: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO processed_messages (chat_id, message_id) VALUES (?, ?)`
  ).run(chatId, messageId);
}

// --- durable offset -------------------------------------------------------

export function metaGet(key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function metaSet(key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function getOffset(): number {
  const v = metaGet("offset");
  return v ? Number(v) : 0;
}

export function setOffset(offset: number): void {
  metaSet("offset", String(offset));
}

/** Distinct chats that have at least one (non-deleted) entry — used for scheduled reports. */
export function distinctChatIds(): string[] {
  return (
    db.prepare(`SELECT DISTINCT chat_id FROM ledger WHERE deleted_at IS NULL`).all() as {
      chat_id: string;
    }[]
  ).map((r) => String(r.chat_id));
}

export function recordFailed(
  chatId: string,
  messageId: number | null,
  transcript: string,
  error: string
): void {
  db.prepare(
    `INSERT INTO failed_messages (chat_id, message_id, transcript, error) VALUES (?, ?, ?, ?)`
  ).run(chatId, messageId, transcript, error);
}

// --- queries (all scoped by chat_id and excluding soft-deleted rows) -------

export function entriesBetween(chatId: string, from: string, to: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL AND occurred_on >= ? AND occurred_on <= ?
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

export function searchEntries(
  chatId: string,
  filters: SearchFilters,
  limit = 25
): LedgerEntry[] {
  const where: string[] = ["chat_id = ?", "deleted_at IS NULL"];
  const params: unknown[] = [chatId];

  if (filters.text) {
    // Search the original words too (raw_transcript) so "jornales" finds an entry whose
    // concept is "Preparación del terreno" but whose dictation said "jornales".
    where.push(
      "(concept LIKE ? OR note LIKE ? OR counterparty LIKE ? OR category LIKE ? OR unit LIKE ? OR raw_transcript LIKE ?)"
    );
    const like = `%${filters.text}%`;
    params.push(like, like, like, like, like, like);
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
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId) as LedgerEntry[];
}

/** True if the chat has (non-deleted) entries dated outside the given [from,to] range. */
export function hasEntriesOutside(chatId: string, from: string, to: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL AND (occurred_on < ? OR occurred_on > ?) LIMIT 1`
    )
    .get(chatId, from, to);
}

/** True if an identical transcript was already recorded for this chat in the last 10 min. */
export function recentDuplicate(chatId: string, rawTranscript: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM ledger
       WHERE chat_id = ? AND raw_transcript = ? AND deleted_at IS NULL
         AND created_at >= datetime('now', '-600 seconds') LIMIT 1`
    )
    .get(chatId, rawTranscript);
}

/** Pending entries (no amount yet), oldest first — same order shown to the user. */
export function pendingEntries(chatId: string): LedgerEntry[] {
  return db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL AND status = 'pending'
       ORDER BY occurred_on ASC, id ASC`
    )
    .all(chatId) as LedgerEntry[];
}

/**
 * Soft-delete the most recent batch (all entries from the latest message) for a chat.
 * Returns the removed rows, or [] if there was nothing to delete.
 */
export function deleteLastBatch(chatId: string): LedgerEntry[] {
  const last = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    .get(chatId) as LedgerEntry | undefined;
  if (!last) return [];

  const targets =
    last.messageId !== null
      ? (db
          .prepare(
            `SELECT ${SELECT_COLUMNS} FROM ledger
             WHERE chat_id = ? AND deleted_at IS NULL AND message_id = ?
             ORDER BY id ASC`
          )
          .all(chatId, last.messageId) as LedgerEntry[])
      : [last];

  const ids = targets.map((t) => t.id);
  const mark = db.prepare(`UPDATE ledger SET deleted_at = datetime('now') WHERE id = ?`);
  const tx = db.transaction((rowIds: (number | undefined)[]) => {
    for (const id of rowIds) mark.run(id);
  });
  tx(ids);
  return targets;
}

/** Soft-delete a specific batch by its source Telegram message id (used by the Undo button). */
export function deleteBatchByMessage(chatId: string, messageId: number): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND message_id = ? AND deleted_at IS NULL ORDER BY id ASC`
    )
    .all(chatId, messageId) as LedgerEntry[];
  if (rows.length === 0) return [];
  const mark = db.prepare(`UPDATE ledger SET deleted_at = datetime('now') WHERE id = ?`);
  db.transaction((ids: (number | undefined)[]) => {
    for (const id of ids) mark.run(id);
  })(rows.map((r) => r.id));
  return rows;
}

export interface EntryEdit {
  amount?: number;
  occurredOn?: string;
  concept?: string;
  counterparty?: string;
  category?: string;
  direction?: "income" | "expense";
}

/** Apply an edit to the most recent (non-deleted) entry of a chat. Returns the updated row or null. */
export function editLast(chatId: string, edit: EntryEdit): LedgerEntry | null {
  const last = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM ledger
       WHERE chat_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
    )
    .get(chatId) as LedgerEntry | undefined;
  if (!last) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (edit.amount != null) {
    sets.push("amount = ?", "status = 'recorded'");
    params.push(Math.round(edit.amount));
  }
  if (edit.occurredOn) {
    sets.push("occurred_on = ?");
    params.push(edit.occurredOn);
  }
  if (edit.concept != null) {
    sets.push("concept = ?");
    params.push(edit.concept);
  }
  if (edit.counterparty != null) {
    sets.push("counterparty = ?");
    params.push(edit.counterparty);
  }
  if (edit.category != null) {
    sets.push("category = ?");
    params.push(edit.category);
  }
  if (edit.direction) {
    sets.push("direction = ?");
    params.push(edit.direction);
  }
  if (sets.length === 0) return last;

  db.prepare(`UPDATE ledger SET ${sets.join(", ")} WHERE id = ? AND chat_id = ?`).run(
    ...params,
    last.id,
    chatId
  );
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM ledger WHERE id = ?`).get(last.id) as LedgerEntry;
}

export interface CompleteResult {
  completed: LedgerEntry | null;
  hadPending: boolean;
}

/**
 * Fill in the amount of a pending entry.
 * Target selection: explicit 1-based index (as shown by /pendientes) → by counterparty →
 * else the most recent pending entry.
 */
export function completePending(
  chatId: string,
  amount: number,
  opts: { counterparty?: string | null; which?: number | null; unitPrice?: number | null } = {}
): CompleteResult {
  const pend = pendingEntries(chatId);
  if (pend.length === 0) return { completed: null, hadPending: false };

  let target: LedgerEntry | undefined;
  if (opts.which != null) {
    // Explicit ordinal: if it's out of range, don't guess — ask the user again.
    if (opts.which >= 1 && opts.which <= pend.length) target = pend[opts.which - 1];
    else return { completed: null, hadPending: true };
  } else if (opts.counterparty) {
    const cp = opts.counterparty.toLowerCase();
    const matches = pend.filter((p) => (p.counterparty || "").toLowerCase().includes(cp));
    target = matches[matches.length - 1]; // most recent match
  }
  if (!target) target = pend[pend.length - 1]; // most recent pending

  // Derive a per-unit price when the pending row had a quantity (e.g. "3 jornales").
  let unitPrice = opts.unitPrice ?? null;
  if (unitPrice === null && target.quantity && target.quantity > 0) {
    unitPrice = Math.round(amount / target.quantity);
  }

  db.prepare(
    `UPDATE ledger
       SET amount = ?, unit_price = COALESCE(?, unit_price), status = 'recorded'
     WHERE id = ? AND chat_id = ? AND status = 'pending' AND deleted_at IS NULL`
  ).run(Math.round(amount), unitPrice === null ? null : Math.round(unitPrice), target.id, chatId);

  const updated = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM ledger WHERE id = ?`)
    .get(target.id) as LedgerEntry;
  return { completed: updated, hadPending: true };
}

export default db;
