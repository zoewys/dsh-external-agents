import type {
  AgentCapabilities, ContentBlock, NewSessionRequest, CreateElicitationRequest, CreateElicitationResponse, RequestPermissionRequest,
  RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolCallUpdate,
} from '@agentclientprotocol/sdk/unstable'
import { AcpConnectionLost, AcpError, connect, safeError, type AcpClient } from '../acp/client.ts'
import type { Binding, bindingStore } from '../host/binding-store.ts'
import { mcpPayload, type McpEntry } from '../host/injection.ts'
import { startSkillServer, type SkillAccess } from '../host/skill-server.ts'
import { childEnvironment, profiles, resolveCommand, type AgentId, type parseConfig } from '../host/profiles.ts'
import { choices, sessionOptions } from './options.ts'

type Config = ReturnType<typeof parseConfig>
type Init = Awaited<ReturnType<AcpClient['initialize']>>
export type Readiness = { status: 'ready' | 'not_installed' | 'not_logged_in' | 'error'; message?: string }
export interface Injection {
  entries: Record<string, McpEntry>
  skills?: SkillAccess
  notices: string[]
}
interface Turn {
  signal: AbortSignal
  update: (event: SessionNotification['update']) => void
  permission: (req: RequestPermissionRequest,signal: AbortSignal) => Promise<RequestPermissionResponse>
  question: (req: CreateElicitationRequest,signal: AbortSignal) => Promise<CreateElicitationResponse>
}
interface Live {
  client: AcpClient
  init: Init
  binding: Binding
  options: SessionConfigOption[]
  replaying: boolean
  lifetime: AbortController
  interactions: Set<Promise<unknown>>
  configChange?: Promise<void>
  turn?: Turn
  context: ContentBlock[]
  idleTimer?: NodeJS.Timeout
  skillServer?: Awaited<ReturnType<typeof startSkillServer>>
  pendingContextHandoff: boolean
}
interface SessionOptions {
  id: string; agent: AgentId; cwd: string; securityMode: string; model: string; effort?: string;
  signal: AbortSignal; summary: string; nativeIntervened?: boolean; permissionContinuation?: boolean;
  injection: (config: Config) => Injection; notice: (text: string) => void
}

export class ExternalAgentDriver {
  private readonly active = new Map<string, Live>()
  private readonly probeCache = new Map<string, { at: number; result: Promise<{ readiness: Readiness; options: SessionConfigOption[] }> }>()
  private readonly shutdown = new AbortController()
  private readonly probes = new Set<ReturnType<ExternalAgentDriver['check']>>()
  private readonly diagnostic?: (agent: AgentId, message: string) => void

  readonly config: Config
  readonly store: ReturnType<typeof bindingStore>
  constructor(config: Config, store: ReturnType<typeof bindingStore>,
    diagnostic?: (agent: AgentId, message: string) => void) {
    this.config = config
    this.store = store
    this.diagnostic = diagnostic
  }

  current(id: string) { return this.active.get(id) }

  probe(agent: AgentId, cwd: string, refresh = false) {
    const config = {...this.config}
    const key = agent + '\0' + cwd + '\0' + (agent === 'codex' ? config.codexTransport : '')
    const cached = this.probeCache.get(key)
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.result
    const result = this.check(agent,cwd,config)
    this.probes.add(result)
    void result.then(()=>this.probes.delete(result),()=>this.probes.delete(result))
    if (this.probeCache.size >= 128) this.probeCache.clear()
    this.probeCache.set(key, { at: Date.now(), result })
    return result
  }

  private async check(agent: AgentId, cwd: string, config: Config): Promise<{ readiness: Readiness; options: SessionConfigOption[] }> {
    let client: AcpClient | undefined
    let probeSession: string | undefined
    let canDelete = false
    try {
      this.shutdown.signal.throwIfAborted()
      const command = await resolveCommand(agent,config)
      if (!command) return { readiness: { status: 'not_installed' }, options: [] }
      client = connect(command,cwd,childEnvironment(agent,config.codexTransport), {
        diagnostic: message => this.diagnostic?.(agent,message),
      })
      const init = await client.initialize(this.shutdown.signal)
      validateInit(init)
      canDelete = !!init.agentCapabilities?.sessionCapabilities?.delete
      // authMethods advertises login mechanisms even when already logged in.
      // session/new returns auth-required when the actual login is unavailable.
      const opened = await client.open({ cwd, mcpServers: [] }, this.shutdown.signal)
      probeSession = opened.sessionId
      return { readiness: { status: 'ready' }, options: sessionOptions(opened) }
    } catch (error) {
      const safe = safeError(error)
      return { readiness: { status: safe.code === -32000 ? 'not_logged_in' : 'error', message: safe.message }, options: [] }
    } finally {
      if (probeSession) {
        await client?.closeSession(probeSession)
        if (canDelete) await client?.deleteSession(probeSession)
      }
      await client?.stop()
    }
  }

