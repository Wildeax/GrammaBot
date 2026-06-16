// Telegram bot: long-polls for messages, guards + interprets them, and acts
// (record entries / complete pending / summary / search / delete / export CSV).

import { config } from "./config.js";
import {
  getUpdates,
  sendText,
  sendDocument,
  downloadFile,
  type TelegramMessage,
} from "./telegram.js";
import { transcribe } from "./transcribe.js";
import { interpret, InterpretError } from "./extract.js";
import { guardInput, type GuardCategory } from "./guard.js";
import { localToday, localMonthStart } from "./time.js";
import {
  recordEntries,
  completePending,
  deleteLastBatch,
  entriesBetween,
  searchEntries,
  pendingEntries,
  recentDuplicate,
  allEntries,
  isProcessed,
  markProcessed,
  getOffset,
  setOffset,
  recordFailed,
  type EntryFields,
  type LedgerEntry,
} from "./db.js";

interface Ctx {
  chatId: number;
  messageId: number;
  authorUserId: string | null;
  authorName: string | null;
}

const WELCOME =
  "¡Hola! Soy tu asistente de cuentas 🧾\n\n" +
  "Contame por audio o por texto lo que gastaste o te entró, y yo lo anoto.\n\n" +
  "Por ejemplo:\n" +
  '• "El 17 de mayo pagué 300 mil de jornales, preparación del terreno: 3 jornales a 100 mil c/u"\n' +
  '• "Hoy Danilo sembró maíz, 1 jornal de 100 mil"\n\n' +
  "También podés decirme:\n" +
  '• "¿Cuánto gasté en enero?" — resumen de cualquier mes\n' +
  '• "¿Cuánto le pagué a Danilo?" — buscar movimientos\n' +
  '• "Lo de Wilfer fueron 100 mil" — completar un pendiente\n' +
  '• "Borrá lo último" — si te equivocaste\n' +
  "• /pendientes — trabajos sin monto · /exportar — bajar todo en Excel\n\n" +
  "Esto es privado: solo vos ves tus cuentas. Mandame una nota de voz cuando quieras 🙂";

const GUARD_REPLIES: Record<GuardCategory, string> = {
  bookkeeping: "",
  offtopic:
    "Solo te puedo ayudar con tus cuentas 🧾. Contame un gasto o ingreso, o pedime un resumen.",
  jailbreak: "Soy solo tu asistente de cuentas 🙂. Contame qué querés anotar.",
  abusive: "Mejor sigamos con las cuentas 🙂.",
};

// --- formatting helpers ---------------------------------------------------

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function fmtAmount(n: number): string {
  return `$${Math.round(n).toLocaleString("es-CO")}`;
}
function fmtMoney(amount: number, currency: string): string {
  return `${fmtAmount(amount)} ${currency}`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const mi = Number(m) - 1;
  if (!y || mi < 0 || mi > 11) return iso;
  return `${Number(d)} ${MONTHS[mi]} ${y}`;
}

const UNIT_ABBR = new Set(["kg", "g", "lt", "l", "mt", "m", "cm", "ha", "cc", "ml", "qq"]);
function pluralizeUnit(unit: string, qty: number): string {
  if (qty === 1) return unit;
  if (UNIT_ABBR.has(unit.toLowerCase())) return unit; // kg, ha, … stay as-is
  return /[aeiouáéíóú]$/i.test(unit) ? `${unit}s` : `${unit}es`; // vocal→s, consonante→es
}

/** Two-line compact-but-detailed rendering of one entry. */
function renderEntry(e: EntryFields): string {
  const icon = e.direction === "income" ? "🟢" : "🔴";
  const money = e.status === "pending" ? "⏳ Pendiente" : `${icon} ${fmtMoney(e.amount, e.currency)}`;
  const detail: string[] = [];
  if (e.concept) detail.push(`📋 ${e.concept}`);
  if (e.quantity && e.unit) {
    const u = pluralizeUnit(e.unit, e.quantity);
    detail.push(`${e.quantity} ${u}${e.unitPrice ? ` × ${fmtAmount(e.unitPrice)} c/u` : ""}`);
  }
  if (e.counterparty) detail.push(`👤 ${e.counterparty}`);
  return `${fmtDate(e.occurredOn)} · ${money}\n${detail.join(" · ")}`.trim();
}

