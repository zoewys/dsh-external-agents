import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Host } from './dsh.ts'
import { AcpError, safeError } from '../acp/client.ts'

const base = '/api/dsh-external-agents'
interface Setup {
  status(id: string, refresh: boolean): Promise<unknown>
  option(id: string, key: string, value: unknown): Promise<void>
  resume(id: string, pause: number): Promise<void>
}

function reply(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'})
  res.end(JSON.stringify(data))
}

async function parse(req: IncomingMessage) {
  let data = ''
  for await (const chunk of req) {
    data += String(chunk)
    if (data.length > 2048) throw new AcpError('请求过大。')
  }
  return JSON.parse(data) as Record<string,unknown>
}

export function registerSetup(ctx: Host, api: Setup) {
  const nonce = randomBytes(32).toString('base64url')
  return ctx.webServer.register({kind:'prefix',path:base,async handler(req,res) {
    try {
      const rejected = ctx.connection.requestRejection(req)
      if (rejected || req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
        reply(res,rejected || 403,{error:'DSH 拒绝了这个请求。'})
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === base + '/bootstrap') { reply(res,200,{nonce}); return }
      if (req.headers['x-dsh-external-agents'] !== nonce) { reply(res,403,{error:'请重新打开会话。'}); return }
      if (req.method !== 'POST' || url.pathname !== base || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        reply(res,405,{error:'不支持的请求。'}); return
      }
      const { id, action, key, value } = await parse(req)
      if (typeof id !== 'string' || !id || id.length > 180) throw new AcpError('无效的会话编号。')
      if (action === 'status' || action === 'probe') reply(res,200,await api.status(id,action === 'probe'))
      else if (action === 'option' && typeof key === 'string') {
        await api.option(id,key,value)
        reply(res,200,{ok:true})
      } else if (action === 'resume' && typeof key === 'number' && Number.isSafeInteger(key)) {
        await api.resume(id,key)
        reply(res,200,{ok:true})
      } else reply(res,400,{error:'不支持的操作。'})
    } catch (error) {
      if (!res.headersSent) reply(res,400,{error:safeError(error).message})
    }
  }})
}
