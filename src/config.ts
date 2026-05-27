import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  GEMINI_LIVE_MODEL: z.string().default('gemini-2.5-flash-native-audio-latest'),
  GEMINI_REST_MODEL: z.string().default('gemini-2.5-flash'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  HEARTBEAT_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  MAX_RECONNECT_ATTEMPTS: z.coerce.number().int().nonnegative().default(8),
  DEGRADATION_RTT_LD_MS: z.coerce.number().int().positive().default(200),
  DEGRADATION_RTT_AUDIO_MS: z.coerce.number().int().positive().default(500),
  DEGRADATION_RTT_PHOTO_MS: z.coerce.number().int().positive().default(1500),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  CONTEXT_COMPRESS_TRIGGER_TOKENS: z.coerce.number().int().positive().default(25000),
  // Some Live models don't support these features (e.g. gemini-2.5-flash-native-audio-*).
  // Default off so the lab works on the current generally-available model.
  ENABLE_SESSION_RESUMPTION: z.coerce.boolean().default(false),
  ENABLE_CONTEXT_COMPRESSION: z.coerce.boolean().default(false),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
