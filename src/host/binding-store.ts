import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentCapabilities } from '@agentclientprotocol/sdk/unstable'
import { isAgentId, type AgentId, type Command } from './profiles.ts'

export interface Binding {
  dshSessionId: string
  agentId: AgentId
  acpSessionId: string
  cwd: string
  agentCapabilities: AgentCapabilities
  command: Command
  values: Record<string, string | boolean>
  skillProtocol?: 'on-demand'
  sentThrough: string | null
  updatedAt: number
}

export function bindingStore(dir: string) {
  const filename = (id: string) => join(dir, createHash('sha256').update(id).digest('hex') + '.json')
  return {
    async get(id: string): Promise<Binding | undefined> {
      try {
        const data = JSON.parse(await readFile(filename(id), 'utf8')) as Binding
        if (data.dshSessionId !== id || !isAgentId(data.agentId) || typeof data.acpSessionId !== 'string') {
          throw new Error('外部 Agent 的会话绑定无效。')
        }
        return data
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    async save(binding: Binding) {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const dest = filename(binding.dshSessionId)
      const tmp = dest + '.' + randomUUID()
      try {
        await writeFile(tmp, JSON.stringify(binding), { flag: 'wx', mode: 0o600 })
        await rename(tmp, dest)
      } finally {
        await rm(tmp, { force: true })
      }
    },
    delete: (id: string) => rm(filename(id), { force: true }),
  }
}
