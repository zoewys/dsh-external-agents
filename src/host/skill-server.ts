import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Host } from './dsh.ts'

export interface SkillAccess {
  registry: Host['skills']
  scope: Agent
  cwd: string
}

const readOnly = {readOnlyHint:true,destructiveHint:false,openWorldHint:false}
const listTool = {
  name: 'list_dsh_skills',
  description: 'Discover DSH skills by name and description. Check this catalog when the task may match a reusable workflow, then call read_dsh_skill for each skill you need.',
  inputSchema: {type:'object' as const, properties:{}, additionalProperties:false},
  annotations: readOnly,
}
const readTool = {
  name: 'read_dsh_skill',
  description: 'Read one DSH skill by its exact catalog name. Follow its instructions and use the reported resource base when resolving relative references.',
  inputSchema: {type:'object' as const, properties:{name:{type:'string'}}, required:['name'], additionalProperties:false},
  annotations: readOnly,
}

function result(text: string, isError = false): CallToolResult {
  return { content:[{type:'text',text}], ...(isError ? {isError} : {}) }
}

export async function startSkillServer(access: SkillAccess, activeSignal: () => AbortSignal | undefined) {
  const path = '/mcp/' + randomBytes(32).toString('hex')
  const server = createServer(async (req,res) => {
    if (req.headers.host !== host || req.headers.origin !== undefined) {
      res.writeHead(403).end()
      return
    }
    if (req.url !== path) {
      res.writeHead(404).end()
      return
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator:undefined, enableJsonResponse:true })
    const mcp = new Server({ name:'dsh_skills', version:'1.0.0' }, { capabilities:{tools:{}} })
    mcp.setRequestHandler(ListToolsRequestSchema, () => ({tools:[listTool,readTool]}))
    mcp.setRequestHandler(CallToolRequestSchema, async ({params}) => {
      const signal = activeSignal()
      if (!signal || signal.aborted) return result('DSH 技能仅在当前外部 Agent 回合中可用。',true)
      const options = { scope:access.scope, cwd:access.cwd, signal }
      try {
        const catalog = (await access.registry.list(options)).filter(skill => skill.invocation.modelInvocable)
        signal.throwIfAborted()
        if (params.name === listTool.name) return result(JSON.stringify(catalog.map(({name,description}) => ({name,description}))))
        const name = params.arguments?.name
        if (params.name !== readTool.name || typeof name !== 'string' || !catalog.some(skill => skill.name === name)) {
          return result('此 DSH 技能在当前会话中不可用。',true)
        }
        const skill = await access.registry.get(name,options)
        signal.throwIfAborted()
        if (!skill?.invocation.modelInvocable) return result('此 DSH 技能在当前会话中不可用。',true)
        const base = skill.resourceBase
        const resource = base?.kind === 'directory' ? base.path : base?.kind === 'url' ? base.url : undefined
        return result(JSON.stringify({ name:skill.name, resourceBase:resource, instructions:skill.content }))
      } catch {
        return result('无法读取当前会话的 DSH 技能。',true)
      }
    })
    res.once('close',() => { void mcp.close() })
    try {
      await mcp.connect(transport)
      await transport.handleRequest(req,res)
    } catch {
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    }
  })
  const listenHost = '127.0.0.1'
  const host = await new Promise<string>((resolve,reject) => {
    server.once('error',reject)
    server.listen(0,listenHost,() => {
      server.off('error',reject)
      // Listening on TCP supplies an ephemeral port before any requests arrive.
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('DSH skills server has no TCP address'))
        return
      }
      resolve(listenHost + ':' + address.port)
    })
  })
  server.unref()
  return {
    url: 'http://' + host + path,
    close() { server.close(); server.closeAllConnections() },
  }
}
