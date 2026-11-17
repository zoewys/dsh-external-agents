import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import type { Command } from '../host/profiles.ts'

const stderrCode = /(?<=[^A-Za-z0-9_])(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|ENOSPC|EMFILE)(?=[^A-Za-z0-9_])/g
const spawnCode = /^(?:ENOENT|ENOTDIR|EACCES|EPERM|EMFILE|ENFILE|EAGAIN)$/

export function startProcess(command: Command, cwd: string, env: NodeJS.ProcessEnv, diagnostic?: (message: string) => void) {
  const grouped = process.platform !== 'win32'
  const child = spawn(command.command, command.args, { cwd, env, detached: grouped, windowsHide: true, stdio: 'pipe' })
  if (diagnostic) {
    // Only emit known error codes. Free-form CLI output can include credentials.
    const seen = new Set<string>()
    let tail = '\n'
    const inspect = (chunk: string) => {
      const text = tail + chunk
      tail = text.slice(-64)
      for (const [code] of text.matchAll(stderrCode)) {
        if (seen.has(code)) continue
        seen.add(code)
        diagnostic('CLI stderr reported ' + code + '.')
      }
    }
    child.stderr.setEncoding('utf8').on('data', inspect).once('end', () => inspect('\n'))
  } else child.stderr.resume()
  child.stdin.on('error', () => {})
  let stopping = false
  const closed = new Promise<void>(resolve => {
    child.once('exit', (code, signal) => {
      resolve()
      if (!stopping) diagnostic?.('CLI exited (' + (signal ? 'signal ' + signal : 'code ' + code) + ').')
    })
    child.once('error', (error: NodeJS.ErrnoException) => {
      resolve()
      if (!stopping) {
        const reason = error.code && spawnCode.test(error.code) ? ' (' + error.code + ')' : ''
        diagnostic?.('CLI failed to start' + reason + '.')
      }
    })
  })
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  )
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return
      // A resolving/exiting process can race creation of its group. Ask
      // Node to target the original child when the group is inaccessible.
      if (code === 'EPERM' && grouped) {
        try { child.kill(signal) } catch (fallback) {
          if (!['ESRCH','EPERM'].includes((fallback as NodeJS.ErrnoException).code ?? '')) throw fallback
        }
        return
      }
      throw error
    }
  }
  return {
    stream, closed,
    async stop() {
      stopping = true
      kill('SIGTERM')
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 800).unref())])
      // The wrapper can exit before grandchildren. Reap the process group too.
      kill('SIGKILL')
    },
  }
}
