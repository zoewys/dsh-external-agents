import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionNotification, ToolCallUpdate } from '@agentclientprotocol/sdk/unstable'
import type { AssistantMessage, ToolCallBlock, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'

type Tool = ToolCallUpdate
const names = { read: 'read', edit: 'edit', delete: 'edit', move: 'edit', execute: 'bash', search: 'search', fetch: 'web_fetch' }
const clip = (text: string, limit = 30_000) => text.length > limit ? text.slice(0, limit) + '\n[内容已截断]' : text

export function dshTools(agent: Agent, position: { turn: number; step: number }, selection: { provider:string; model:string }) {
  const calls = new Map<string, { id: ToolCallId; update: Tool; finished: boolean }>()
  const session = agent.session
  function result(call: NonNullable<ReturnType<typeof receive>>, error = false) {
    if (call.finished) return
    call.finished = true
    const texts: string[] = []
    for (const item of call.update.content ?? []) {
      if (item.type === 'content' && item.content.type === 'text') texts.push(clip(item.content.text))
      if (item.type === 'diff') {
        const before = (item.oldText ?? '').split('\n').map(line => '-' + line).join('\n')
        const after = item.newText.split('\n').map(line => '+' + line).join('\n')
        texts.push(clip('--- ' + item.path + '\n+++ ' + item.path + '\n' + before + '\n' + after))
      }
    }
    for (const item of call.update.locations ?? []) texts.push(item.path + (item.line == null ? '' : ':' + item.line))
    const isError = error || call.update.status === 'failed'
    const message: ToolResultMessage = {
      role: 'tool', id: randomUUID() as ToolResultMessage['id'],
      source: {kind: 'tool', callId: call.id}, toolCallId: call.id, isError,
      content: [{type:'text',text: clip(texts.join('\n\n') || (isError ? '外部 Agent 工具未完成。' : '外部 Agent 工具已完成。'))}],
    }
    session.append('tool/result', { ...position, message }, { surfaceOp: 'append' })
  }
  function receive(update: Tool) {
    if (update.kind === 'think') return
    let call = calls.get(update.toolCallId)
    if (!call) {
      const name = (update.kind && names[update.kind as keyof typeof names]) ?? (update.name || 'external_agent_tool')
      call = { id: ('acp-' + randomUUID()) as ToolCallId, update, finished: false }
      calls.set(update.toolCallId, call)
      const raw = update.rawInput && typeof update.rawInput === 'object' && !Array.isArray(update.rawInput) ? update.rawInput : {}
      const paths = [...(update.locations ?? []).map(item => item.path), ...(update.content ?? []).flatMap(item => item.type === 'diff' ? [item.path] : [])]
      const args = JSON.stringify({
        ...raw, title: update.title ?? update.name ?? name,
        ...(paths.length ? { paths: [...new Set(paths)], path:paths[0] } : {}),
      })
      const block: ToolCallBlock = {type:'tool-call',id:call.id,name,arguments:args}
      const message: AssistantMessage = {
        role:'assistant', id:randomUUID() as AssistantMessage['id'],
        source:{kind:'model',...selection}, content:[block],
      }
      const time = Date.now()
      // Advertise the already-external call in DSH's durable format. Never
      // return a tool-call stream chunk to AgentLoop: it would dispatch it again.
      session.append('assistant/message', { ...position, message, stream:[
        {type:'chunk',time,chunk:{type:'block-start',index:0,blockType:'tool-call'}},
        {type:'chunk',time,chunk:{type:'block-end',index:0,block}},
        {type:'chunk',time,chunk:{type:'finish',reason:{kind:'tool-calls'}}},
      ] },{surfaceOp:'append'})
      session.append('tool/call', { ...position, callId: call.id, name, arguments:args })
    } else {
      call.update = { ...call.update, ...update, content: update.content?.length ? update.content : call.update.content, locations: update.locations?.length ? update.locations : call.update.locations }
    }
    if (update.status === 'completed' || update.status === 'failed') result(call)
    return call
  }
  return {
    receive,
    get pending() { return [...calls.values()].some(call => !call.finished) },
    flush() { for (const call of calls.values()) if (!call.finished) result(call, true) },
  }
}

export function planText(update: SessionNotification['update']) {
  if (update.sessionUpdate !== 'plan') return
  return update.entries.map(entry => (entry.status === 'completed' ? '✓ ' : '• ') + entry.content).join('\n')
}
