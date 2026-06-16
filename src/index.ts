// Telegram bot: long-polls for messages, interprets them, and acts
// (record entry / show summary / delete last / export CSV).

import { config } from "./config.js";
import {
  getUpdates,
  sendText,
  sendDocument,
  downloadFile,
  type TelegramMessage,
} from "./telegram.js";
import { transcribe } from "./transcribe.js";
import { interpret, type Period } from "./extract.js";
import {
  insertEntry,
  deleteLast,
  entriesSince,
  allEntries,
  type LedgerEntry,
} from "./db.js";

const WELCOME =
  "¡Hola! Soy tu asistente de cuentas 🧾\n\n" +
  "Contame por audio o por texto lo que gastaste o te entró, y yo lo anoto.\n\n" +
  "Por ejemplo:\n" +
  '• "Gasté 5 lucas de gas hoy"\n' +
  '• "Me entraron 20 mil de doña Marta"\n\n' +
  "También podés decirme:\n" +
  '• "¿Cuánto gasté este mes?" — para un resumen\n' +
  '• "Borrá lo último" — si te equivocaste\n' +
  "• /exportar — para bajar todo en un archivo de Excel\n\n" +
  "Mandame una nota de voz cuando quieras 🙂";

const HELP = WELCOME;

// --- money + date helpers -------------------------------------------------

