import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmModelBadge, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionConfigOption, ContentBlock } from '@agentclientprotocol/sdk/unstable'
import { AcpConnectionLost, AcpError, safeError } from '../acp/client.ts'
import { KimiQuotaError } from '../driver/kimi-quota.ts'
import { isDelegationMessage, isUserOrRemoteTaskInput, summarize, type Message } from '../driver/context.ts'
import { ExternalAgentDriver, type Injection } from '../driver/external-agent-driver.ts'
import { dshTools, planText } from '../driver/map-updates.ts'
import { choices } from '../driver/options.ts'
import { bindingStore } from './binding-store.ts'
import type { Host, GenerateOptions, LlmAdapter, LlmResolvedModelInfo, StreamChunk } from './dsh.ts'
import { approve, elicit, executionPermissions, sessionPermissions } from './interactions.ts'
import { isAgentId, parseConfig, profiles, type AgentId } from './profiles.ts'
import type { McpEntry } from './injection.ts'
import { registerSetup } from './setup.ts'
import { childPersonaSections, delegationInstructions, isDelegatedChild } from './subagent.ts'
import { lastPermissionPause, permissionPauseReason, watchPermissions } from './permission-update.ts'

export const name = 'external-agents'
export { Config } from './config.ts'
export const inject = ['agents', 'sessions', 'llm', 'workingDirectory', 'sandboxPolicy', 'permissionPresets', 'approval', 'userQuestions', 'sessionController', 'webServer', 'connection']
const routePrefix = 'external-acp-'
const defaultModel = '@default'
const agentEntries = Object.keys(profiles) as AgentId[]
const modelBadge: LlmModelBadge = {text:{zh:'外部 Agent',en:'External Agent'},tone:'info'}

export function routeAgent(provider: string | undefined): AgentId | undefined {
  const id = provider?.startsWith(routePrefix) ? provider.slice(routePrefix.length) : undefined
  return isAgentId(id) ? id : undefined
}

function nativeSession(agent: Agent | undefined): agent is Agent {
  return !!agent && (isDelegatedChild(agent)
    || (agent.session.header.origin !== 'subagent' && !agent.session.header.delegationDepth))
}

function isExplicitInput(message: Message) {
  if (message.role !== 'user') return false
  const source = message.source?.kind
  if (source === 'schedule') {
    // DSH uses the same source for deliveries and schedule-change notices.
    return message.content.some(block => block.type === 'text'
      && /^\[SCHEDULE REMINDER(?: BATCH)?\]\n/.test(block.text ?? ''))
  }
  return isUserOrRemoteTaskInput(message) || source === 'skill-invocation'
}

interface UiState {
  plan: boolean
  planText?: string
  commands?: string
  usage?: string
  pending?: boolean
  idleWarning?: string
  notice?: string
  error?: string
  permissionWatch?: ReturnType<typeof watchPermissions>
  permissionDeferred?: boolean
}

