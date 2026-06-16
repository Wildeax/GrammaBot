// Thin client for the WhatsApp Cloud API (Meta Graph).

import { config } from "./config.js";

const { graphBaseUrl, accessToken, phoneNumberId } = config.whatsapp;

/** Send a plain text message back to a WhatsApp user. */
export async function sendText(to: string, body: string): Promise<void> {
  const res = await fetch(`${graphBaseUrl}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    throw new Error(`sendText failed: ${res.status} ${await res.text()}`);
  }
}

/** Download a media object (e.g. a voice note) by its media id. */
export async function downloadMedia(
  mediaId: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Step 1: resolve the media id to a temporary download URL.
  const metaRes = await fetch(`${graphBaseUrl}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) {
    throw new Error(`media lookup failed: ${metaRes.status} ${await metaRes.text()}`);
  }
  const meta = (await metaRes.json()) as { url: string; mime_type: string };

  // Step 2: fetch the bytes (also requires the bearer token).
  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) {
    throw new Error(`media download failed: ${fileRes.status}`);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type };
}
