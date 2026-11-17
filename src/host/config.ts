import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  injectDshSkills: z.boolean().default(true).volatile(),
  injectDshMcp: z.boolean().default(true).volatile(),
  codexTransport: z.union(['native','https']).default('native').volatile(),
  idleWarningMinutes: z.natural().min(1).max(120).default(5).volatile(),
  // Existing profiles may still have the old hard limit saved.
  turnTimeoutMinutes: z.natural().min(1).max(120).default(20).volatile(),
  commandOverrides: z.any().default({}),
})