// --- access control -------------------------------------------------------

function isAllowed(chatId: number): boolean {
  if (config.allowedChatIds.length > 0) return config.allowedChatIds.includes(String(chatId));
  return config.allowAnyone; // fail-closed: empty allow-list denies unless ALLOW_ANYONE is set
}

// --- message dispatch -----------------------------------------------------

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const text = msg.text?.trim() ?? "";

  // Idempotency: never process the same Telegram message twice (redelivery / crash-replay).
  if (isProcessed(String(chatId), messageId)) return;

  if (config.debug) {
    console.log(`msg chat=${chatId} ${msg.voice ? "[voice]" : JSON.stringify(text)}`);
  } else {
    console.log(`msg chat=${chatId} ${msg.voice ? "voice" : "text"}`);
  }

  try {
    // /miid is intentionally pre-auth so a new family member can fetch their ID.
    if (text.toLowerCase().startsWith("/miid")) {
      await sendText(chatId, `Tu ID de chat es: ${chatId}`);
      return;
    }

    // Privacy: this bot is per-person; refuse group chats (where isolation would collapse).
    if (msg.chat.type && msg.chat.type !== "private") {
      await sendText(chatId, "Por privacidad, hablame en un chat privado, no en grupos 🙂");
      return;
    }

    if (!isAllowed(chatId)) {
      await sendText(chatId, "Este asistente es privado 🔒");
      return;
    }

    const ctx: Ctx = {
      chatId,
      messageId,
      authorUserId: msg.from ? String(msg.from.id) : null,
      authorName: msg.from?.first_name ?? msg.from?.username ?? null,
    };

    const lower = text.toLowerCase();
    if (lower.startsWith("/start") || lower.startsWith("/help") || lower.startsWith("/ayuda")) {
      await sendText(chatId, WELCOME);
    } else if (lower.startsWith("/export") || lower.startsWith("/exportar")) {
      await handleExport(chatId);
    } else if (lower.startsWith("/pendientes")) {
      await handlePending(chatId);
    } else if (lower.startsWith("/resumen")) {
      await handleSummary(chatId, localMonthStart(), localToday(), "este mes");
    } else if (msg.voice ?? msg.audio) {
      await handleTranscribed(ctx, (msg.voice ?? msg.audio)!.file_id);
    } else if (text) {
      await handleTranscribed(ctx, null, text);
    } else {
      await sendText(chatId, "Mandame una nota de voz contándome qué anotar 🙂");
    }
  } catch (err) {
    console.error("message error:", err);
    await sendText(chatId, "Uy, algo salió mal procesando eso. Probá de nuevo.").catch(() => {});
  } finally {
    // Mark handled so a redelivery/replay won't repeat it. (Entry inserts also mark
    // atomically inside recordEntries; this covers commands/queries/guard rejects too.)
    try {
      markProcessed(String(chatId), messageId);
    } catch {
      /* ignore */
    }
  }
}