  async prepare(params: SessionOptions, freshModel = false): Promise<Live> {
    const signal = AbortSignal.any([params.signal, this.shutdown.signal])
    const { id, agent, cwd, securityMode, notice } = params
    signal.throwIfAborted()
    const config = {...this.config}
    const connectionSettings = JSON.stringify([
      config.injectDshSkills, config.injectDshMcp, agent === 'codex' ? config.codexTransport : null,
    ])
    const previous = await this.store.get(id)
    const command = await resolveCommand(agent,config)
    if (!command) throw new AcpError('未找到 ' + profiles[agent].name + '。请打开设置向导。')
    signal.throwIfAborted()
    const sameCommand = (saved: Binding['command']) => saved.command === command.command && JSON.stringify(saved.args) === JSON.stringify(command.args)
    let current = this.active.get(id)
    if (current && (current.client.closed || current.binding.agentId !== agent || current.binding.cwd !== cwd
      || current.binding.connectionSettings !== connectionSettings || !sameCommand(current.binding.command) || freshModel)) {
      await this.release(id)
      current = undefined
    }
    const switched = previous && previous.agentId !== agent
    const legacySkills = previous?.agentId === agent && previous.skillProtocol !== 'on-demand'
    const reconfigured = previous?.agentId === agent && previous.connectionSettings !== undefined
      && previous.connectionSettings !== connectionSettings
    if (current?.idleTimer) clearTimeout(current.idleTimer)
    if (!current) {
      let live: Live | undefined
      let skillServer: Live['skillServer']
      const client = connect(command,cwd,childEnvironment(agent,config.codexTransport), {
        diagnostic: message => this.diagnostic?.(agent,message),
        update: event => {
          if (!live || event.sessionId !== live.binding.acpSessionId) return
          if (event.update.sessionUpdate === 'config_option_update') live.options = event.update.configOptions
          if (event.update.sessionUpdate === 'current_mode_update') {
            const mode = event.update.currentModeId
            live.options = live.options.map(option => option.type === 'select' && option.category === 'mode'
              ? {...option,currentValue:mode} : option)
          }
          if (!live.replaying && live.turn && !live.turn.signal.aborted) live.turn.update(event.update)
        },
        permission: async req => live && req.sessionId === live.binding.acpSessionId && live.turn
          ? trackInteraction(live,live.turn.permission(req,live.turn.signal)) : { outcome: { outcome: 'cancelled' } },
        question: async req => live?.turn && (!('sessionId' in req) || req.sessionId === live.binding.acpSessionId)
          ? trackInteraction(live,live.turn.question(req,live.turn.signal)) : { action: 'cancel' },
      })
      try {
        const init = await client.initialize(signal)
        validateInit(init)
        const injection = params.injection(config)
        const capabilities: AgentCapabilities = init.agentCapabilities ?? {}
        const payload = mcpPayload(injection.entries, capabilities.mcpCapabilities, cwd)
        for (const warning of injection.notices) notice(warning)
        if (payload.failed.length) notice('未注入以下 MCP：' + payload.failed.join('、'))
        if (injection.skills) {
          if (capabilities.mcpCapabilities?.http) {
            try {
              skillServer = await startSkillServer(injection.skills, () => live?.turn?.signal)
              let name = 'dsh_skills'
              while (payload.servers.some(server => server.name === name)) name += '_'
              payload.servers.push({name,type:'http',url:skillServer.url,headers:[]})
            } catch {
              signal.throwIfAborted()
              notice('无法连接 DSH 技能工具。仍可在 DSH 中手动调用技能。')
            }
          } else {
            notice('此 Agent 无法连接 DSH 技能工具。仍可在 DSH 中手动调用技能。')
          }
        }
        const openParams: NewSessionRequest = { cwd, mcpServers: payload.servers }
        live = {
          client, init, options: [], replaying: true, context: [], lifetime:new AbortController(),interactions:new Set(),
          skillServer, pendingContextHandoff:legacySkills || reconfigured,
          binding: { dshSessionId: id, agentId: agent, acpSessionId: previous?.acpSessionId ?? '', cwd,
            agentCapabilities: capabilities, command, values: {}, skillProtocol:'on-demand', connectionSettings, sentThrough: null, updatedAt: Date.now() },
        }
        let restored = false
        if (!freshModel && !legacySkills && !reconfigured && !params.nativeIntervened
          && previous?.agentId === agent && previous.cwd === cwd && sameCommand(previous.command)) {
          const methods = [
            ...(capabilities.sessionCapabilities?.resume ? ['session/resume' as const] : []),
            ...(capabilities.loadSession ? ['session/load' as const] : []),
          ]
          for (const method of methods) {
            try {
              live.options = sessionOptions(await client.restore(method, previous.acpSessionId, openParams, signal))
              live.binding.sentThrough = previous.sentThrough
              restored = true
              break
            } catch (error) {
              signal.throwIfAborted()
              if (safeError(error).code === -32000) throw error
            }
          }
        }
        if (!restored) {
          const modelOption = freshModel ? (await this.probe(agent,cwd)).options.find(option=>option.category==='model') : undefined
          const opened = await client.open({ ...openParams,
          ...(modelOption && !modelOption.id.startsWith('@') && capabilities.sessionCapabilities?.options
            ? {configOptions:[{configId:modelOption.id,value:params.model}]} : {}),
          }, signal)
          live.binding.acpSessionId = opened.sessionId
          live.options = sessionOptions(opened)
          if (freshModel) notice('该 Agent 无法在原会话里切换模型。已创建新会话并带入上文摘要。')
          else if (switched) notice('已切换到 ' + profiles[agent].name + '，并带入上文摘要。新 Agent 不会继承原 Agent 的内部记忆。')
          else if (legacySkills) notice('技能已切换为按需加载，新的 ACP 会话带入了 DSH 对话摘要。')
          else if (reconfigured) notice('外部 Agent 设置已生效，已带入之前的对话摘要。')
          else if (previous && params.nativeIntervened) notice('已回到 ' + profiles[agent].name + '。新的 ACP 会话带入了 DSH 对话摘要。')
          else if (previous) notice('原 ACP 会话无法恢复。已带入 DSH 对话摘要，外部 Agent 从新的内部上下文开始。')
        }
        if (params.summary && (!restored || params.permissionContinuation)) {
          live.context.push(capabilities.promptCapabilities?.embeddedContext ? {
            type:'resource',resource:{uri:'dsh-context:///history.md',mimeType:'text/markdown',text:params.summary},
          } : {type:'text',text:'<dsh-context label="此前的 DSH 对话">\n' + params.summary + '\n</dsh-context>'})
        }
        live.replaying = false
        current = live
        this.active.set(id, live)
      } catch (error) {
        skillServer?.close()
        await client.stop()
        throw error
      }
    }
    try {
      await current.configChange
      await this.configure(current, securityMode, params.model, params.effort, signal)
      await this.save(current)
      this.armIdle(current)
      return current
    } catch (error) {
      await this.release(id)
      if (!freshModel && !signal.aborted && error instanceof ModelSwitchUnsupported) return this.prepare(params,true)
      throw error
    }
  }

