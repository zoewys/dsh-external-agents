import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/host/index.ts'

async function setup(t, { agentKind = 'codex', registry, args = [], config = {}, permission = 'workspace-write' } = {}) {
  const cwd = await mkdtemp(join(tmpdir(),'dsh-remote-acp-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = cwd
  let dispose
  t.after(async () => {
    try { await dispose?.() } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(cwd,{recursive:true,force:true})
    }
  })

  const provider = 'external-acp-' + agentKind
  const events = []
  const cancellations = []
  const queued = []
  let route, listener, controller, turnBoundary, server
  let mode = permission
  let preset = permission
  let policy = permission === 'danger-full-access' ? 'never' : 'ask'
  const append = (type,data) => {
    const event = {type,data,seq:events.length}
    events.push(event)
    return event
  }
  const agent = {
    id:'external-session', status:'idle', inbox:{nextTurn:queued,nextStep:[]},
    session:{id:'external-session',header:{cwd},get seq(){return events.length},eventAt:seq=>events[seq]},
    model:{current:()=>({provider})}, ctx:{get:name=>name==='skills' ? registry : undefined},
    cancel(cause) { cancellations.push(cause); controller.abort(cause) },
    followup(msg) { queued.push(msg) },
  }
  let adapter
  apply({
    agents:{currentInitiator:()=>agent,get:()=>agent,turnBoundaryOf:()=>turnBoundary},
    llm:{registerAdapter:(_providers,value)=>{adapter=value}},
    sandboxPolicy:{resolve:()=>({mode})},
    permissionPresets:{current:()=>preset},
    approval:{overrideOf:()=>policy},
    webServer:{register:opts=>{route=opts.handler;return ()=>{}}}, connection:{requestRejection:()=>undefined},
    get:()=>undefined,on:(name,fn)=>{if(name==='session/event')listener=fn},
    effect:setup=>{dispose=setup()},
  },{
    injectDshMcp:false,...config,
    commandOverrides:{[agentKind]:{command:process.execPath,args:[fileURLToPath(new URL('./fake-acp.mjs',import.meta.url)),...args]}},
  })

  const runWith = async (onText, ...messages) => {
    const turn = (turnBoundary?.lastTurn ?? 0)+1
    const start = append('turn/start',{turn})
    const step = append('step/start',{turn,step:1})
    turnBoundary = {openTurnStartSeq:start.seq,lastStepBoundary:{kind:'start',seq:step.seq},lastTurn:turn}
    for(const message of messages)append('user/message',message)
    controller=new AbortController()
    agent.status='running'
    try {
      for await(const chunk of adapter.stream({provider,model:'one',sessionId:agent.id,messages,signal:controller.signal})) {
        if(chunk.type==='text-delta') onText?.(chunk.text)
        if(chunk.type==='block-end') return chunk.block.text
      }
    } finally {
      append('turn/end',{turn,reason:controller.signal.aborted ? {kind:'aborted',reason:controller.signal.reason} : {kind:'completed'}})
      agent.status='idle'
      turnBoundary.openTurnStartSeq=null
    }
  }

  return {
    run:(...messages)=>runWith(undefined,...messages),
    catalog:async()=>({provider:adapter.providerInfo(provider),models:await adapter.listModels(provider)}),
    runWith,
    permissions(next) {
      preset=next
      listener(agent.session,append('permission/preset',{preset}))
      mode=next
      listener(agent.session,append('sandbox/mode',{mode}))
      policy=next==='danger-full-access' ? 'never' : 'ask'
      listener(agent.session,append('approval/policy',{policy}))
    },
    async control(action,extra={}) {
      if(!server) {
        server=createServer(route)
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
        t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()}))
      }
      const url='http://127.0.0.1:'+server.address().port+'/api/dsh-external-agents'
      const {nonce}=await fetch(url+'/bootstrap').then(res=>res.json())
      return fetch(url,{method:'POST',headers:{'content-type':'application/json','x-dsh-external-agents':nonce},
        body:JSON.stringify({id:agent.id,action,...extra}),
      }).then(async res=>({ok:res.ok,body:await res.json()}))
    },
    cancellations, queued,
    stop: dispose,
  }
}