async function handleTranscribed(
  ctx: Ctx,
  fileId: string | null,
  typedText?: string
): Promise<void> {
  const { chatId, messageId } = ctx;
  let transcript: string;
  if (fileId) {
    try {
      const { buffer, mimeType } = await downloadFile(fileId);
      transcript = await transcribe(buffer, mimeType);
    } catch (err) {
      // Transient transcription/download failure — don't lose it silently.
      recordFailed(String(chatId), messageId, "[audio no transcrito]", (err as Error).message);
      await sendText(
        chatId,
        "No pude leer tu audio en este momento 😕. Reenviámelo en un momentito, por favor."
      );
      return;
    }
  } else {
    transcript = typedText ?? "";
  }
  if (!transcript.trim()) {
    if (fileId) await sendText(chatId, "No te escuché bien 🙉. ¿Me lo repetís?");
    return;
  }
  if (config.debug) console.log(`transcript chat=${chatId}: ${transcript}`);

  // First-stage guard: reject jailbreak / off-topic / abuse cheaply before the main model.
  const verdict = await guardInput(transcript);
  if (!verdict.allow) {
    await sendText(chatId, GUARD_REPLIES[verdict.category]);
    return;
  }

  let action;
  try {
    action = await interpret(transcript, localToday());
  } catch (err) {
    if (err instanceof InterpretError) {
      recordFailed(String(chatId), messageId, transcript, err.message);
      await sendText(
        chatId,
        "No pude procesar esto ahora mismo 😕. Lo guardé para no perderlo:\n\n" +
          `"${transcript}"\n\nReenviámelo en un momentito, por favor.`
      );
      return;
    }
    throw err;
  }

  switch (action.intent) {
    case "entries": {
      // Guard against a user resending the same note after a swallowed confirmation failure.
      if (recentDuplicate(String(chatId), transcript)) {
        await sendText(chatId, "Eso ya lo había anotado hace un ratico 👍 (no lo dupliqué).");
        break;
      }
      recordEntries(
        {
          chatId: String(chatId),
          messageId,
          authorUserId: ctx.authorUserId,
          authorName: ctx.authorName,
          rawTranscript: transcript,
        },
        action.entries
      );
      const blocks = action.entries.map((e) => renderEntry(e)).join("\n\n");
      const pendingCount = action.entries.filter((e) => e.status === "pending").length;
      const header =
        action.entries.length > 1 ? `✅ Anoté ${action.entries.length} movimientos:` : "✅ Anotado:";
      const footer =
        pendingCount > 0
          ? `\n\n⏳ ${pendingCount} sin monto. Cuando sepas cuánto fue, decime "lo de … fueron …".`
          : "";
      await sendText(chatId, `${header}\n\n${blocks}${footer}`);
      break;
    }
    case "complete_pending": {
      const r = completePending(String(chatId), action.amount, {
        counterparty: action.counterparty,
        which: action.which,
      });
      if (!r.completed) {
        await sendText(
          chatId,
          r.hadPending
            ? 'No supe cuál pendiente completar. Mirá /pendientes y decime "completá el N con MONTO".'
            : "No tenés trabajos pendientes para completar 👍"
        );
      } else {
        await sendText(chatId, `✅ Completé el pendiente:\n\n${renderEntry(r.completed)}`);
      }
      break;
    }
    case "summary":
      await handleSummary(chatId, action.from, action.to, action.label);
      break;
    case "search":
      await handleSearch(chatId, action);
      break;
    case "delete_last":
      await handleDeleteLast(chatId);
      break;
    case "none":
      await sendText(
        chatId,
        "No entendí bien eso 🤔\n" +
          'Probá con algo como "pagué 100 mil a Danilo por un jornal de siembra" o\n' +
          '"¿cuánto gasté este mes?".'
      );
      break;
  }
}

async function handleSummary(
  chatId: number,
  from: string,
  to: string,
  label: string
): Promise<void> {
  const entries = entriesBetween(String(chatId), from, to);
  if (entries.length === 0) {
    await sendText(chatId, `No tengo anotaciones de ${label}.`);
    return;
  }

  // Aggregate per currency so unlike currencies are never summed together.
  interface Agg {
    income: number;
    expense: number;
    cats: Map<string, number>;
  }
  const byCurrency = new Map<string, Agg>();
  let pending = 0;
  for (const e of entries) {
    if (e.status === "pending") {
      pending++;
      continue;
    }
    const cur = e.currency || config.defaultCurrency;
    const agg = byCurrency.get(cur) ?? { income: 0, expense: 0, cats: new Map() };
    if (e.direction === "income") agg.income += e.amount;
    else {
      agg.expense += e.amount;
      const cat = e.category || "otros";
      agg.cats.set(cat, (agg.cats.get(cat) ?? 0) + e.amount);
    }
    byCurrency.set(cur, agg);
  }

  const blocks = [...byCurrency.entries()].map(([cur, a]) => {
    const top = [...a.cats.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([cat, amt]) => `   • ${cat}: ${fmtMoney(amt, cur)}`)
      .join("\n");
    return (
      `🟢 Ingresos: ${fmtMoney(a.income, cur)}\n` +
      `🔴 Gastos: ${fmtMoney(a.expense, cur)}\n` +
      `⚖️ Balance: ${fmtMoney(a.income - a.expense, cur)}` +
      (top ? `\n\nGastos por categoría:\n${top}` : "")
    );
  });

  await sendText(
    chatId,
    `📊 Resumen — ${label} (${entries.length} anotaciones)\n\n` +
      blocks.join("\n\n— — —\n\n") +
      (pending > 0 ? `\n\n⏳ ${pending} movimiento(s) sin monto (ver /pendientes)` : "")
  );
}

