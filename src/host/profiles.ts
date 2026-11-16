import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

export const profiles = {
  'kimi-code': {
    name: 'Kimi Code', cli: 'kimi',
    install: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    login: 'kimi login',
  },
  codex: {
    name: 'Codex', cli: 'codex',
    install: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    login: 'codex login',
  },
} as const

export type AgentId = keyof typeof profiles
export interface Command { command: string; args: string[] }
interface Config {
  injectDshSkills: boolean
  injectDshMcp: boolean
  codexTransport: 'https' | 'native'
  commandOverrides: Partial<Record<AgentId, Command>>
}

export function isAgentId(id: unknown): id is AgentId {
  return typeof id === 'string' && Object.hasOwn(profiles, id)
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('外部 Agent 配置格式无效。')
  return value as Record<string, unknown>
}

export function parseConfig(raw: unknown): Config {
  const data = record(raw ?? {})
  const keys = ['injectDshSkills', 'injectDshMcp', 'commandOverrides','codexTransport']
  if (Object.keys(data).some(key => !keys.includes(key))) throw new Error('外部 Agent 配置含有未知字段。')
  const field = (key: string): unknown => {
    const value = data[key]
    return value !== null && typeof value === 'object' && 'get' in value && typeof value.get === 'function'
      ? value.get() : value
  }
  const enabled = (key: string) => {
    const value = field(key)
    if (value !== undefined && typeof value !== 'boolean') throw new Error('技能和 MCP 开关必须是布尔值。')
    return value !== false
  }
  const transport = () => {
    const value = field('codexTransport')
    if (value !== undefined && value !== 'https' && value !== 'native') {
      throw new Error('Codex 连接方式应为 https 或 native。')
    }
    return value ?? 'native'
  }
  enabled('injectDshSkills')
  enabled('injectDshMcp')
  transport()
  const overrides: Config['commandOverrides'] = {}
  for (const [id, value] of Object.entries(record(data.commandOverrides ?? {}))) {
    const { command, args, ...extra } = record(value)
    if (!isAgentId(id) || typeof command !== 'string' || !command.trim() || command.includes('\0')
      || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Object.keys(extra).length) {
      throw new Error('外部 Agent 启动命令格式无效。')
    }
    overrides[id] = { command, args }
  }
  return {
    get injectDshSkills() { return enabled('injectDshSkills') },
    get injectDshMcp() { return enabled('injectDshMcp') },
    get codexTransport() { return transport() },
    commandOverrides:overrides,
  }
}

const home = homedir()
const pathParts = [...(process.env.PATH ?? '').split(delimiter), join(home, '.kimi-code/bin'),
  join(home, '.npm-global/bin'), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(isAbsolute)
export const executablePath = [...new Set(pathParts)].join(delimiter)

async function locate(command: string): Promise<string | undefined> {
  const candidates = isAbsolute(command) ? [command] : pathParts.flatMap(dir =>
    process.platform === 'win32' && !/\.[a-z]+$/i.test(command) ? [join(dir, command + '.exe')] : [join(dir, command)])
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path } catch { /* try the next PATH entry */ }
  }
}

export async function resolveCommand(id: AgentId, config: Config): Promise<Command | undefined> {
  const override = config.commandOverrides[id]
  if (override) {
    const command = await locate(override.command)
    return command ? { command, args: override.args } : undefined
  }
  const cli = await locate(profiles[id].cli)
  if (!cli) return undefined
  if (id === 'kimi-code') return { command: cli, args: ['acp'] }
  const acp = await locate('codex-acp')
  if (acp) return { command: acp, args: [] }
  const npx = await locate('npx')
  return npx ? { command: npx, args: ['-y', '@agentclientprotocol/codex-acp@2.6.0'] } : undefined
}

export function childEnvironment(id: AgentId, transport: Config['codexTransport']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: executablePath }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  if (id === 'codex') {
    // Do not inherit an ACP shell's gateway/approval overrides. Local CLI login remains in CODEX_HOME.
    delete env.CODEX_CONFIG
    delete env.INITIAL_AGENT_MODE
    delete env.DEFAULT_AUTH_REQUEST
    delete env.APP_SERVER_LOGS
    delete env.MODEL_PROVIDER
    const https = transport === 'https' ? {
      model_provider: 'dsh-openai-http',
      model_providers: {'dsh-openai-http':{
        name:'OpenAI HTTP', wire_api:'responses', requires_openai_auth:true, supports_websockets:false,
      }},
    } : {}
    env.CODEX_CONFIG = JSON.stringify({ features: { hooks: false }, approvals_reviewer: 'user', ...https })
  }
  return env
}
