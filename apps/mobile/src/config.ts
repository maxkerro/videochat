import { z } from 'zod';

const extraSchema = z.object({
  variant: z.enum(['development', 'staging', 'production']),
  apiUrl: z.url(),
  realtimeUrl: z.string().regex(/^wss?:\/\//, 'must be a ws:// or wss:// URL'),
});

export type AppConfig = z.infer<typeof extraSchema>;

/** Validates the `extra` block that app.config.ts bakes into the build, so a mis-set variant or
 *  URL fails at startup with a clear message instead of as a confusing network error later. */
export function parseConfig(extra: unknown): AppConfig {
  const result = extraSchema.safeParse(extra);
  if (!result.success) {
    throw new Error(`Invalid app config: ${z.prettifyError(result.error)}`);
  }
  // No trailing slash, so paths ("/auth/login") can be appended directly.
  return { ...result.data, apiUrl: result.data.apiUrl.replace(/\/+$/, '') };
}