function nativeAdapter(ctx: Host, driver: ExternalAgentDriver, states: Map<string, UiState>,
  personas: WeakMap<Agent, readonly string[]>): LlmAdapter {
  const display = (provider: string) => profiles[routeAgent(provider)!].name
  const cwd = async () => {
    const agent = ctx.agents.currentInitiator()
    return agent ? ctx.workingDirectory.ensure(agent) : process.cwd()
  }
  const resolved = (provider: string, model: string, options: SessionConfigOption[] = []): LlmResolvedModelInfo => {
    const thing = options.find(option => option.category === 'thought_level')
    const reasoning = thing ? choices(thing).map(choice => ({
      id:choice.value as ReasoningEffortId,name:choice.name,description:choice.description ?? undefined,
    })) : []
    // DSH evaluates switch pressure on its whole transcript. Only the
    // bounded handoff travels over ACP; actual context is managed externally.
    return { provider, id:model, name:model === defaultModel ? display(provider) : model,
      context:{contextWindow:4_000_000}, inputModalities:['text','image'],
      systemPromptUpdate:'in-history', toolUpdate:'in-history',
      ...(reasoning.length ? {reasoning:{efforts:reasoning}} : {}) }
  }
  const describe = async (provider: string, model: string) => {
    const agent = ctx.agents.currentInitiator()
    const kind = routeAgent(provider)!
    const live = agent ? driver.current(agent.id) : undefined
    const options = live?.binding.agentId === kind && !live.client.closed ? live.options : (await driver.probe(kind,await cwd())).options
    return resolved(provider,model,options)
  }
  async function* stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
    const id = routeAgent(request.provider)
    const agent = ctx.agents.currentInitiator()
    if (!id || !nativeSession(agent) || request.purpose !== undefined || agent.id !== request.sessionId
      || ctx.agents.get(agent.id) !== agent || agent.model.current()?.provider !== request.provider) {
      throw new AcpError('外部 Agent 只接受当前 DSH 会话的用户回合。')
    }
    const delegated = isDelegatedChild(agent)
    const accepts = (message: Message) => id === 'antigravity'
      ? (message.role === 'user' && ['user','skill-invocation'].includes(message.source?.kind ?? ''))
        || (delegated && isDelegationMessage(message))
      : isExplicitInput(message) || (delegated && isDelegationMessage(message))
    const streamLifetime = new AbortController()
    const signal = request.signal ? AbortSignal.any([request.signal,streamLifetime.signal]) : streamLifetime.signal
    const idleMinutes = driver.config.idleWarningMinutes
    const {openTurnStartSeq,lastStepBoundary} = ctx.agents.turnBoundaryOf(agent.session)
    if (openTurnStartSeq === null || lastStepBoundary?.kind !== 'start') {
      throw new AcpError('外部 Agent 只能在 DSH 原生回合中运行。')
    }
    const stepSeq = lastStepBoundary.seq
    const stepStart = agent.session.eventAt(stepSeq)
    if (stepStart?.type !== 'step/start') throw new AcpError('无法识别 DSH 回合编号。')
    const position = {turn: stepStart.data.turn, step: stepStart.data.step}
    const nativePlan = planMode(ctx,agent)
    const state = states.get(agent.id) ?? {plan:false}
    states.set(agent.id,state)
    state.notice = undefined
    state.error = undefined
    state.planText = undefined
    state.idleWarning = undefined
    let delta = ''
    let receivedReply = false
    const queue: string[] = []
    const tools = dshTools(agent, position,{provider:request.provider,model:request.model})
    let wake: () => void = () => {}
    let completed = false
    let failed: unknown
    let usage: StreamChunk | undefined
    let finish: StreamChunk = { type:'finish', reason:{kind:'stop'} }
    const text = (piece: string) => { if (piece) { queue.push(piece); wake() } }
    const notice = (value: string) => {
      state.notice = value
      text('> ' + value + '\n\n')
    }
    let collected = false
    let permissionWatch: UiState['permissionWatch']
    let idleTimer: NodeJS.Timeout | undefined
    const activity = () => {
      clearTimeout(idleTimer)
      state.idleWarning = undefined
      if (signal.aborted) return
      idleTimer = setTimeout(() => {
        if (signal.aborted) return
        const waiting = state.pending ? '等待审批或回答' : tools.pending ? '等待外部工具返回' : '等待外部 Agent 回复'
        state.idleWarning = idleMinutes + ' 分钟未收到新进展，' + waiting + '。'
      }, idleMinutes * 60_000).unref()
    }
    const run = (async () => {
      const session = agent.session
      const msgs = request.messages
      // Only these durable, current-step events can introduce new ACP input.
      const currentIds = new Set<string>()
      for (let n = session.seq - 1; n > stepSeq; n--) {
        const event = session.eventAt(n as typeof stepSeq)
        if (event?.type === 'user/message' && accepts(event.data)) currentIds.add(event.data.id)
      }
      const input = msgs.filter(message => message.id && currentIds.has(message.id) && accepts(message))
      if (!input.length) {
        if (id === 'antigravity') throw new AcpError('Antigravity 当前仅支持用户直接发送的消息和手动调用技能。')
        return
      }
      state.permissionDeferred = false
      const firstCurrent = msgs.findIndex(message => message.id && currentIds.has(message.id))
      let nativeIntervened = false
      for (let n = openTurnStartSeq - 1; n > 0; n--) {
        const event = session.eventAt(n as typeof stepSeq)
        if (event?.type === 'request/header') {
          nativeIntervened = !routeAgent(event.data.header.config.provider)
          break
        }
      }
      const planning = nativePlan?.get(agent).active ?? state.plan
      const readPermissions = () => executionPermissions(ctx,agent,id,planning)
      let mode = readPermissions().mode
      const directory = await ctx.workingDirectory.ensure(agent,signal)
      const live = await driver.prepare({
        id: agent.id, agent: id, cwd: directory,
        securityMode: mode, model: request.model,
        effort: request.reasoningEffort, signal,
        summary: summarize(msgs.slice(0, firstCurrent), delegated), nativeIntervened, notice,
        permissionContinuation: lastPermissionPause(session,openTurnStartSeq) !== undefined,
        injection: config => collectInjection(ctx,agent,config,directory),
      })
      const content: ContentBlock[] = []
      for (const message of input) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) content.push({type:'text',text:block.text})
          if (block.type === 'image') {
            if (!live.init.agentCapabilities?.promptCapabilities?.image || block.offloaded) {
              content.push({ type:'text', text:'[此 ACP 会话无法接收该图片]' })
              continue
            }
            const attachment = await ctx.sessionController.attachment({ sessionId: agent.id, attachment: block.attachment })
            content.push({type:'image',mimeType:attachment.attachment.mediaType,data:attachment.data})
          }
        }
      }
      if (!content.length) throw new AcpError('这条消息没有外部 Agent 支持的内容。')
      if (delegated) content.unshift({type:'text',text:delegationInstructions(personas.get(agent),msgs)})
      let permissions = readPermissions()
      while (mode !== permissions.mode) {
        mode = permissions.mode
        await driver.syncMode(live,mode,signal)
        permissions = readPermissions()
      }
      const watch = watchPermissions({
        initial:permissions, read:readPermissions, signal,
        widen:id === 'kimi-code' ? mode => driver.syncMode(live,mode,signal) : undefined,
        deferred:value=>{state.permissionDeferred = value},
        pause() {
          try { agent.cancel({kind:'hook',reason:permissionPauseReason},{keepInbox:true}) }
          catch (error) { ctx.logger.warn(safeError(error).message) }
          void driver.release(agent.id).catch(error=>ctx.logger.warn(safeError(error).message))
        },
      })
      permissionWatch = state.permissionWatch = watch
      let pendingInteractions = 0
      const pending = async <T>(op: () => Promise<T>) => {
        pendingInteractions++
        state.pending = true
        activity()
        try { return await op() } finally {
          state.pending = --pendingInteractions > 0
          activity()
        }
      }
      activity()
      const result = await driver.prompt(live, {
        signal,
        update(update) {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
            receivedReply ||= !!update.content.text.trim()
            text(update.content.text)
          }
          if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') tools.receive(update)
          if (update.sessionUpdate === 'usage_update') {
            state.usage = 'ACP 上下文：' + update.used + ' / ' + update.size
              + (update.cost ? '\n会话费用：' + update.cost.amount + ' ' + update.cost.currency : '')
          }
          if (update.sessionUpdate === 'available_commands_update') {
            state.commands = update.availableCommands.slice(0,30).map(command => '/'+command.name).join('、')
          }
          const plan = planText(update)
          if (plan !== undefined) state.planText = plan
          if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk'
            || update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' || plan !== undefined) activity()
        },
        permission: (req,interactionSignal) => pending(() => approve(ctx,agent,req,interactionSignal,
          watch.approval,interactionSignal.aborted ? undefined : tools.receive(req.toolCall)?.id)),
        question: (req,interactionSignal) => delegated
          ? Promise.resolve({action:'decline'})
          : pending(() => elicit(ctx,agent,req,interactionSignal)),
      }, content, input.at(-1)?.id ?? null)
      if (id === 'antigravity' && delegated && result.stopReason === 'end_turn' && !receivedReply) {
        state.error = 'Antigravity 子智能体已结束，但未返回最终回复；请由主会话检查工具结果后续发。'
        text(state.error)
        finish = {type:'finish',reason:{kind:'error',failure:{code:'EXTERNAL_AGENT_EMPTY_RESULT',message:state.error}}}
      }
      if (result.stopReason === 'max_tokens') finish = {type:'finish',reason:{kind:'max-tokens'}}
      if (result.stopReason === 'refusal' && !queue.length && !delta) text('外部 Agent 拒绝了这次请求。')
      const u = result.usage
      if (u && Number.isFinite(u.inputTokens) && Number.isFinite(u.outputTokens)) {
        usage = {type:'usage',usage:{inputTokens:u.inputTokens,outputTokens:u.outputTokens,totalTokens:u.totalTokens}}
      }
    })().catch(error => {
      if (!signal.aborted) {
        const failure = safeError(error)
        state.error = failure.message
        if (error instanceof KimiQuotaError) {
          finish = {type:'finish',reason:{kind:'error',failure:{code:'EXTERNAL_AGENT_QUOTA_EXHAUSTED',status:429,message:failure.message}}}
        } else if (error instanceof AcpConnectionLost) {
          finish = {type:'finish',reason:{kind:'error',failure:{code:'EXTERNAL_AGENT_CONNECTION_LOST',message:failure.message}}}
        } else failed = failure
      }
    }).finally(() => {
      clearTimeout(idleTimer)
      state.idleWarning = undefined
      permissionWatch?.stop()
      if (state.permissionWatch === permissionWatch) state.permissionWatch = undefined
      try { tools.flush() } catch (error) { failed ??= safeError(error) }
      completed = true
      wake()
    })
    try {
      while (!completed || queue.length) {
        if (!queue.length) { await new Promise<void>(resolve => { wake = resolve }); continue }
        const addition = queue.splice(0).join('')
        if (!collected) { collected = true; yield {type:'block-start',index:0,blockType:'text'} }
        delta += addition
        yield {type:'text-delta',index:0,text:addition}
      }
      signal.throwIfAborted()
      if (failed) throw failed
      if (collected) yield {type:'block-end',index:0,block:{type:'text',text:delta}}
      if (usage) yield usage
      yield finish
    } finally {
      streamLifetime.abort()
      await run
    }
  }

  return {
    providerInfo: provider => ({ id:provider, name:'外部 Agent · ' + display(provider) }),
    providerRetryPolicy: () => ({mode:'normal',maxRetries:0,retryableCodes:[],initialDelayMs:0,maxDelayMs:0,jitterRatio:0}),
    async listModels(provider) {
      const id = routeAgent(provider)!
      const options = (await driver.probe(id,await cwd())).options
      const model = options.find(option => option.category === 'model')
      return [{...resolved(provider,defaultModel,options),badge:modelBadge}, ...(model ? choices(model).map(choice => ({
        ...resolved(provider,choice.value,options), name:choice.name, description:choice.description ?? undefined, badge:modelBadge,
      })) : [])]
    },
    resolveModel: describe,
    prepareCall: async (provider,model) => ({model:await describe(provider,model),stream}),
    imageRequestPricing: () => undefined,
    imageRequestTarget: (_p,_m,image) => ({width:image.width,height:image.height,maxBytes:image.bytes}),
    stream,
  }
}

