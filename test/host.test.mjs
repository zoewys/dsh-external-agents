import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../src/host/index.ts'

async function setup(t, { agentKind = 'codex', model = 'one', registry, args = [], config = {}, permission = 'workspace-write', captureFinish = false, child = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(),'dsh-remote-acp-'))
  let workingDirectory = cwd
  const previousHome = process.env.DSH_HOME
  const previousKimiHome = process.env.KIMI_CODE_HOME
  process.env.DSH_HOME = cwd
  if (args.includes('kimi-quota-log')) process.env.KIMI_CODE_HOME = join(cwd,'kimi')
  let dispose
  t.after(async () => {
    try { await dispose?.() } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = previousKimiHome
      await rm(cwd,{recursive:true,force:true})
    }
  })

  const provider = 'external-acp-' + agentKind
  const events = []
  const cancellations = []
  const diagnostics = []
  const queued = []
  let route, listener, assemble, systemPrompt, disposeAgent, controller, turnBoundary, server
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
    session:{id:'external-session',header:{cwd,...child && {origin:'subagent',delegationDepth:1,parentSession:'parent'}},
      append,get seq(){return events.length},eventAt:seq=>events[seq]},
    model:{current:()=>({provider})}, ctx:{get:name=>name==='skills' ? registry : undefined},
    cancel(cause) { cancellations.push(cause); controller.abort(cause) },
    followup(msg) { queued.push(msg) },
  }
  let adapter
  apply({
    agents:{currentInitiator:()=>agent,get:()=>agent,turnBoundaryOf:()=>turnBoundary},
    workingDirectory:{ensure:async()=>workingDirectory},
    llm:{registerAdapter:(_providers,value)=>{adapter=value}},
    sandboxPolicy:{resolve:()=>({mode})},
    permissionPresets:{current:()=>preset},
    approval:{overrideOf:()=>policy},
    logger:{warn:message=>diagnostics.push(message)},
    webServer:{register:opts=>{route=opts.handler;return ()=>{}}}, connection:{requestRejection:()=>undefined},
    get:()=>undefined,on(name,fn) {
      if (name==='session/event') listener=fn
      if (name==='system-prompt/assemble') assemble=fn
      if (name==='agent/disposed') disposeAgent=fn
    },
    effect:setup=>{dispose=setup()},
  },{
    injectDshMcp:false,...config,
    commandOverrides:{[agentKind]:{command:process.execPath,args:[fileURLToPath(new URL('./fake-acp.mjs',import.meta.url)),...args]}},
  })

  const runWith = async (onText, ...messages) => {
    const history = events.filter(event=>event.type==='user/message').map(event=>event.data)
    const turn = (turnBoundary?.lastTurn ?? 0)+1
    const start = append('turn/start',{turn})
    const step = append('step/start',{turn,step:1})
    turnBoundary = {openTurnStartSeq:start.seq,lastStepBoundary:{kind:'start',seq:step.seq},lastTurn:turn}
    for(const message of messages)append('user/message',message)
    controller=new AbortController()
    agent.status='running'
    try {
      const requestMessages = [...(systemPrompt ? [systemPrompt] : []),...history,...messages]
      for await(const chunk of adapter.stream({provider,model,sessionId:agent.id,messages:requestMessages,signal:controller.signal})) {
        if(chunk.type==='text-delta') onText?.(chunk.text)
        if(captureFinish && chunk.type==='finish') return chunk.reason
        if(!captureFinish && chunk.type==='block-end') return chunk.block.text
      }
    } finally {
      append('turn/end',{turn,reason:controller.signal.aborted ? {kind:'aborted',reason:controller.signal.reason} : {kind:'completed'}})
      agent.status='idle'
      turnBoundary.openTurnStartSeq=null
    }
  }

  return {
    run:(...messages)=>runWith(undefined,...messages),
    assembleRole: async (complete = false) => {
      const presentation = {
        sections:[{name:'deployment:persona-prefix',text:'Review only for {{role}}.'},
          {name:'deployment:persona-suffix',text:'Lead with the verdict.'},
          {name:'tool:bash',text:'Reserved DSH tool instructions.'}],
        contexts:[],variables:{role:'correctness'},
      }
      await assemble?.(presentation,{agent,modelSelection:{provider,model:'one'}},async()=>presentation)
      systemPrompt = {role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:complete
        ? 'Review only for correctness.'
        : 'Review only for correctness.\n\nReserved DSH tool instructions.\n\nLead with the verdict.'}]}
    },
    disposeAgent:()=>disposeAgent({agent}),
    cwd, setWorkingDirectory:directory=>{workingDirectory=directory},
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
    cancellations, diagnostics, events, queued,
    stop: dispose,
  }
}

