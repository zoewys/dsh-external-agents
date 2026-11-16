import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  injectDshSkills: z.boolean().default(true).volatile(),
  injectDshMcp: z.boolean().default(true).volatile(),
  codexTransport: z.union(['native','https']).default('native').volatile(),
  commandOverrides: z.any().default({}),
})