test('the DSH adapter forwards a remote task to Codex over ACP', async t => {
  const {run} = await setup(t)
  const task = message('job-1','Reply with a read-only health check.',{kind:'dsh-remote-tasks',eventId:'job-1'})
  const runtime = message('runtime','Host runtime context.',{kind:'runtime-context'})
  assert.equal(await run(task,runtime),JSON.stringify(task.content))
})

for (const agentKind of ['codex','kimi-code']) {
  test('the DSH adapter forwards a native schedule to ' + agentKind, async t => {
    const {run} = await setup(t,{agentKind})
    const task = message('scheduled-message',[
      '[SCHEDULE REMINDER]',
      'This is a scheduled message from the user',
      'schedule_id_json: "schedule-health-check"',
      'occurrence_at: 2026-11-16T08:00:00.000Z',
      'reminder_prompt_json: "Run the scheduled health check."',
    ].join('\n'),{kind:'schedule'})
    const change = message('schedule-change','[SCHEDULE CHANGE]\nA scheduled task was changed outside this session.',{kind:'schedule'})
    const runtime = message('runtime','Host runtime context.',{kind:'runtime-context'})
    assert.equal(await run(change,task,runtime),JSON.stringify(task.content))

    const batch = message('scheduled-batch',[
      '[SCHEDULE REMINDER BATCH]',
      'This is a scheduled message from the user',
      'reminders_json: [{"reminder_prompt":"Run the recurring health check."}]',
    ].join('\n'),{kind:'schedule'})
    assert.equal(await run(change,batch),JSON.stringify(batch.content))
  })
}

function message(id,text,source={kind:'user'}) {
  return {id,role:'user',source,content:[{type:'text',text}]}
}

test('ACP discovers scoped DSH skills and reads only the requested body', async t => {
  const loaded = []
  const catalog = [
    {name:'too-large',description:'Unrelated instructions',invocation:{modelInvocable:true,userInvocable:true}},
    {name:'clarify',description:'Clarify requirements',invocation:{modelInvocable:true,userInvocable:true}},
    {name:'user-only',description:'A manual skill',invocation:{modelInvocable:false,userInvocable:true}},
  ]
  const registry = {
    async list(options) {
      assert.equal(options.scope.id,'external-session')
      return catalog
    },
    async get(name,options) {
      assert.equal(options.scope.id,'external-session')
      loaded.push(name)
      return {...catalog.find(skill=>skill.name===name),content:
        name==='too-large' ? 'large text '.repeat(5000) : 'Read only the selected DSH skill.'}
    },
  }
  const {run,stop} = await setup(t,{registry,args:['skill-tools']})
  assert.equal(await run(message('normal','hello')),JSON.stringify([{type:'text',text:'hello'}]))
  assert.deepEqual(loaded,[])

  const discovered = JSON.parse(await run(message('find','list-dsh-skills')))
  assert.match(discovered.content[0].text,/clarify/)
  assert.doesNotMatch(discovered.content[0].text,/user-only|Read only the selected/)
  assert.deepEqual(loaded,[])

  const skill = JSON.parse(await run(message('find-one','read-dsh-skill clarify')))
  assert.match(skill.content[0].text,/Read only the selected DSH skill/)
  assert.deepEqual(loaded,['clarify'])

  const inaccessible = JSON.parse(await run(message('hidden','read-dsh-skill user-only')))
  assert.equal(inaccessible.isError,true)
  assert.deepEqual(loaded,['clarify'])

  const url = await run(message('endpoint','dsh-skills-endpoint'))
  assert.equal((await fetch(url,{headers:{Origin:'https://example.com'}})).status,403)
  assert.equal((await fetch(new URL('/invalid',url))).status,404)
  const idle = await fetch(url,{
    method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'read_dsh_skill',arguments:{name:'clarify'}}}),
  }).then(response=>response.json())
  assert.equal(idle.result.isError,true)
  assert.deepEqual(loaded,['clarify'])
  await stop()
  await assert.rejects(fetch(url),/fetch failed/)
})

test('an explicit DSH skill invocation includes its body in the current ACP turn', async t => {
  const {run} = await setup(t,{config:{injectDshSkills:false}})
  const request = message('request','Use the selected skill.')
  const invocation = message('skill','<skill_content>Manually supplied body</skill_content>',{
    kind:'skill-invocation',name:'clarify',form:'instructions',
  })
  const reply = JSON.parse(await run(request,invocation))
  assert.deepEqual(reply,[...request.content,...invocation.content])
})