test('the DSH adapter forwards a remote task to Codex over ACP', async t => {
  const {run} = await setup(t)
  const task = message('job-1','Reply with a read-only health check.',{kind:'dsh-remote-tasks',eventId:'job-1'})
  const runtime = message('runtime','Host runtime context.',{kind:'runtime-context'})
  assert.equal(await run(task,runtime),JSON.stringify(task.content))
})

test('Antigravity appears in the native menu with only Gemini models and chats with default permissions', async t => {
  const {run,catalog}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity'],permission:'danger-full-access'})
  const menu=await catalog()
  assert.equal(menu.provider.name,'外部 Agent · Antigravity')
  assert.deepEqual(menu.models.map(model=>model.id),['@default','gemini-test','gemini-next'])
  assert.equal(await run(message('mode','report-mode')),'default')
  assert.equal(await run(message('next','Hello Google.')),JSON.stringify(message('next','Hello Google.').content))
})

test('Antigravity keeps plan permissions for a read-only DSH conversation', async t => {
  const {run}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity'],permission:'read-only'})
  assert.equal(await run(message('plan','report-mode')),'plan')
})

test('Antigravity selects Gemini when its cached CLI default is a partner model', async t => {
  const {run,control}=await setup(t,{agentKind:'antigravity',model:'@default',args:['antigravity','partner-default']})
  await run(message('hello','Hello Google.'))
  const state=(await control('status')).body
  assert.equal(state.options.find(option=>option.category==='model').currentValue,'gemini-test')
})

test('Antigravity completes a delegated turn with a final result and stop signal', async t => {
  const {runWith,control,events}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity'],child:true,captureFinish:true})
  let result=''
  const finish=await runWith(text=>{result+=text},
    message('task','Return the delegated result.',{kind:'agent-message',form:'relay',senderSessionId:'parent'}))
  assert.match(result,/Return the delegated result/)
  assert.equal(finish.kind,'stop')
  assert.equal(events.at(-1).type,'turn/end')
  assert.equal(events.at(-1).data.reason.kind,'completed')
  const state=(await control('status')).body
  assert.equal(state.running,false)
  assert.notEqual(state.pending,true)
  assert.equal(state.error,undefined)
  assert.equal(state.idleWarning,undefined)
})

test('Antigravity denies a restricted child approval without waiting for a user', async t => {
  const {run}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity'],child:true,captureFinish:true})
  // The fixture ends without a final answer after its approval is denied.
  assert.equal((await run(message('approval','approval'))).failure.code,'EXTERNAL_AGENT_EMPTY_RESULT')
})

test('Antigravity reports an empty delegated reply as an error instead of a successful result', async t => {
  const {run,control}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity'],child:true,captureFinish:true})
  const finish=await run(message('empty','empty-reply'))
  assert.equal(finish.kind,'error')
  assert.equal(finish.failure.code,'EXTERNAL_AGENT_EMPTY_RESULT')
  assert.match(finish.failure.message,/未返回最终回复/)
  assert.match((await control('status')).body.error,/未返回最终回复/)
})

