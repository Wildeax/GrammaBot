// Thin client for the Telegram Bot API (long polling + send + media download).

import { config } from "./config.js";

const { botToken, apiBaseUrl } = config.telegram;
const apiUrl = `${apiBaseUrl}/bot${botToken}`;
const fileUrl = `${apiBaseUrl}/file/bot${botToken}`;

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
}

interface Update {
  update_id: number;
  message?: TelegramMessage;
}

async function call<T>(method: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiUrl}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; result: T; description?: string };
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

/** Send a plain text message to a chat. */
export async function sendText(chatId: number, text: string): Promise<void> {
  await call("sendMessage", { chat_id: chatId, text });
}

/** Send an in-memory file (e.g. a CSV) to a chat as a document. */
export async function sendDocument(
  chatId: number,
  filename: string,
  content: string,
  mimeType = "text/csv"
): Promise<void> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([content], { type: mimeType }), filename);

  const res = await fetch(`${apiUrl}/sendDocument`, { method: "POST", body: form });
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`Telegram sendDocument failed: ${data.description}`);
}

/** Long-poll for new updates. Returns updates with offset already advanced by the caller. */
export async function getUpdates(offset: number, timeoutSeconds = 30): Promise<Update[]> {
  return call<Update[]>("getUpdates", {
    offset,
    timeout: timeoutSeconds,
    allowed_updates: ["message"],
  });
}

/** Download a file (e.g. a voice note) by its file_id. */
export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`${fileUrl}/${file.file_path}`);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Telegram voice notes are OGG/Opus.
  const mimeType = file.file_path.endsWith(".oga") ? "audio/ogg" : "audio/ogg";
  return { buffer, mimeType };
}
