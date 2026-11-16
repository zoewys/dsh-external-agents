import type { AgentCapabilities, McpServer } from '@agentclientprotocol/sdk/unstable'
import { resolve } from 'node:path'

export interface McpEntry {
  enabled?: boolean
  transport?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

export function mcpPayload(entries: Record<string, McpEntry>, capabilities: AgentCapabilities['mcpCapabilities'], cwd: string) {
  const servers: McpServer[] = []
  const failed: string[] = []
  for (const [name, entry] of Object.entries(entries)) {
    if (entry.enabled === false) continue
    const transport = entry.transport === 'streamable-http' ? 'http' : entry.transport
    const frames = [...Object.values(entry.env ?? {}), ...Object.values(entry.headers ?? {}), ...entry.args ?? [], entry.command, entry.url]
    const unsafe = frames.some(text => text?.includes('${')) || Object.keys(entry.headers ?? {}).length > 0
      || Object.keys(entry.env ?? {}).length > 0
      || (entry.args ?? []).some(text => /secret|token|password|api[-_]?key|authorization/i.test(text))
    if (!unsafe && transport === 'stdio' && entry.command && (!entry.cwd || resolve(entry.cwd) === resolve(cwd))) {
      servers.push({ name, command: entry.command, args: entry.args ?? [], env: [] })
      continue
    }
    if (!unsafe && (transport === 'http' || transport === 'sse') && capabilities?.[transport] && entry.url) {
      try {
        const url = new URL(entry.url)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) {
          servers.push({ name, type: transport, url: url.toString(), headers: [] })
          continue
        }
      } catch { /* malformed endpoints are reported below */ }
    }
    failed.push(name)
  }
  return { servers, failed }
}