test('Antigravity does not treat a top-level relay as a delegated task', async t => {
  const {run}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity']})
  await assert.rejects(run(message('relay','A child notification.',{kind:'agent-message',form:'relay',senderSessionId:'child'})),/仅支持.*直接/)
})

test('Antigravity reads DSH skills from the effective delegated workspace', async t => {
  let directory
  const registry={
    async list(options) {
      assert.equal(options.cwd,directory)
      assert.equal(options.scope.id,'external-session')
      return [{name:'delegated-skill',description:'A workspace skill',invocation:{modelInvocable:true}}]
    },
    async get(name,options) {
      assert.equal(options.cwd,directory)
      assert.equal(options.scope.id,'external-session')
      return {name,invocation:{modelInvocable:true},content:'Body from the delegated workspace.'}
    },
  }
  const {run,cwd,setWorkingDirectory}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity','skill-tools'],child:true,registry})
  directory=join(cwd,'skill-workspace')
  await mkdir(directory)
  setWorkingDirectory(directory)
  assert.match(JSON.parse(await run(message('list','list-dsh-skills'))).content[0].text,/delegated-skill/)
  assert.match(JSON.parse(await run(message('read','read-dsh-skill delegated-skill'))).content[0].text,/Body from the delegated workspace/)
})

test('Antigravity rejects automated remote tasks and schedules while allowing manual skill invocation', async t => {
  const {run}=await setup(t,{agentKind:'antigravity',model:'gemini-test',args:['antigravity']})
  await assert.rejects(run(message('remote','Automated task.',{kind:'dsh-remote-tasks'})),/仅支持.*直接/)
  await assert.rejects(run(message('timer','[SCHEDULE REMINDER]\nAutomated task.',{kind:'schedule'})),/仅支持.*直接/)
  const skill=message('skill','Manually selected skill body.',{kind:'skill-invocation'})
  assert.deepEqual(JSON.parse(await run(skill)).slice(-1),skill.content)
})

for (const agentKind of ['kimi-code','codex','antigravity']) {
  test(agentKind+' starts ACP in the effective child directory instead of its original session directory', async t => {
    const antigravity=agentKind==='antigravity'
    const {run,cwd,setWorkingDirectory}=await setup(t,{agentKind,child:true,
      args:antigravity?['antigravity']:[],model:antigravity?'gemini-test':'one'})
    const directory=join(cwd,'delegated-workspace')
    await mkdir(directory)
    setWorkingDirectory(directory)
    const reply=await run(message('cwd','report-cwd'))
    assert.deepEqual(JSON.parse(reply),{processCwd:await realpath(directory),sessionCwd:directory})
  })

  test(agentKind+' receives the DSH child role, first task and later messages', async t => {
    const {run,assembleRole,disposeAgent} = await setup(t,{agentKind,child:true,
      args:['no-resume',...agentKind==='antigravity'?['antigravity']:[]],model:agentKind==='antigravity'?'gemini-test':'one'})
    const task = message('task','Audit the first patch.',{kind:'agent-message',form:'relay',senderSessionId:'parent'})
    const followup = message('relay','Also check the second patch.',{kind:'agent-message',form:'relay',senderSessionId:'parent'})
    const runtime = message('runtime','Reserved DSH runtime data.',{kind:'runtime-context'})
    await assembleRole()
    const initial = await run(task,runtime)
    assert.match(initial,/Review only for correctness/)
    assert.match(initial,/Lead with the verdict/)
    assert.match(initial,/Audit the first patch/)
    assert.doesNotMatch(initial,/Reserved DSH/)

    const next = await run(followup)
    assert.match(next,/Also check the second patch/)
    assert.doesNotMatch(next,/Audit the first patch/)
    await disposeAgent()
    await assembleRole()
    const afterRestore = await run(message('restored','Send the final verdict.',{kind:'agent-message',form:'relay',senderSessionId:'parent'}))
    assert.match(afterRestore,/Review only for correctness/)
    assert.match(afterRestore,/Also check the second patch/)
    assert.match(afterRestore,/Send the final verdict/)
  })
}

