import { ClientApp, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk/unstable'
import type {
  CreateElicitationRequest, CreateElicitationResponse, InitializeResponse, LoadSessionResponse, NewSessionRequest,
  NewSessionResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification,
} from '@agentclientprotocol/sdk/unstable'
import { startProcess } from './process.ts'
import type { Command } from '../host/profiles.ts'

export class AcpError extends Error {
  readonly code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

export class AcpConnectionLost extends AcpError {
  constructor() { super('外部 Agent 连接已断开。可在原会话继续。') }
}

export function safeError(error: unknown): AcpError {
  if (error instanceof AcpError) return error
  if (error instanceof RequestError) {
    if (error.code === -32000) return new AcpError('本机 CLI 需要登录。请完成登录并重新检测。', error.code)
    if (error.code === -32002) return new AcpError('原 ACP 会话已失效。', error.code)
    return new AcpError('外部 Agent 返回 ACP 错误（' + error.code + '）。请在本机 CLI 中检查。', error.code)
  }
  if (error instanceof Error && error.name === 'TimeoutError') return new AcpError('连接外部 Agent 超时。')
  return new AcpError('无法与外部 Agent 通信。请检查本机 CLI、工作目录与网络。')
}

export interface Handlers {
  update?: (event: SessionNotification) => void
  permission?: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>
  question?: (req: CreateElicitationRequest) => Promise<CreateElicitationResponse>
  diagnostic?: (message: string) => void
}

export function connect(command: Command, cwd: string, env: NodeJS.ProcessEnv, handlers: Handlers = {}) {
  const child = startProcess(command, cwd, env, handlers.diagnostic)
  const client = new ClientApp()
    .onNotification('session/update', ({ params }) => handlers.update?.(params))
    .onRequest('session/request_permission', async ({ params }) => await handlers.permission?.(params) ?? { outcome: { outcome: 'cancelled' } })
    .onRequest('elicitation/create', async ({ params }) => await handlers.question?.(params) ?? { action: 'cancel' })
    .connect(child.stream)
  void child.closed.then(() => client.close())
  const time = (signal?: AbortSignal, timeout = 20_000) => ({
    stopWaitingOnCancel: true,
    cancellationSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  })
  let exit: Promise<void> | undefined
  return {
    get closed() { return client.signal.aborted },
    initialize: (signal?: AbortSignal) => client.agent.request<InitializeResponse>('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'dsh-external-agents', version: '0.3.0' },
      clientCapabilities: { elicitation: { form: {} }, plan: {} },
    }, time(signal, 45_000)),
    open: (params: NewSessionRequest, signal?: AbortSignal) =>
      // Cold CLI startup can initialize its own MCP services before replying.
      client.agent.request<NewSessionResponse>('session/new', params, time(signal,60_000)),
    restore: (method: 'session/load' | 'session/resume', sessionId: string, params: NewSessionRequest, signal?: AbortSignal) =>
      client.agent.request<LoadSessionResponse | undefined>(method, { ...params, sessionId }, time(signal,60_000)),
    set: (sessionId: string, configId: string, value: string | boolean, signal?: AbortSignal) =>
      client.agent.request('session/set_config_option', typeof value === 'boolean' ? { sessionId, configId, value, type: 'boolean' } : { sessionId, configId, value }, time(signal, 8_000)),
    setMode: (sessionId: string, modeId: string, signal?: AbortSignal) =>
      client.agent.request('session/set_mode', { sessionId, modeId }, time(signal, 8_000)),
    setModel: (sessionId: string, modelId: string, signal?: AbortSignal) =>
      client.agent.request('session/set_model', { sessionId, modelId }, time(signal, 8_000)),
    prompt: (params: import('@agentclientprotocol/sdk/unstable').PromptRequest) =>
      client.agent.request('session/prompt', params),
    cancel: (sessionId: string) => client.agent.notify('session/cancel', { sessionId }),
    async deleteSession(sessionId: string) {
      await client.agent.request('session/delete', { sessionId }, time(undefined, 1000)).catch(() => {})
    },
    async closeSession(sessionId: string) {
      await client.agent.request('session/close', { sessionId }, time(undefined, 1000)).catch(() => {})
    },
    stop() {
      return exit ??= (async () => { client.close(); await child.stop() })()
    },
  }
}
export type AcpClient = ReturnType<typeof connect>
