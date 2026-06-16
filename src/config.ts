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
    baseUrl: optional("TRANSCRIBE_BASE_URL", "https://api.openai.com/v1"),
    model: optional("TRANSCRIBE_MODEL", "whisper-1"),
  },

  llm: {
    apiKey: optional("LLM_API_KEY", ""),
    baseUrl: optional("LLM_BASE_URL", "https://api.openai.com/v1"),
    model: optional("LLM_MODEL", "gpt-4o-mini"),
  },

  defaultLanguage: optional("DEFAULT_LANGUAGE", "es"),
  databasePath: optional("DATABASE_PATH", "./grammabot.sqlite"),
};