  private async configure(live: Live, mode: string, model: string, effort: string | undefined, signal: AbortSignal) {
    await this.configureMode(live,mode,signal)
    const modelOption = live.options.find(item => item.category === 'model')
    if (model !== '@default' && modelOption?.currentValue !== model) {
      if (!modelOption || !choices(modelOption).some(item => item.value === model)) throw new AcpError('这个工作目录下的外部 Agent 未提供所选模型。')
      try { await this.set(live, modelOption, model, signal) }
      catch (error) {
        if (safeError(error).code === -32601 || error instanceof ModelSwitchUnsupported) {
          throw new ModelSwitchUnsupported('外部 Agent 无法在 ACP 会话内切换模型。')
        }
        throw error
      }
    }
    if (effort !== undefined) {
      const option = live.options.find(item => item.category === 'thought_level')
      if (!option || !choices(option).some(item => item.value === effort)) throw new AcpError('当前模型未提供所选的推理等级。')
      if (option.currentValue !== effort) await this.set(live, option, effort, signal)
    }
  }

  private async configureMode(live: Live, mode: string, signal: AbortSignal) {
    signal.throwIfAborted()
    const option = live.options.find(item => item.category === 'mode')
    if (option?.type !== 'select' || !choices(option).some(item => item.value === mode)) {
      throw new AcpError('外部 Agent 未提供与当前 DSH 权限对应的运行模式。')
    }
    if (option.currentValue !== mode) await this.set(live,option,mode,signal)
  }

  async syncMode(live: Live, mode: string, signal: AbortSignal) {
    if (this.active.get(live.binding.dshSessionId) !== live || live.configChange) {
      throw new AcpError('外部 Agent 会话已变更。')
    }
    const operation = this.configureMode(live,mode,signal)
    const settled = operation.then(() => {}, () => {})
    live.configChange = settled
    try { await operation } finally { live.configChange = undefined }
  }

  async changeOption(live: Live, option:SessionConfigOption, value:string|boolean, valid:()=>boolean) {
    if (live.configChange || !valid() || this.active.get(live.binding.dshSessionId) !== live) {
      throw new AcpError('会话状态已改变，请重试。')
    }
    const operation = this.set(live,option,value,live.lifetime.signal).then(async()=>{
      if (this.active.get(live.binding.dshSessionId) === live) await this.save(live)
    })
    live.configChange = operation
    try { await operation } finally { live.configChange = undefined }
  }