test('a top-level external Agent turn keeps DSH-only messages out of ACP', async t => {
  const {run,assembleRole} = await setup(t)
  await assembleRole()
  const input = message('user','Only this input.')
  const relay = message('relay','Another agent message.',{kind:'agent-message',form:'relay',senderSessionId:'child'})
  assert.equal(await run(input,relay),JSON.stringify(input.content))
})

test('a complete DSH child persona suppresses inactive role sections', async t => {
  const {run,assembleRole} = await setup(t,{child:true})
  await assembleRole(true)
  const output = await run(message('task','Review the patch.'))
  assert.match(output,/Review only for correctness/)
  assert.doesNotMatch(output,/Lead with the verdict/)
})

test('a long-running tool reaches the idle reminder and finishes beyond the old turn limit', async t => {
  const setTimer = globalThis.setTimeout
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>setTimer(callback,ms===120_000 ? 30 : ms,...args))
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal,'timeout',ms=>timeout(ms===60_000 ? 100 : ms))
  const {run,control,cancellations,events} = await setup(t,{config:{turnTimeoutMinutes:1,idleWarningMinutes:{get:()=>2}}})
  const running = run(message('slow','hold-tool'))
  let warning
  for (let i = 0; i < 20 && !warning; i++) {
    warning = (await control('status')).body.idleWarning
    if (!warning) await delay(15)
  }
  assert.match(warning,/等待外部工具返回/)
  assert.equal(await running,'tool finished')
  const call = events.find(event => event.type === 'tool/call')
  const result = events.find(event => event.type === 'tool/result')
  assert.ok(call && result, 'the tool call and result are both written to the DSH session')
  assert.equal(result.data.message.toolCallId,call.data.callId)
  assert.equal(result.data.message.isError,false)
  assert.equal((await control('status')).body.idleWarning,undefined)
  assert.deepEqual(cancellations,[])
})

test('an ACP process exit emits a resumable disconnection and the next turn can run', async t => {
  const {run,cancellations} = await setup(t,{captureFinish:true})
  const first = await run(message('disconnect','disconnect'))
  assert.equal(first.kind,'error')
  assert.equal(first.failure.code,'EXTERNAL_AGENT_CONNECTION_LOST')
  assert.equal((await run(message('next','report-mode'))).kind,'stop')
  assert.deepEqual(cancellations,[])
})

test('Kimi quota exhaustion is a typed failure even when ACP finishes with an empty end_turn', async t => {
  const {run,control} = await setup(t,{agentKind:'kimi-code',child:true,captureFinish:true,args:['kimi-quota-log']})
  assert.equal((await run(message('stale','stale-quota'))).kind,'stop')
  const result = await run(message('quota','quota'))
  assert.equal(result.kind,'error')
  assert.equal(result.failure.code,'EXTERNAL_AGENT_QUOTA_EXHAUSTED')
  assert.equal(result.failure.status,429)
  assert.match(result.failure.message,/5 小时.*用量上限/)
  assert.doesNotMatch(result.failure.message,/private-log-text/)
  assert.match((await control('status')).body.error,/用量上限/)
})

test('DSH diagnostics retain known CLI failure codes without stderr contents', async t => {
  const {run,diagnostics,events} = await setup(t,{captureFinish:true})
  const finish = await run(message('diagnostics','diagnostic-error'))
  assert.equal(finish.failure.code,'EXTERNAL_AGENT_CONNECTION_LOST')
  // The transport can close before Node delivers the process exit event.
  for (let i = 0; i < 20 && diagnostics.length < 3; i++) await delay(10)
  assert.deepEqual([...diagnostics].sort(),[
    'Codex ACP: CLI exited (code 23).',
    'Codex ACP: CLI stderr reported ECONNRESET.',
    'Codex ACP: CLI stderr reported ENOTFOUND.',
  ])
  assert.doesNotMatch(JSON.stringify(events),/fixture-secret|untrusted stderr/)
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
