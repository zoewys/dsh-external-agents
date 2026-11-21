import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { executionPermissions } from './interactions.ts'

type Permissions = ReturnType<typeof executionPermissions>
const approvalLevel = {deny:0,ask:1,allow:2}
export const permissionPauseReason = 'external-agents/permissions-tightened'

export function lastPermissionPause(session: Agent['session'], before: number = session.seq) {
  for (let seq = before - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq as SessionSeq)
    if (event?.type === 'turn/start') return
    if (event?.type !== 'turn/end') continue
    const reason = event.data.reason
    if (reason.kind === 'aborted' && reason.reason.kind === 'hook' && reason.reason.reason === permissionPauseReason) return event.seq
    return
  }
}

export function watchPermissions(options: {
  initial: Permissions
  read(): Permissions
  widen?: (mode: string) => Promise<void>
  pause(): void
  deferred(value: boolean): void
  signal: AbortSignal
}) {
  let applied = options.initial
  let highestSentLevel = applied.level
  let scheduled = false
  let updating = false
  let stopped = false
  const active = () => !stopped && !options.signal.aborted

  function schedule() {
    if (scheduled || !active()) return
    scheduled = true
    // DSH writes preset, sandbox and approval events synchronously in one switch.
    queueMicrotask(() => {
      scheduled = false
      if (!active()) return
      const next = options.read()
      if (next.level < highestSentLevel) {
        stopped = true
        options.deferred(false)
        options.pause()
        return
      }
      if (updating) return
      if (next.mode === applied.mode && next.level === applied.level && next.approval === applied.approval) {
        applied = next
        options.deferred(false)
        return
      }
      if (!options.widen) {
        options.deferred(true)
        return
      }
      updating = true
      // A later downgrade must stop even if the widening reply has not arrived yet.
      highestSentLevel = next.level
      void options.widen(next.mode).then(() => {
        updating = false
        if (!active()) return
        applied = next
        schedule()
      }, () => {
        updating = false
        if (active()) options.deferred(true)
      })
    })
  }

  return {
    schedule,
    stop() { stopped = true },
    approval() {
      const desired = options.read().approval
      return approvalLevel[desired] < approvalLevel[applied.approval] ? desired : applied.approval
    },
  }
}
