import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerSetup } from '../src/host/setup.ts'
import { Context } from '@deepseek-ai/cordis'
import { ConnectionAuthentication, HostConnectionService } from '@deepseek-ai/dsh-client-connection'

test('setup uses DSH 0.2.3 authenticated owner-only Fetch routes and keeps nonce/body checks', async () => {
  const routes = new Map()
  let statusCalls = 0
  const stop = registerSetup({connection:{fetch:{register(route) {
    routes.set(route.path,route)
    return async()=>{routes.delete(route.path)}
  }}}},{status:async(id,refresh)=>{statusCalls++;return {id,refresh}},option:async()=>{},resume:async()=>{}})
  assert.deepEqual([...routes.keys()],['/api/dsh-external-agents/bootstrap','/api/dsh-external-agents'])
  const bootstrap = routes.get('/api/dsh-external-agents/bootstrap')
  const controls = routes.get('/api/dsh-external-agents')
  assert.deepEqual(bootstrap.methods,['GET'])
  assert.deepEqual(controls.methods,['POST'])
  assert.equal(controls.requestBody,'streaming')
  const bootResponse = await bootstrap.fetch(new Request('http://localhost'+bootstrap.path))
  assert.equal(bootResponse.headers.get('cache-control'),'no-store')
  const {nonce} = await bootResponse.json()
  const send = (body, headers={})=>controls.fetch(new Request('http://localhost'+controls.path,{
    method:'POST',headers:{'content-type':'application/json',...headers},body,
  }))
  assert.equal((await send('{}')).status,403)
  assert.equal((await send('{}',{'x-dsh-external-agents':'wrong'})).status,403)
  const headers = {'x-dsh-external-agents':nonce}
  assert.equal((await send('{',headers)).status,400)
  assert.equal((await send('x'.repeat(2049),headers)).status,400)
  assert.equal((await send('{}',{...headers,'content-type':'text/plain'})).status,405)
  const response = await send(JSON.stringify({id:'test',action:'probe'}),headers)
  assert.equal(response.status,200)
  assert.deepEqual(await response.json(),{id:'test',refresh:true})
  assert.equal(statusCalls,1)
  await stop()
  assert.equal(routes.size,0)
})

test('real DSH Connection rejects unauthenticated, cross-origin and non-owner setup access', async t => {
  const ctx = new Context()
  const authentication = new ConnectionAuthentication(ctx)
  const connection = new HostConnectionService(ctx,[])
  t.after(()=>ctx.fiber.dispose())
  authentication.register({authenticate(request) {
    return request.headers['x-test-owner'] === 'yes' ? connection.browserPeer : undefined
  }})
  const stop = registerSetup(ctx,{status:async()=>({ready:true}),option:async()=>{},resume:async()=>{}})
  t.after(stop)
  const headers = {host:'localhost','x-test-owner':'yes'}
  assert.equal(connection.admit({headers:{host:'localhost'}}).rejection,401)
  for (const unsafe of [{origin:'https://example.com'},{'sec-fetch-site':'cross-site'},{host:'example.com'}]) {
    assert.equal(connection.admit({headers:{...headers,...unsafe}}).rejection,403)
  }
  const admission = connection.admit({headers})
  assert.ok(!('rejection' in admission))
  const handler = connection.createSharedFetchHandler('/api')
  const request = new Request('http://localhost/api/dsh-external-agents/bootstrap')
  assert.equal((await handler.fetch(request,admission.peer)).status,200)
  assert.equal((await handler.fetch(request,{principal:{kind:'guest'}})).status,403)
})
