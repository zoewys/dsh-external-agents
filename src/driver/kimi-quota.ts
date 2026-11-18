import { open, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { AcpError } from '../acp/client.ts'

export class KimiQuotaError extends AcpError {
  constructor(fiveHourWindow: boolean) {
    const limit = fiveHourWindow ? '当前 5 小时用量上限' : '用量上限'
    super(`Kimi Code 已达到${limit}。等额度重置后重试，或切换模型。`, 429)
  }
}

export async function kimiQuotaError(sessionId: string, startedAt: number) {
  if (!/^session_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return
  const home = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
  try {
    // Kimi can report a provider failure only in its own log and return an ACP end_turn.
    const index = await readFile(join(home, 'session_index.jsonl'), 'utf8')
    const entryLine = index.split('\n').findLast(line => {
      if (!line.includes(sessionId)) return false
      try { return JSON.parse(line)?.sessionId === sessionId } catch { return false }
    })
    if (!entryLine) return
    const { sessionDir } = JSON.parse(entryLine)
    if (typeof sessionDir !== 'string' || basename(sessionDir) !== sessionId) return
    const root = await realpath(join(home, 'sessions'))
    const path = await realpath(join(sessionDir, 'logs', 'kimi-code.log'))
    const parts = relative(root, path).split(sep)
    if (parts.length !== 4 || parts[0] === '..' ||
      parts[1] !== sessionId || parts[2] !== 'logs' || parts[3] !== 'kimi-code.log') return
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile()) return
      const length = Math.min(stat.size, 32 * 1024)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, stat.size - length)
      const warning = buffer.toString('utf8', 0, bytesRead).split('\n').findLast(line =>
        /^\S+ WARN\s+llm request failed\s/.test(line) &&
        Date.parse(line.slice(0, 24)) >= startedAt &&
        /\berrorName=APIProviderQuotaExhaustedError\b/.test(line) &&
        /\bstatusCode=429\b/.test(line))
      if (warning) return new KimiQuotaError(/\b5-hour usage limit\b/i.test(warning))
    } finally {
      await file.close()
    }
  } catch {
    // A missing or incompatible local diagnostic leaves the ACP result unchanged.
  }
}