function fmtMoney(amount: number, currency: string): string {
  return `$${Math.round(amount).toLocaleString("es-CO")} ${currency}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sinceDate(period: Period): string {
  const now = new Date();
  switch (period) {
    case "today":
      return today();
    case "week": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return d.toISOString().slice(0, 10);
    }
    case "month":
      return `${now.toISOString().slice(0, 7)}-01`;
    case "all":
      return "0000-01-01";
  }
}

const PERIOD_LABEL: Record<Period, string> = {
  today: "hoy",
  week: "esta semana",
  month: "este mes",
  all: "en total",
};

// --- handlers -------------------------------------------------------------

function isAllowed(chatId: number): boolean {
  return (
    config.allowedChatIds.length === 0 ||
    config.allowedChatIds.includes(String(chatId))
  );
}

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() ?? "";
  console.log(`message from chat ${chatId}: ${msg.voice ? "[voice]" : text}`);

  try {
    // Always available, even when locked, so a user can report their ID.
    if (text.toLowerCase().startsWith("/miid")) {
      await sendText(chatId, `Tu ID de chat es: ${chatId}`);
      return;
    }

    if (!isAllowed(chatId)) {
      await sendText(chatId, "Este asistente es privado 🔒");
      return;
    }

    const lower = text.toLowerCase();
    if (lower.startsWith("/start") || lower.startsWith("/help") || lower.startsWith("/ayuda")) {
      await sendText(chatId, HELP);
    } else if (lower.startsWith("/export") || lower.startsWith("/exportar")) {
      await handleExport(chatId);
    } else if (lower.startsWith("/resumen")) {
      await handleSummary(chatId, "month");
    } else if (msg.voice ?? msg.audio) {
      await handleTranscribed(chatId, (msg.voice ?? msg.audio)!.file_id);
    } else if (text) {
      await handleTranscribed(chatId, null, text);
    } else {
      await sendText(chatId, "Mandame una nota de voz contándome qué anotar 🙂");
    }
  } catch (err) {
    console.error("message error:", err);
    await sendText(chatId, "Uy, algo salió mal procesando eso. Probá de nuevo.");
  }
}

async function handleTranscribed(
  chatId: number,
  fileId: string | null,
  typedText?: string
): Promise<void> {
  let transcript: string;
  if (fileId) {
    const { buffer, mimeType } = await downloadFile(fileId);
    transcript = await transcribe(buffer, mimeType);
  } else {
    transcript = typedText ?? "";
  }
  if (!transcript) return;

  const action = await interpret(transcript, today());

  switch (action.intent) {
    case "entry": {
      const e = action.entry;
      insertEntry({ chatId: String(chatId), rawTranscript: transcript, ...e });
      const sign = e.direction === "income" ? "Ingreso" : "Gasto";
      await sendText(
        chatId,
        `✅ Anotado: ${sign} de ${fmtMoney(e.amount, e.currency)}` +
          (e.category ? ` (${e.category})` : "") +
          (e.counterparty ? ` — ${e.counterparty}` : "") +
          `\n📅 ${e.occurredOn}`
      );
      break;
    }
    case "summary":
      await handleSummary(chatId, action.period);
      break;
    case "delete_last":
      await handleDeleteLast(chatId);
      break;
    case "none":
      await sendText(
        chatId,
        "No encontré un gasto o ingreso en eso 🤔\n" +
          'Probá con algo como "gasté 5 lucas de gas" o "me entraron 20 mil de Marta".'
      );
      break;
  }
}

async function handleSummary(chatId: number, period: Period): Promise<void> {
  const entries = entriesSince(String(chatId), sinceDate(period));
  if (entries.length === 0) {
    await sendText(chatId, `No tengo anotaciones ${PERIOD_LABEL[period]} todavía.`);
    return;
  }

  const currency = entries[0].currency || config.defaultCurrency;
  let income = 0;
  let expense = 0;
  const byCategory = new Map<string, number>();
  for (const e of entries) {
    if (e.direction === "income") income += e.amount;
    else {
      expense += e.amount;
      const cat = e.category || "otros";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + e.amount);
    }
  }

  const topCategories = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, amt]) => `   • ${cat}: ${fmtMoney(amt, currency)}`)
    .join("\n");

  await sendText(
    chatId,
    `📊 Resumen ${PERIOD_LABEL[period]} (${entries.length} anotaciones)\n\n` +
      `🟢 Ingresos: ${fmtMoney(income, currency)}\n` +
      `🔴 Gastos: ${fmtMoney(expense, currency)}\n` +
      `⚖️ Balance: ${fmtMoney(income - expense, currency)}` +
      (topCategories ? `\n\nGastos por categoría:\n${topCategories}` : "")
  );
}

async function handleDeleteLast(chatId: number): Promise<void> {
  const removed = deleteLast(String(chatId));
  if (!removed) {
    await sendText(chatId, "No hay nada para borrar.");
    return;
  }
  const sign = removed.direction === "income" ? "Ingreso" : "Gasto";
  await sendText(
    chatId,
    `🗑️ Borré la última anotación: ${sign} de ${fmtMoney(removed.amount, removed.currency)}` +
      (removed.category ? ` (${removed.category})` : "")
  );
}

function csvField(value: string | number | null): string {
  const s = value === null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

async function handleExport(chatId: number): Promise<void> {
  const entries = allEntries(String(chatId));
  if (entries.length === 0) {
    await sendText(chatId, "No hay anotaciones para exportar todavía.");
    return;
  }
  const header = "fecha,tipo,monto,moneda,categoria,quien,nota";
  const rows = entries.map((e: LedgerEntry) =>
    [
      csvField(e.occurredOn),
      csvField(e.direction === "income" ? "ingreso" : "gasto"),
      csvField(e.amount),
      csvField(e.currency),
      csvField(e.category),
      csvField(e.counterparty),
      csvField(e.note),
    ].join(",")
  );
  const csv = "﻿" + [header, ...rows].join("\n"); // BOM so Excel reads UTF-8
  await sendDocument(chatId, `cuentas-${today()}.csv`, csv);
  await sendText(chatId, `📄 Listo, exporté ${entries.length} anotaciones.`);
}

async function main(): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  console.log("GrammaBot is running (Telegram long polling).");
  if (config.allowedChatIds.length > 0) {
    console.log(`Access restricted to chat IDs: ${config.allowedChatIds.join(", ")}`);
  }

  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
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
