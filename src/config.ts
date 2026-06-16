// Centralized environment configuration.

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
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
    model: optional("LLM_MODEL", "google/gemini-2.5-flash"),
  },

  defaultLanguage: optional("DEFAULT_LANGUAGE", "es"),
  databasePath: optional("DATABASE_PATH", "./grammabot.sqlite"),
};
