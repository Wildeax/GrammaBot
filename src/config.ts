// Centralized environment configuration.

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function flag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export const config = {
  telegram: {
    botToken: optional("TELEGRAM_BOT_TOKEN", ""),
    apiBaseUrl: "https://api.telegram.org",
  },

  transcribe: {
    apiKey: optional("TRANSCRIBE_API_KEY", ""),
    baseUrl: optional("TRANSCRIBE_BASE_URL", "https://openrouter.ai/api/v1"),
    model: optional("TRANSCRIBE_MODEL", "openai/gpt-4o-mini-transcribe"),
  },

  llm: {
    apiKey: optional("LLM_API_KEY", ""),
    baseUrl: optional("LLM_BASE_URL", "https://openrouter.ai/api/v1"),
    model: optional("LLM_MODEL", "google/gemini-2.5-flash-lite"),
  },

  // Cheap, fast model used as a first-stage guard (jailbreak / off-topic / abuse).
  // Uses the same provider (baseUrl/key) as the main LLM.
  guard: {
    enabled: !flag("GUARD_DISABLED"),
    model: optional("GUARD_MODEL", "google/gemini-2.5-flash-lite"),
  },

  // Owner chat that receives ops alerts (e.g. low OpenRouter credit). Defaults to the
  // first allowed chat id if not set explicitly.
  ownerChatId: optional("OWNER_CHAT_ID", ""),
  // Alert the owner when OpenRouter remaining credit drops below this (USD).
  creditAlertUsd: Number(optional("CREDIT_ALERT_USD", "1")),
  // Hour (in the configured timezone) at which scheduled reports go out.
  reportHour: Number(optional("REPORT_HOUR", "8")),
  // Send a weekly summary too (on Mondays). Monthly close always goes out on the 1st.
  weeklySummary: !flag("WEEKLY_SUMMARY_OFF"),

  defaultLanguage: optional("DEFAULT_LANGUAGE", "es"),
  defaultCurrency: optional("DEFAULT_CURRENCY", "COP"),
  // Civil timezone used to compute "today" / month boundaries (the users are in Colombia).
  timezone: optional("TIMEZONE", "America/Bogota"),
  databasePath: optional("DATABASE_PATH", "./grammabot.sqlite"),
  debug: flag("DEBUG"),

  // Comma-separated Telegram chat IDs allowed to use the bot.
  allowedChatIds: optional("ALLOWED_CHAT_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Explicit opt-in to allow ANYONE. Without this, an empty allow-list denies all (fail-closed).
  allowAnyone: flag("ALLOW_ANYONE"),
};

/** The chat that should receive ops alerts (explicit OWNER_CHAT_ID, else first allowed id). */
export function ownerChat(): number | null {
  const id = config.ownerChatId || config.allowedChatIds[0];
  return id ? Number(id) : null;
}
