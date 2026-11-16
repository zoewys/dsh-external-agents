import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ExternalAgentDriver } from '../src/driver/external-agent-driver.ts'
import { bindingStore } from '../src/host/binding-store.ts'
import { parseConfig } from '../src/host/profiles.ts'

const fixture = fileURLToPath(new URL('./fake-acp.mjs',import.meta.url))
async function setup(t, extra=[]) {
  const cwd = await mkdtemp(join(tmpdir(),'external-agents-'))
  const command = {command:process.execPath,args:[fixture,...extra]}
  const store = bindingStore(join(cwd,'state'))
  const make = () => {
    const driver = new ExternalAgentDriver(parseConfig({commandOverrides:{'kimi-code':command,codex:command}}),store)
    t.after(()=>driver.close())
    return driver
  }
  t.after(()=>rm(cwd,{recursive:true,force:true}))
  const notices = []
  const request = {id:'DSH / session',agent:'kimi-code',cwd,securityMode:'default',model:'one',
    summary:'earlier exchange',signal:new AbortController().signal,
    injection:()=>({entries:{},notices:[]}),notice:text=>notices.push(text)}
  return {make,store,request,notices}
}
function turn(signal,updates=[]) {
  return {signal,update:e=>updates.push(e),
    permission: async ()=>({outcome:{outcome:'selected',optionId:'no'}}),
    question:async()=>({action:'cancel'})}
}
const text = text => [{type:'text',text}]

test('probe distinguishes a CLI that advertises auth from one that requires login',async t=>{
  const {make,request} = await setup(t)
  const clean = make()
  assert.equal((await clean.probe('kimi-code',request.cwd)).readiness.status,'ready')
  const {make:out,request:other} = await setup(t,['logged-out'])
  assert.equal((await out().probe('kimi-code',other.cwd)).readiness.status,'not_logged_in')
  const runner = new ExternalAgentDriver(parseConfig({commandOverrides:{codex:{command:'/missing-codex-acp',args:[]}}}), bindingStore(other.cwd))
  t.after(()=>runner.close())
  assert.equal((await runner.probe('codex',other.cwd)).readiness.status,'not_installed')
})

test('ACP persists across turns and resumes on a new driver without replaying DSH history',async t=>{
  const {make,request,store} = await setup(t)
  const one = make()
  const a = await one.prepare(request)
  const updates = []
  await one.prompt(a,turn(request.signal,updates),text('first'),'m1')
  assert.match(updates[0].content.text,/earlier exchange/)
  assert.equal((await one.prepare({...request,model:'two'})).binding.acpSessionId,a.binding.acpSessionId)
  assert.equal(a.options.find(x=>x.category==='model').currentValue,'two')
  await one.prompt(a,turn(request.signal,updates),text('second'),'m2')
  assert.doesNotMatch(updates[1].content.text,/earlier exchange/)
  const id = a.binding.acpSessionId
  await one.close()
  const two = make()
  const resumed = await two.prepare({...request,model:'two'})
  assert.equal(resumed.binding.acpSessionId,id)
  await two.prompt(resumed,turn(request.signal,updates),text('third'),'m3')
  assert.match(updates[2].content.text,/third/)
  assert.equal((await store.get(request.id)).sentThrough,'m3')
})

test('missing resume capability degrades clearly and a cross-agent switch keeps the DSH id',async t=>{
  const {make,request,notices} = await setup(t,['no-resume'])
  const first = make()
  const a = await first.prepare(request)
  await first.close()
  const second = make()
  const b = await second.prepare(request)
  assert.notEqual(b.binding.acpSessionId,a.binding.acpSessionId)
  assert.match(notices.join(' '),/无法恢复/)
  const switched = await second.prepare({...request,agent:'codex'})
  assert.equal(switched.binding.dshSessionId,request.id)
  assert.notEqual(switched.binding.acpSessionId,b.binding.acpSessionId)
  assert.match(notices.join(' '),/内部记忆/)
})

test('ACP reverse permission and cancellation settle through the real stdio connection',async t=>{
  const {make,request} = await setup(t)
  const driver = make()
  const a = await driver.prepare(request)
  assert.equal((await driver.prompt(a,turn(request.signal),text('approval'),'m1')).stopReason,'end_turn')
  const abort = new AbortController()
  const pending = driver.prompt(a,turn(abort.signal),text('cancel'),'m2')
  const timer = setTimeout(()=>abort.abort(),100)
  t.after(()=>clearTimeout(timer))
  await assert.rejects(pending,{name:'AbortError'})
  assert.equal((await driver.prompt(a,turn(request.signal),text('later'),'m3')).stopReason,'end_turn')
})

test('a failed hot model switch replaces the ACP session and keeps context',async t=>{
  const {make,request,notices} = await setup(t,['cold-model'])
  const driver = make()
  const first = await driver.prepare(request)
  await driver.prompt(first,turn(request.signal),text('first'),'m1')
  const next = await driver.prepare({...request,model:'two'})
  assert.notEqual(next.binding.acpSessionId,first.binding.acpSessionId)
  assert.equal(next.options.find(option=>option.id==='model').currentValue,'two')
  assert.match(notices.join(' '),/新会话/)
})

test('a conflicting mode readback prevents the first prompt',async t=>{
  const {make,request} = await setup(t,['ignore-mode'])
  await assert.rejects(make().prepare({...request,securityMode:'yolo'}),/确认.*权限/)
})

test('releasing a live ACP session also withdraws its pending host approval',async t=>{
  const {make,request} = await setup(t)
  const driver = make()
  const live = await driver.prepare(request)
  const waiting = Promise.withResolvers()
  let cancelled = false
  const pending = driver.prompt(live,{
    ...turn(request.signal),permission:async (_req,signal)=>{
      waiting.resolve()
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
      cancelled = true
      return {outcome:{outcome:'cancelled'}}
    },
  },text('approval'),'m1')
  const settled = assert.rejects(pending)
  await waiting.promise
  await driver.release(request.id)
  await settled
  assert.equal(cancelled,true)
  assert.equal(driver.current(request.id),undefined)
})

test('a CLI that exits before ACP init returns a usable detection error',async t=>{
  const {request,store} = await setup(t)
  const broken = new ExternalAgentDriver(parseConfig({commandOverrides:{codex:{command:'/bin/sh',args:['-c','exit 23']}}}),store)
  t.after(()=>broken.close())
  const result = await broken.probe('codex',request.cwd)
  assert.equal(result.readiness.status,'error')
  assert.match(result.readiness.message,/无法与外部 Agent 通信/)
})

test('a legacy binding opens a clean ACP session once and preserves the DSH history',async t=>{
  const {make,store,request,notices} = await setup(t)
  const driver = make()
  const legacy = await driver.prepare(request)
  const binding = {...legacy.binding}
  delete binding.skillProtocol
  await driver.close()
  await store.save(binding)

  const upgradedDriver = make()
  const upgraded = await upgradedDriver.prepare(request)
  assert.notEqual(upgraded.binding.acpSessionId,binding.acpSessionId)
  assert.equal(upgraded.binding.dshSessionId,request.id)
  assert.match(notices.join(' '),/按需/)
  assert.equal((await store.get(request.id)).acpSessionId,binding.acpSessionId)
  const updates = []
  await upgradedDriver.prompt(upgraded,turn(request.signal,updates),text('continue'),'m2')
  assert.match(updates[0].content.text,/earlier exchange/)
  await upgradedDriver.close()

  const resumed = await make().prepare(request)
  assert.equal(resumed.binding.acpSessionId,upgraded.binding.acpSessionId)
})
