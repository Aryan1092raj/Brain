import { z } from 'zod'

export const ConfigSchema = z.object({
  repos: z.array(z.object({
    name: z.string(),
    path: z.string(),
    remote: z.string(),
    webhookSecret: z.string(),
    languages: z.array(z.enum([
      'typescript', 'javascript', 'python',
      'rust', 'go', 'java', 'cpp', 'c',
      'ruby', 'php', 'swift', 'kotlin', 'cs'
    ])).default(['typescript', 'javascript']),
    branch: z.string().default('main'),
  })),
  port: z.number().default(3747),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  slackWebhook: z.string().url().optional(),
  discordWebhook: z.string().url().optional(),
})

export type Config = z.infer<typeof ConfigSchema>
export type RepoConfig = Config['repos'][number]