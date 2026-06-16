// Thin client for the Telegram Bot API (long polling + send + media download).

import { config } from "./config.js";

const { botToken, apiBaseUrl } = config.telegram;
const apiUrl = `${apiBaseUrl}/bot${botToken}`;
const fileUrl = `${apiBaseUrl}/file/bot${botToken}`;

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type?: string };
  from?: { id: number; first_name?: string; username?: string };
  text?: string;
  voice?: { file_id: string; mime_type?: string };
  audio?: { file_id: string; mime_type?: string };
}

interface Update {
  update_id: number;
  message?: TelegramMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call a Bot API method with a timeout and bounded retries on transient errors
 * (HTTP 5xx, network failures, and 429 honoring retry_after).
 */
async function call<T>(
  method: string,
  body: unknown,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<T> {
  const { timeoutMs = 30000, retries = 3 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${apiUrl}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await res.json().catch(() => null)) as TgResponse<T> | null;

      if (data?.ok) return data.result as T;

      // Rate limited → wait the requested time and retry.
      if (data?.error_code === 429 || res.status === 429) {
        const wait = (data?.parameters?.retry_after ?? 1) * 1000;
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
      }
      // Transient server error → backoff and retry.
      if ((res.status >= 500 || !data) && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw new Error(`Telegram ${method} failed: ${res.status} ${data?.description ?? ""}`);
    } catch (err) {
      lastErr = err;
      // Network/timeout error → backoff and retry.
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Telegram ${method} failed`);
}

/** Send a plain text message to a chat (retried/timeout-guarded). */
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

  const res = await fetch(`${apiUrl}/sendDocument`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const data = (await res.json().catch(() => null)) as TgResponse<unknown> | null;
  if (!data?.ok) throw new Error(`Telegram sendDocument failed: ${data?.description ?? res.status}`);
}

/** Long-poll for new updates. Client timeout must exceed the server long-poll window. */
export async function getUpdates(offset: number, timeoutSeconds = 30): Promise<Update[]> {
  return call<Update[]>(
    "getUpdates",
    { offset, timeout: timeoutSeconds, allowed_updates: ["message"] },
    { timeoutMs: (timeoutSeconds + 15) * 1000, retries: 1 }
  );
}

/** Download a file (e.g. a voice note) by its file_id. */
export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const file = await call<{ file_path: string }>("getFile", { file_id: fileId });
  const res = await fetch(`${fileUrl}/${file.file_path}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  // Telegram voice notes are OGG/Opus.
  const mimeType = "audio/ogg";
  return { buffer, mimeType };
}
