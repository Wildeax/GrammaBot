// Speech-to-text for voice notes.
//
// Uses the OpenRouter-style transcription endpoint, which takes JSON with
// base64-encoded audio (NOT a multipart file upload). Works with any provider
// exposing /audio/transcriptions in this shape.

import { config } from "./config.js";

/** Map a MIME type to the short format string the API expects. */
function formatFromMime(mimeType: string): string {
  const sub = mimeType.split("/")[1] ?? "ogg";
  // Telegram voice notes are audio/ogg (Opus); the API expects "ogg".
  if (sub.includes("ogg") || sub.includes("oga")) return "ogg";
  if (sub.includes("mpeg") || sub.includes("mp3")) return "mp3";
  return sub;
}

/**
 * Transcribe an audio buffer to text.
 * @param audio  Raw audio bytes (e.g. an OGG/Opus voice note).
 * @param mimeType  MIME type of the audio, e.g. "audio/ogg".
 */
export async function transcribe(audio: Buffer, mimeType = "audio/ogg"): Promise<string> {
  if (!config.transcribe.apiKey) {
    throw new Error("TRANSCRIBE_API_KEY is not set");
  }

  const res = await fetch(`${config.transcribe.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.transcribe.apiKey}`,
    },
    body: JSON.stringify({
      model: config.transcribe.model,
      input_audio: {
        data: audio.toString("base64"),
        format: formatFromMime(mimeType),
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    throw new Error(`Transcription failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  const data = (await res.json().catch(() => null)) as { text?: string } | null;
  return typeof data?.text === "string" ? data.text.trim() : "";
}
