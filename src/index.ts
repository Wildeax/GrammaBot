// Webhook server: receives WhatsApp messages, processes voice notes, replies.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./config.js";
import { downloadMedia, sendText } from "./whatsapp.js";
import { transcribe } from "./transcribe.js";
import { extractEntry } from "./extract.js";
import { insertEntry } from "./db.js";

const app = new Hono();

app.get("/", (c) => c.text("GrammaBot is running."));

// Webhook verification handshake (Meta calls this once when you register the URL).
app.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    return c.text(challenge ?? "");
  }
  return c.text("Forbidden", 403);
});

// Incoming messages.
app.post("/webhook", async (c) => {
  // Always ack fast; process in the background.
  const payload = await c.req.json().catch(() => null);
  if (payload) handlePayload(payload).catch((err) => console.error("handler error:", err));
  return c.text("ok");
});

async function handlePayload(payload: any): Promise<void> {
  const messages =
    payload?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

  for (const msg of messages) {
    const from: string = msg.from;
    try {
      if (msg.type === "audio") {
        await handleVoiceNote(from, msg.audio.id);
      } else if (msg.type === "text") {
        await handleVoiceNote(from, null, msg.text.body); // allow typed entries too
      } else {
        await sendText(from, "Mandame una nota de voz contándome qué anotar 🙂");
      }
    } catch (err) {
      console.error("message error:", err);
      await sendText(from, "Uy, algo salió mal procesando eso. Probá de nuevo.");
    }
  }
}

async function handleVoiceNote(
  from: string,
  mediaId: string | null,
  typedText?: string
): Promise<void> {
  let transcript: string;
  if (mediaId) {
    const { buffer, mimeType } = await downloadMedia(mediaId);
    transcript = await transcribe(buffer, mimeType);
  } else {
    transcript = typedText ?? "";
  }
  if (!transcript) return;

  const today = new Date().toISOString().slice(0, 10);
  const extracted = await extractEntry(transcript, today);

  insertEntry({
    whatsappFrom: from,
    rawTranscript: transcript,
    ...extracted,
  });

  const sign = extracted.direction === "income" ? "Ingreso" : "Gasto";
  await sendText(
    from,
    `✅ Anotado: ${sign} de ${extracted.amount} ${extracted.currency}` +
      (extracted.category ? ` (${extracted.category})` : "") +
      (extracted.counterparty ? ` — ${extracted.counterparty}` : "") +
      `\n📅 ${extracted.occurredOn}`
  );
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`GrammaBot listening on http://localhost:${info.port}`);
});
