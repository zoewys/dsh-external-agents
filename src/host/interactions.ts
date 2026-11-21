import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  CreateElicitationRequest, CreateElicitationResponse, ElicitationContentValue, ElicitationSchema,
  RequestPermissionRequest, RequestPermissionResponse,
} from '@agentclientprotocol/sdk/unstable'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { Host } from './dsh.ts'
import { permissionChoice, posture } from './permissions.ts'
import { AcpError } from '../acp/client.ts'
import type { AgentId } from './profiles.ts'
import { isDelegatedChild } from './subagent.ts'

export function sessionPermissions(ctx: Host, agent: Agent) {
  const session = agent.session
  const { mode } = ctx.sandboxPolicy.resolve({ session })
  const policy = ctx.approval.overrideOf(session) ?? ctx.approval.config.policy ?? 'ask'
  const preset = ctx.permissionPresets.current(session)
  return { mode, policy, preset, posture: posture(mode,preset,policy) }
}

export type TurnApproval = 'deny' | 'ask' | 'allow'

export function executionPermissions(ctx: Host, agent: Agent, id: AgentId, plan: boolean) {
  const permission = sessionPermissions(ctx, agent)
  const level = plan || permission.mode === 'read-only' ? 0 : permission.posture === 'full_open' ? 2 : 1
  // Antigravity keeps requesting approval in default mode; DSH decides whether
  // to ask or allow. It has no Kimi-style yolo mode.
  const modes = id === 'codex' ? ['read-only','workspace-write','agent-full-access']
    : id === 'antigravity' ? ['plan','default','default'] : ['plan','default','yolo']
  const approval: TurnApproval = plan || (id === 'antigravity' && level === 0) ? 'deny' : permission.posture === 'full_open' ? 'allow'
    : permission.policy === 'never' || isDelegatedChild(agent) ? 'deny' : 'ask'
  return { mode:modes[level], level, approval }
}

export async function approve(ctx: Host, agent: Agent, req: RequestPermissionRequest, signal: AbortSignal,
  permission: () => TurnApproval, callId?: ToolCallId): Promise<RequestPermissionResponse> {
  const cancelled = { outcome: { outcome: 'cancelled' as const } }
  if (signal.aborted) return cancelled
  const effective = permission()
  let selected = effective === 'allow' ? permissionChoice(req.options,true) : undefined
  if (effective === 'deny' || (!selected && isDelegatedChild(agent))) {
    const rejection = permissionChoice(req.options,false)
    return rejection ? { outcome: { outcome:'selected',optionId:rejection.optionId } } : cancelled
  }
  if (!selected) {
    const allowed = req.options.some(option => option.kind === 'allow_once')
    const answer = await ctx.approval.request({ agent, signal, callId, toolName: req.toolCall.title || '外部 Agent',
      reason: allowed ? '外部 Agent 请求执行此操作。' : '外部 Agent 没有提供仅授权本次操作的选项。' })
    if (signal.aborted || answer === 'cancelled') return cancelled
    selected = permissionChoice(req.options, answer === 'allowed-once' && allowed && permission() !== 'deny')
  }
  if (!selected || signal.aborted) return cancelled
  return { outcome: { outcome: 'selected', optionId: selected.optionId } }
}

export async function elicit(ctx: Host, agent: Agent, req: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> {
  if (req.mode !== 'form' || !('requestedSchema' in req) || !req.requestedSchema) return { action:'decline' }
  const schema = req.requestedSchema as ElicitationSchema
  const fields = Object.entries(schema.properties ?? {})
  if (!fields.length || fields.length > 3) return { action:'decline' }
  const converters = new Map<string, (answers: string[]) => ElicitationContentValue>()
  const questions: AskUserQuestionItem[] = []
  for (const [id, property] of fields) {
    const field = property as {
      type: string; title?: string; description?: string; enum?: string[];
      oneOf?: {const:string;title?:string;description?:string}[];
      items?: {enum?: string[];anyOf?: {const:string;title?:string}[]};
      minLength?:number;maxLength?:number;minimum?:number;maximum?:number;
    }
    const values = field.oneOf ?? field.enum?.map(value => ({const:value,title:value}))
      ?? field.items?.anyOf ?? field.items?.enum?.map(value => ({const:value,title:value}))
      ?? (field.type === 'boolean' ? [{const:'true',title:'是'}, {const:'false',title:'否'}] : [])
    if (!['string','number','integer','boolean','array'].includes(field.type) || (field.type === 'array' && !values.length)) return { action:'decline' }
    const pairs = values.map(value => [value.title || value.const,value.const] as const)
    if (new Map(pairs).size !== pairs.length) return { action:'decline' }
    const options = pairs.map(([label]) => ({label, description:''}))
    questions.push({ id, header: field.title ?? id, question: field.description || req.message, detail: field.description ? req.message : undefined,
      options, multiSelect: field.type === 'array' })
    converters.set(id, answers => {
      const translated = answers.map(answer => {
        const value = new Map(pairs).get(answer)
        if (pairs.length && value === undefined) throw new AcpError('回答与外部 Agent 的选项不符。')
        return value ?? answer
      })
      const first = translated[0] ?? ''
      if (field.type === 'array') return translated
      if (field.type === 'boolean') return first === 'true'
      if (field.type === 'number' || field.type === 'integer') {
        const num = Number(first)
        if (!first.trim() || !Number.isFinite(num) || (field.type === 'integer' && !Number.isInteger(num))
          || num < (field.minimum ?? -Infinity) || num > (field.maximum ?? Infinity)) throw new AcpError('回答超出数值范围。')
        return num
      }
      if (first.length < (field.minLength ?? 0) || first.length > (field.maxLength ?? Infinity)) throw new AcpError('回答长度超出范围。')
      return first
    })
  }
  try {
    const reply = await ctx.userQuestions.ask({ agent, questions, signal })
    if (signal.aborted) return { action:'cancel' }
    const content: Record<string, ElicitationContentValue> = Object.create(null)
    for (const [id, convert] of converters) {
      const answer = reply.answers.find(item => item.id === id)
      if (!answer?.selected.length && answer?.custom == null) {
        if (schema.required?.includes(id)) return { action:'decline' }
        continue
      }
      content[id] = convert([...(answer.selected ?? []), ...(answer.custom == null ? [] : [answer.custom])])
    }
    return {action:'accept', content}
  } catch {
    return { action: signal.aborted ? 'cancel' : 'decline' }
  }
}