  private async set(live: Live, option: SessionConfigOption, value: string | boolean, signal?: AbortSignal) {
    const id = live.binding.acpSessionId
    if (option.id === '@mode') await live.client.setMode(id, String(value), signal)
    else if (option.id === '@model') await live.client.setModel(id, String(value), signal)
    else {
      const result = await live.client.set(id, option.id, value, signal)
      if (result.configOptions?.length) {
        live.options = result.configOptions
        const confirmed = live.options.find(item=>item.id===option.id)?.currentValue
        if (confirmed !== value) {
          if (option.category==='model') throw new ModelSwitchUnsupported('外部 Agent 未采用所选模型。')
          throw new AcpError(option.category==='mode' ? '无法确认外部 Agent 采用了 DSH 要求的权限模式。' : '外部 Agent 未采用所选参数。')
        }
        return
      } else if (option.category==='mode') {
        throw new AcpError('无法确认外部 Agent 采用了 DSH 要求的权限模式。')
      }
    }
    live.options = live.options.map(item => item.id !== option.id ? item :
      (item.type === 'boolean' && typeof value === 'boolean') || (item.type === 'select' && typeof value === 'string')
        ? { ...item, currentValue: value } as SessionConfigOption : item)
  }

  async prompt(live: Live, turn: Turn, input: ContentBlock[], sentThrough: string | null) {
    const signal = AbortSignal.any([turn.signal, this.shutdown.signal, live.lifetime.signal])
    signal.throwIfAborted()
    if (live.turn) throw new AcpError('当前 ACP 会话已有回合正在运行。')
    if (live.idleTimer) clearTimeout(live.idleTimer)
    const lifetime = new AbortController()
    const interactionSignal = AbortSignal.any([signal,lifetime.signal])
    live.turn = { ...turn, signal:interactionSignal }
    const id = live.binding.acpSessionId
    const stop = () => {
      void live.client.cancel(id).catch(() => {})
      cancelTimer = setTimeout(() => { void live.client.stop() }, 1400)
      cancelTimer.unref()
    }
    let cancelTimer: NodeJS.Timeout | undefined
    signal.addEventListener('abort', stop, { once: true })
    try {
      const result = await live.client.prompt({ sessionId: id, prompt: [
        ...live.context, ...input,
      ] }).catch(error => {
        if (!signal.aborted && live.client.closed) throw new AcpConnectionLost()
        throw error
      })
      if (live.pendingContextHandoff) signal.throwIfAborted()
      if (sentThrough) live.binding.sentThrough = sentThrough
      await this.save(live,true)
      live.pendingContextHandoff = false
      live.context = []
      signal.throwIfAborted()
      return result
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer)
      signal.removeEventListener('abort', stop)
      lifetime.abort()
      live.turn = undefined
      await Promise.allSettled(live.interactions)
      this.armIdle(live)
    }
  }

  private armIdle(live: Live) {
    if (this.active.get(live.binding.dshSessionId) === live) {
      live.idleTimer = setTimeout(() => { void this.release(live.binding.dshSessionId) },300_000).unref()
    }
  }

  private async save(live: Live, completedTurn = false) {
    if (live.pendingContextHandoff && !completedTurn) return
    live.binding.updatedAt = Date.now()
    live.binding.values = Object.fromEntries(live.options.map(option => [option.id, option.currentValue]))
    return this.store.save(live.binding)
  }

  async release(id: string) {
    const live = this.active.get(id)
    if (!live) return
    this.active.delete(id)
    if (live.idleTimer) clearTimeout(live.idleTimer)
    live.lifetime.abort()
    live.skillServer?.close()
    if (live.init.agentCapabilities?.sessionCapabilities?.close && !live.turn && !live.client.closed) {
      await live.client.closeSession(live.binding.acpSessionId)
    }
    await live.client.stop()
    await Promise.allSettled(live.interactions)
  }

  async close() {
    this.shutdown.abort()
    await Promise.allSettled([...this.active.keys()].map(id => this.release(id)))
    await Promise.allSettled([...this.probes])
  }
}

function trackInteraction<T>(live: Live, result: Promise<T>): Promise<T> {
  live.interactions.add(result)
  void result.then(()=>live.interactions.delete(result),()=>live.interactions.delete(result))
  return result
}

class ModelSwitchUnsupported extends AcpError {}

function validateInit(init: Init) {
  if (init.protocolVersion !== 1) throw new AcpError('外部 Agent 的 ACP 版本不兼容。')
  if ((init as Init & { authRequired?: boolean }).authRequired === true) {
    throw new AcpError('请先完成本机 CLI 登录。', -32000)
  }
}

export type ExternalTool = ToolCallUpdate & { title?: string }
