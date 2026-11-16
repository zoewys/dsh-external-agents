import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import type { Command } from '../host/profiles.ts'

export function startProcess(command: Command, cwd: string, env: NodeJS.ProcessEnv) {
  const grouped = process.platform !== 'win32'
  const child = spawn(command.command, command.args, { cwd, env, detached: grouped, windowsHide: true, stdio: 'pipe' })
  // Drain stderr. Its contents are owned by the CLI and may contain credentials.
  child.stderr.resume()
  child.stdin.on('error', () => {})
  const closed = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
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
      kill('SIGTERM')
      await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 800).unref())])
      // The wrapper can exit before grandchildren. Reap the process group too.
      kill('SIGKILL')
    },
  }
}