async function handleSearch(
  chatId: number,
  filters: { text: string | null; counterparty: string | null; from: string | null; to: string | null; label: string }
): Promise<void> {
  const results = searchEntries(String(chatId), filters);
  if (results.length === 0) {
    await sendText(chatId, `No encontré nada sobre ${filters.label}.`);
    return;
  }
  // Expense totals per currency (never mix currencies into one number).
  const totals = new Map<string, number>();
  for (const e of results) {
    if (e.status !== "pending" && e.direction === "expense") {
      const cur = e.currency || config.defaultCurrency;
      totals.set(cur, (totals.get(cur) ?? 0) + e.amount);
    }
  }
  const totalsLines = [...totals.entries()]
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => `Total gastos: ${fmtMoney(v, cur)}`)
    .join("\n");
  const blocks = results.map((e) => renderEntry(e)).join("\n\n");
  await sendText(
    chatId,
    `🔎 ${filters.label} — ${results.length} resultado(s):\n\n${blocks}` +
      (totalsLines ? `\n\n${totalsLines}` : "")
  );
}

async function handlePending(chatId: number): Promise<void> {
  const items = pendingEntries(String(chatId));
  if (items.length === 0) {
    await sendText(chatId, "No tenés trabajos pendientes de monto 👍");
    return;
  }
  const blocks = items.map((e, i) => `${i + 1}. ${renderEntry(e)}`).join("\n\n");
  await sendText(
    chatId,
    `⏳ ${items.length} sin monto:\n\n${blocks}\n\n` +
      'Para completar uno, decime el monto (ej: "lo de Wilfer fueron 100 mil" o "completá el 2 con 100 mil").'
  );
}

async function handleDeleteLast(chatId: number): Promise<void> {
  const removed = deleteLastBatch(String(chatId));
  if (removed.length === 0) {
    await sendText(chatId, "No hay nada para borrar.");
    return;
  }
  const blocks = removed.map((e) => renderEntry(e)).join("\n\n");
  const header = removed.length > 1 ? `🗑️ Borré las últimas ${removed.length} anotaciones:` : "🗑️ Borré la última anotación:";
  await sendText(chatId, `${header}\n\n${blocks}`);
}

function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function handleExport(chatId: number): Promise<void> {
  const entries = allEntries(String(chatId));
  if (entries.length === 0) {
    await sendText(chatId, "No hay anotaciones para exportar todavía.");
    return;
  }
  const header =
    "fecha,tipo,concepto,monto,moneda,cantidad,unidad,precio_unitario,quien,categoria,anotado_por,estado,nota";
  const rows = entries.map((e: LedgerEntry) =>
    [
      csvField(e.occurredOn),
      csvField(e.direction === "income" ? "ingreso" : "gasto"),
      csvField(e.concept),
      csvField(e.status === "pending" ? "" : e.amount),
      csvField(e.currency),
      csvField(e.quantity),
      csvField(e.unit),
      csvField(e.unitPrice),
      csvField(e.counterparty),
      csvField(e.category),
      csvField(e.authorName),
      csvField(e.status === "pending" ? "pendiente" : "registrado"),
      csvField(e.note),
    ].join(",")
  );
  const csv = "﻿" + [header, ...rows].join("\n"); // BOM so Excel reads UTF-8
  await sendDocument(chatId, `cuentas-${localToday()}.csv`, csv);
  await sendText(chatId, `📄 Listo, exporté ${entries.length} anotaciones.`);
}

async function main(): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  console.log(`GrammaBot running. timezone=${config.timezone} guard=${config.guard.enabled ? config.guard.model : "off"}`);
  if (config.allowedChatIds.length > 0) {
    console.log(`Access restricted to chat IDs: ${config.allowedChatIds.join(", ")}`);
  } else if (config.allowAnyone) {
    console.warn("WARNING: ALLOW_ANYONE is set — the bot is open to everyone.");
  } else {
    console.warn("WARNING: ALLOWED_CHAT_IDS is empty and ALLOW_ANYONE is not set — denying everyone (fail-closed).");
  }

  let offset = getOffset();
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        if (update.message) await handleMessage(update.message);
        offset = update.update_id + 1;
        setOffset(offset); // advance only after the message is fully handled
      }
    } catch (err) {
      console.error("polling error:", err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