function collectInjection(ctx: Host, agent: Agent, config: ExternalAgentDriver['config'], cwd: string): Injection {
  const notices: string[] = []
  const entries: Record<string, McpEntry> = Object.create(null)
  // The host MCP config has no per-preset tool authorization. A delegated run
  // keeps its scoped skills without acquiring additional host MCP transports.
  if (config.injectDshMcp && !isDelegatedChild(agent)) {
    // Config is exposed on the manager. The roster reports enabled runtime
    // registrations too, but exposes no transport descriptor for those.
    const manager = (agent.ctx.get('mcpManager') ?? ctx.get('mcpManager')) as Host['mcpManager'] | undefined
    if (manager) {
      Object.assign(entries, manager.config.servers.get())
      const unavailable = manager.list().filter(item => item.status.state !== 'disabled' && !Object.hasOwn(entries,item.name))
      if (unavailable.length) notices.push('DSH 未公开以下 MCP 的连接参数：' + unavailable.map(item => item.name).join('、'))
    }
  }
  const registry = config.injectDshSkills ? agent.ctx.get('skills') as Host['skills'] | undefined : undefined
  return {entries,notices,skills:registry ? {registry,scope:agent,cwd} : undefined}
}

export function apply(ctx: Host, raw?: unknown) {
  const config = parseConfig(raw)
  const dir = join(process.env.DSH_HOME || join(homedir(),'.dsh'),'external-agents','bindings')
  const driver = new ExternalAgentDriver(config,bindingStore(dir),
    (agent,message) => ctx.logger.warn(profiles[agent].name + ' ACP: ' + message))
  const states = new Map<string, UiState>()
  const personas = new WeakMap<Agent, readonly string[]>()
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent && isDelegatedChild(agent) && routeAgent(context.modelSelection?.provider)) {
      personas.set(agent,childPersonaSections(assembled))
    }
    return assembled
  },{global:true})
  ctx.llm.registerAdapter(agentEntries.map(id => routePrefix + id), nativeAdapter(ctx,driver,states,personas))
  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    return driver.release(agent.id)
  },{global:true})
  ctx.on('session/event',(session,event) => {
    if (event.type === 'sandbox/mode' || event.type === 'approval/policy' || event.type === 'permission/preset') {
      states.get(session.id)?.permissionWatch?.schedule()
      return
    }
    if (event.type !== 'model/selection') return
    const live = driver.current(session.id)
    if (live && !live.turn && live.binding.agentId !== routeAgent(event.data.provider)) {
      return driver.release(session.id)
    }
  },{global:true})
  const get = async (id: string) => {
    const current = ctx.agents.get(id as SessionId)
    const result = current ? {agent:current} : await ctx.sessionController.resolveAgent(id as SessionId)
    const found = 'agent' in result ? result.agent : undefined
    if (!nativeSession(found) || found.id !== id) throw new AcpError('找不到可用的 DSH 会话。')
    return found
  }
  const stopSetup = registerSetup(ctx,{
    async status(id,refresh) {
      const agent = await get(id)
      const delegated = isDelegatedChild(agent)
      const selection = agent.model.current()
      const kind = routeAgent(selection?.provider)
      if (!kind) return null
      const current = driver.current(id)
      const live = current?.binding.agentId === kind && !current.client.closed ? current : undefined
      const permissionPause = !delegated && agent.status === 'idle' ? lastPermissionPause(agent.session) : undefined
      const probe = live ? {readiness:{status:'ready'},options:live.options}
        : agent.status === 'running' ? {readiness:{status:'checking'},options:[]}
        : permissionPause !== undefined && !refresh ? {readiness:{status:'ready'},options:[]}
        : await driver.probe(kind,await ctx.workingDirectory.ensure(agent),refresh)
      const state = states.get(id)
      return {
        agent:kind, name:profiles[kind].name, install:profiles[kind].install, login:profiles[kind].login, delegated,
        model: selection?.model, permission:sessionPermissions(ctx,agent).preset, readiness:probe.readiness,
        options: probe.options.map(option => ({id:option.id, name:option.name, category:option.category, type:option.type,
          currentValue:option.currentValue, choices:choices(option).map(({value,name})=>({value,name}))})),
        connected:!!live, running:agent.status === 'running', pending:state?.pending, plan:planMode(ctx,agent)?.get(agent).active ?? state?.plan ?? false, details:[state?.planText,state?.commands && '可用命令：' + state.commands,state?.usage].filter(Boolean).join('\n\n'),
        notice:state?.notice,idleWarning:state?.idleWarning,error:state?.error,
        permissionUpdate:permissionPause !== undefined ? 'paused' : state?.permissionDeferred ? 'next-turn' : undefined,
        permissionPause,
      }
    },
    async option(id,key,value) {
      const agent = await get(id)
      if (isDelegatedChild(agent)) throw new AcpError('子智能体的配置由 DSH 派发时决定。')
      if (agent.status === 'running') throw new AcpError('请等当前回合结束。')
      const selection = agent.model.current()
      const kind = routeAgent(selection?.provider)
      if (!kind || !selection) throw new AcpError('当前会话未选择外部 Agent。')
      const live = driver.current(id)
      if (key === '@plan' && typeof value === 'boolean') {
        const mode = planMode(ctx,agent)
        if (mode) mode.set(agent,value)
        else states.set(id, { ...states.get(id), plan:value })
        return
      }
      if (live?.binding.agentId !== kind || !live || live.client.closed) throw new AcpError('请先开始一个回合。')
      const option = live.options.find(option => option.id === key)
      if (!option || !['thought_level','model_config','collaboration_mode'].includes(option.category ?? '') || !validChoice(option,value)) {
        throw new AcpError('该选项不可用。')
      }
      await driver.changeOption(live,option,value,()=>agent.status === 'idle' && agent.model.current()?.provider === selection.provider)
    },
    async resume(id,pause) {
      const agent = await get(id)
      if (isDelegatedChild(agent)) throw new AcpError('请由主会话继续子智能体任务。')
      if (agent.status !== 'idle' || !routeAgent(agent.model.current()?.provider) || lastPermissionPause(agent.session) !== pause
        || agent.inbox.nextTurn.some(isExplicitInput) || agent.inbox.nextStep.some(isExplicitInput)) {
        throw new AcpError('该回合已继续，或会话状态已改变。')
      }
      agent.followup({id:randomUUID() as MessageId,role:'user',source:{kind:'user'},content:[{
        type:'text',text:'按当前权限继续刚才暂停的任务。先确认已经完成的操作，再处理剩余工作。',
      }]})
    },
  })
  ctx.effect(() => async () => { stopSetup(); await driver.close() })
}

function validChoice(option: SessionConfigOption, value: unknown): value is string | boolean {
  return option.type === 'boolean' ? typeof value === 'boolean' : choices(option).some(choice => choice.value === value)
}

function planMode(ctx: Host, agent: Agent) {
  return (agent.ctx.get('planMode') ?? ctx.get('planMode')) as {
    get(agent: Agent): {active: boolean}
    set(agent: Agent, active: boolean): unknown
  } | undefined
}