test('widening Kimi permissions during generation applies to the same turn', async t => {
  const {runWith,permissions,cancellations}=await setup(t,{agentKind:'kimi-code'})
  const reply=await runWith(text=>{
    if(text.includes('started:')) permissions('danger-full-access')
  },message('open','hold-mode'))
  assert.match(reply,/started:default/)
  assert.match(reply,/finished:yolo/)
  assert.deepEqual(cancellations,[])
})

test('widening Codex permissions during generation takes effect at the next turn', async t => {
  const {runWith,permissions,control,run,cancellations}=await setup(t)
  let status
  const reply=await runWith(text=>{
    if(text.includes('started:')) {
      permissions('danger-full-access')
      status=control('status')
    }
  },message('open','hold-mode'))
  assert.match(reply,/started:workspace-write/)
  assert.match(reply,/finished:workspace-write/)
  assert.equal((await status).body.permissionUpdate,'next-turn')
  assert.equal(await run(message('next','report-mode')),'agent-full-access')
  assert.deepEqual(cancellations,[])
})

test('if Kimi rejects a live widening, the current turn finishes and the next adopts it', async t => {
  const {runWith,permissions,control,run,cancellations}=await setup(t,{agentKind:'kimi-code',args:['reject-live-mode']})
  const reply=await runWith(text=>{
    if(text.includes('started:')) permissions('danger-full-access')
  },message('open','hold-mode'))
  assert.match(reply,/finished:default/)
  assert.deepEqual(cancellations,[])
  assert.equal((await control('status')).body.permissionUpdate,'next-turn')
  assert.equal(await run(message('next','report-mode')),'yolo')
})

test('repeated permission events do not interrupt a turn when the execution rights are unchanged', async t => {
  const {runWith,permissions,cancellations}=await setup(t,{agentKind:'kimi-code'})
  const reply=await runWith(text=>{
    if(text.includes('started:')) permissions('workspace-write')
  },message('open','hold-mode'))
  assert.match(reply,/finished:default/)
  assert.deepEqual(cancellations,[])
})

test('tightening permissions stops the old mode and exposes a one-time continuation', async t => {
  const {runWith,permissions,control,queued,cancellations,run}=await setup(t,{agentKind:'kimi-code',permission:'danger-full-access'})
  const read = runWith(text=>{
    if(text.includes('started:')) permissions('workspace-write')
  },message('open','hold-mode'))
  await assert.rejects(read,{kind:'hook'})
  assert.equal(cancellations.length,1)
  const status=(await control('status')).body
  assert.equal(status.permissionUpdate,'paused')
  assert.ok(Number.isInteger(status.permissionPause))
  assert.equal((await control('resume',{key:status.permissionPause})).ok,true)
  assert.equal((await control('resume',{key:status.permissionPause})).ok,false)
  assert.equal(queued.length,1)
  assert.match(queued[0].content[0].text,/当前权限/)
  assert.equal(await run(message('next','report-mode')),'default')
})


test('native model catalog marks the default and advertised models as external-agent models', async t => {
  const {catalog}=await setup(t)
  const {provider,models}=await catalog()
  assert.deepEqual(provider,{id:'external-acp-codex',name:'外部 Agent · Codex'})
  assert.deepEqual(models.map(model=>model.id),['@default','one','two'])
  for(const model of models) {
    assert.equal(model.provider,provider.id)
    assert.deepEqual(model.badge,{text:{zh:'外部 Agent',en:'External Agent'},tone:'info'})
  }
})

test('saving a skill setting applies on the next turn of an existing external session', async t => {
  let enabled=true
  const registry={
    list:async()=>[{name:'clarify',description:'Clarify requirements',invocation:{modelInvocable:true}}],
  }
  const {run}=await setup(t,{registry,args:['skill-tools'],config:{injectDshSkills:{get:()=>enabled}}})
  const original=JSON.parse(await run(message('discover','list-dsh-skills')))
  assert.match(original.content[0].text,/clarify/)
  enabled=false
  const reopened=await run(message('discover-again','list-dsh-skills'))
  assert.match(reopened,/no DSH skill endpoint/)
})
