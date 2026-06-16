// Telegram bot: long-polls for messages, processes voice notes, replies.

import { config } from "./config.js";
import {
  getUpdates,
  sendText,
  downloadFile,
  type TelegramMessage,
} from "./telegram.js";
import { transcribe } from "./transcribe.js";
import { extractEntry } from "./extract.js";
import { insertEntry } from "./db.js";

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const chatId = msg.chat.id;
  try {
    const voice = msg.voice ?? msg.audio;
    if (voice) {
      await handleEntry(chatId, voice.file_id);
    } else if (msg.text) {
      await handleEntry(chatId, null, msg.text); // allow typed entries too
    } else {
      await sendText(chatId, "Mandame una nota de voz contándome qué anotar 🙂");
    }
  } catch (err) {
    console.error("message error:", err);
    await sendText(chatId, "Uy, algo salió mal procesando eso. Probá de nuevo.");
  }
}

async function handleEntry(
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

  const today = new Date().toISOString().slice(0, 10);
  const extracted = await extractEntry(transcript, today);

  insertEntry({
    chatId: String(chatId),
    rawTranscript: transcript,
    ...extracted,
  });

  const sign = extracted.direction === "income" ? "Ingreso" : "Gasto";
  await sendText(
    chatId,
    `✅ Anotado: ${sign} de ${extracted.amount} ${extracted.currency}` +
      (extracted.category ? ` (${extracted.category})` : "") +
      (extracted.counterparty ? ` — ${extracted.counterparty}` : "") +
      `\n📅 ${extracted.occurredOn}`
  );
}

async function main(): Promise<void> {
  if (!config.telegram.botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  console.log("GrammaBot is running (Telegram long polling).");

  let offset = 0;
  // Long-polling loop.
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
