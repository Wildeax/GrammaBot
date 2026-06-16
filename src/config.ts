// Centralized environment configuration.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),

  whatsapp: {
    verifyToken: optional("WHATSAPP_VERIFY_TOKEN", "dev-verify-token"),
    accessToken: optional("WHATSAPP_ACCESS_TOKEN", ""),
    phoneNumberId: optional("WHATSAPP_PHONE_NUMBER_ID", ""),
    graphBaseUrl: "https://graph.facebook.com/v21.0",
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

export { required };
