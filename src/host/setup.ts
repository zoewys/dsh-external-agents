import { randomBytes } from 'node:crypto'
import type { Host } from './dsh.ts'
import { AcpError, safeError } from '../acp/client.ts'

const base = '/api/dsh-external-agents'
interface Setup {
  status(id: string, refresh: boolean): Promise<unknown>
  option(id: string, key: string, value: unknown): Promise<void>
  resume(id: string, pause: number): Promise<void>
}

function reply(status: number, data: unknown) {
  return new Response(JSON.stringify(data),{status,headers:{
    'content-type':'application/json; charset=utf-8','cache-control':'no-store',
  }})
}

async function parse(req: Request) {
  const reader = req.body?.getReader()
  if (!reader) throw new AcpError('请求为空。')
  const decoder = new TextDecoder()
  let data = '', bytes = 0
  try {
    while (true) {
      const {done,value} = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2048) { await reader.cancel(); throw new AcpError('请求过大。') }
      data += decoder.decode(value,{stream:true})
    }
    return JSON.parse(data + decoder.decode()) as Record<string,unknown>
  } finally { reader.releaseLock() }
}

export function registerSetup(ctx: Host, api: Setup) {
  const nonce = randomBytes(32).toString('base64url')
  // DSH owns Host/Origin validation, authentication and owner-only admission
  // for these exact Fetch routes, including the desktop's private transport.
  const stopBootstrap = ctx.connection.fetch.register({
    path:base+'/bootstrap',methods:['GET'],requestBody:'buffered',
    async fetch() { return reply(200,{nonce}) },
  })
  const stopControl = ctx.connection.fetch.register({
    path:base,methods:['POST'],requestBody:'streaming',
    async fetch(req) {
      try {
        if (req.headers.get('x-dsh-external-agents') !== nonce) return reply(403,{error:'请重新打开会话。'})
        if (req.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply(405,{error:'不支持的请求。'})
        const { id, action, key, value } = await parse(req)
        if (typeof id !== 'string' || !id || id.length > 180) throw new AcpError('无效的会话编号。')
        if (action === 'status' || action === 'probe') return reply(200,await api.status(id,action === 'probe'))
        if (action === 'option' && typeof key === 'string') {
          await api.option(id,key,value)
          return reply(200,{ok:true})
        }
        if (action === 'resume' && typeof key === 'number' && Number.isSafeInteger(key)) {
          await api.resume(id,key)
          return reply(200,{ok:true})
        }
        return reply(400,{error:'不支持的操作。'})
      } catch (error) { return reply(400,{error:safeError(error).message}) }
    },
  })
  return async () => { await Promise.all([stopBootstrap(),stopControl()]) }
}
