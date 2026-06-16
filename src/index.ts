// Telegram bot: long-polls for messages, guards + interprets them, and acts
// (record entries / complete pending / summary / search / delete / export CSV).

import { config } from "./config.js";
import {
  getUpdates,
  sendText,
  sendDocument,
  downloadFile,
  answerCallbackQuery,
  clearButtons,
  setMyCommands,
  type TelegramMessage,
  type CallbackQuery,
} from "./telegram.js";
import { transcribe } from "./transcribe.js";
import { interpret, InterpretError } from "./extract.js";
import { guardInput, type GuardCategory } from "./guard.js";
import { localToday, localMonthStart } from "./time.js";
import { fmtAmount, fmtMoney, fmtDate } from "./format.js";
import {
  buildSummaryText,
  buildWorkbook,
  buildPdf,
  composeAnswer,
  runScheduledReports,
  checkCredit,
} from "./reports.js";
import {
  recordEntries,
  completePending,
  editLast,
  deleteLastBatch,
  deleteBatchByMessage,
  searchEntries,
  pendingEntries,
  recentDuplicate,
  isProcessed,
  markProcessed,
  getOffset,
  setOffset,
  recordFailed,
  type EntryFields,
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
  "• /pendientes — trabajos sin monto\n" +
  "• /exportar — bajar todo en Excel · /pdf — bajar todo en PDF\n\n" +
  "Esto es privado: solo vos ves tus cuentas. Mandame una nota de voz cuando quieras 🙂";

const GUARD_REPLIES: Record<GuardCategory, string> = {
  bookkeeping: "",
  offtopic:
    "Solo te puedo ayudar con tus cuentas 🧾. Contame un gasto o ingreso, o pedime un resumen.",
  jailbreak: "Soy solo tu asistente de cuentas 🙂. Contame qué querés anotar.",
  abusive: "Mejor sigamos con las cuentas 🙂.",
};

// --- formatting helpers ---------------------------------------------------

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
    } else if (lower.startsWith("/pdf")) {
      await handleExport(chatId, "pdf");
    } else if (lower.startsWith("/export") || lower.startsWith("/exportar")) {
      await handleExport(chatId, "excel");
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
        await sendText(chatId, "Eso ya lo había anotado hace un momento 👍 (no lo dupliqué).");
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
      // Undo button tied to THIS message's batch (so it works even after later entries).
      await sendText(chatId, `${header}\n\n${blocks}${footer}`, [
        { text: "↩️ Deshacer", callback_data: `undo:${messageId}` },
      ]);
      break;
    }
    case "edit_last": {
      const updated = editLast(String(chatId), action.changes);
      if (!updated) {
        await sendText(chatId, "No hay ninguna anotación reciente para corregir.");
      } else {
        await sendText(chatId, `✏️ Corregí la última anotación:\n\n${renderEntry(updated)}`);
      }
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
      await handleSearch(chatId, action, transcript);
      break;
    case "delete_last":
      await handleDeleteLast(chatId);
      break;
    case "export":
      await handleExport(chatId, action.format);
      break;
    case "help":
      await sendText(chatId, WELCOME);
      break;
    case "chat":
      await sendText(
        chatId,
        action.reply ||
          "¡Hola! 🙂 Contame qué gastaste o qué te entró y lo anoto. Por ejemplo: \"pagué 50 mil al jornalero\"."
      );
      break;
    case "none":
      await sendText(
        chatId,
        "Perdoná, no te entendí bien 🙂\n" +
          'Contame un gasto o ingreso (ej: "pagué 50 mil al jornalero"), pedime un resumen ' +
          '("¿cuánto gasté este mes?") o escribí /ayuda.'
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
  const text = buildSummaryText(String(chatId), from, to, `Resumen — ${label}`);
  if (!text) {
    await sendText(chatId, `No tengo anotaciones de ${label}.`);
    return;
  }
  await sendText(chatId, text);
}

async function handleSearch(
  chatId: number,
  filters: { text: string | null; counterparty: string | null; from: string | null; to: string | null; label: string },
  question = ""
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
  const detail = `🔎 ${filters.label} — ${results.length} resultado(s):\n\n${blocks}` +
    (totalsLines ? `\n\n${totalsLines}` : "");

  // Answer the question in words first (explaining e.g. that a gasto is from another month),
  // then show the detail below. Falls back to just the detail if the answer can't be composed.
  const answer = question ? await composeAnswer(question, results, localToday()) : null;
  await sendText(chatId, answer ? `${answer}\n\n———\n${detail}` : detail);
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

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function handleExport(chatId: number, format: "pdf" | "excel" = "excel"): Promise<void> {
  if (format === "pdf") {
    const buffer = await buildPdf(String(chatId));
    await sendDocument(chatId, `cuentas-${localToday()}.pdf`, buffer, "application/pdf");
    await sendText(chatId, "📄 Listo, te mandé tus cuentas en PDF.");
    return;
  }
  const buffer = await buildWorkbook(String(chatId));
  await sendDocument(chatId, `cuentas-${localToday()}.xlsx`, buffer, XLSX_MIME);
  await sendText(chatId, "📊 Listo, te mandé tus cuentas en Excel (hojas: Movimientos y Resumen).");
}

// Handle a tap on an inline button (currently only "↩️ Deshacer").
async function handleCallback(cq: CallbackQuery): Promise<void> {
  const chatId = cq.message?.chat.id;
  const data = cq.data ?? "";
  // Never let a callback throw out of the poll loop (would freeze the bot for everyone).
  try {
    if (chatId === undefined) {
      await answerCallbackQuery(cq.id);
      return;
    }
    if (!isAllowed(chatId)) {
      await answerCallbackQuery(cq.id, "Privado 🔒");
      return;
    }
    if (data.startsWith("undo:")) {
      const mid = Number(data.slice(5));
      const removed = deleteBatchByMessage(String(chatId), mid);
      await answerCallbackQuery(cq.id, removed.length ? "Deshecho" : "Ya no estaba");
      if (cq.message) await clearButtons(chatId, cq.message.message_id);
      if (removed.length) {
        const blocks = removed.map((e) => renderEntry(e)).join("\n\n");
        await sendText(chatId, `🗑️ Deshice:\n\n${blocks}`);
      }
      return;
    }
    await answerCallbackQuery(cq.id);
  } catch (err) {
    console.error("callback error:", err);
    await answerCallbackQuery(cq.id).catch(() => {});
  }
}

const COMMANDS = [
  { command: "resumen", description: "Resumen de este mes" },
  { command: "pendientes", description: "Trabajos sin monto" },
  { command: "exportar", description: "Bajar todo en Excel" },
  { command: "pdf", description: "Bajar todo en PDF" },
  { command: "ayuda", description: "Cómo usar el bot" },
];

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

  await setMyCommands(COMMANDS).catch((e) => console.error("setMyCommands failed:", e));

  // Scheduled reports + credit alerts: check every 30 min (and once now).
  // An in-flight guard prevents overlapping ticks (which could double-send a report).
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await runScheduledReports();
      await checkCredit();
    } catch (e) {
      console.error("scheduler error:", e);
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, 30 * 60 * 1000);
  void tick();

  let offset = getOffset();
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallback(update.callback_query);
        offset = update.update_id + 1;
        setOffset(offset); // advance only after the update is fully handled
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
