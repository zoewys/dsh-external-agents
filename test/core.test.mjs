import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childEnvironment, parseConfig, resolveCommand } from '../src/host/profiles.ts'
import { permissionChoice, posture } from '../src/host/permissions.ts'
import { mcpPayload } from '../src/host/injection.ts'
import { summarize } from '../src/driver/context.ts'

test('only a known unrestricted preset can auto grant', () => {
  const options = [{kind:'allow_always',optionId:'always'},{kind:'allow_once',optionId:'yes'}]
  assert.equal(posture('danger-full-access','auto','ask'),'restricted')
  assert.equal(posture('danger-full-access','danger-full-access','never'),'full_open')
  assert.equal(posture('workspace-write','danger-full-access','never'),'restricted')
  assert.equal(permissionChoice(options,true)?.optionId,'yes')
  assert.equal(permissionChoice(options.slice(0,1),true),undefined)
})
test('config rejects credentials and MCP never forwards secrets or an incompatible working directory', () => {
  assert.throws(() => parseConfig({apiKey:'abc'}))
  const result = mcpPayload({
    local:{transport:'stdio',command:'example',args:[]},
    remote:{transport:'streamable-http',url:'https://example.com/mcp',headers:{Authorization:'abc'}},
    custom:{transport:'stdio',command:'example',cwd:'/different'},
  },{http:true},'/workspace')
  assert.deepEqual(result.servers,[{name:'local',command:'example',args:[],env:[]}])
  assert.deepEqual(result.failed,['remote','custom'])
})

test('new Codex sessions use the local provider by default and honor explicit HTTPS mode', () => {
  const defaultConfig = JSON.parse(childEnvironment('codex',parseConfig({}).codexTransport).CODEX_CONFIG)
  assert.equal(defaultConfig.model_provider,undefined)
  assert.equal(defaultConfig.model_providers,undefined)

  const httpsConfig = JSON.parse(childEnvironment('codex',parseConfig({codexTransport:'https'}).codexTransport).CODEX_CONFIG)
  assert.equal(httpsConfig.model_provider,'dsh-openai-http')
  assert.equal(httpsConfig.model_providers['dsh-openai-http'].supports_websockets,false)
})

test('Antigravity has its own ACP route and accepts a custom executable', async () => {
  const command = {command:process.execPath,args:['acp','--process-per-session']}
  const config = parseConfig({commandOverrides:{antigravity:command}})
  assert.deepEqual(await resolveCommand('antigravity',config),command)
})

test('Antigravity reuses local Google login without inherited API or Cloud credentials', t => {
  const keys = ['GEMINI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENAI_USE_VERTEXAI','GOOGLE_GENAI_USE_GCA','GOOGLE_APPLICATION_CREDENTIALS']
  const before = Object.fromEntries(keys.map(key=>[key,process.env[key]]))
  t.after(()=>{for(const key of keys) {
    if(before[key]===undefined) delete process.env[key]
    else process.env[key]=before[key]
  }})
  for(const key of keys) process.env[key]='inherited-test-value'
  const env = childEnvironment('antigravity','native')
  for(const key of keys) assert.equal(env[key],undefined,key)
  assert.equal(childEnvironment('kimi-code','native').GEMINI_API_KEY,'inherited-test-value')
})

test('Antigravity maps read-only to plan and keeps native approval requests in executable modes', async () => {
  const {executionPermissions} = await import('../src/host/interactions.ts')
  let mode='workspace-write'
  const ctx={sandboxPolicy:{resolve:()=>({mode})},approval:{overrideOf:()=>mode==='danger-full-access'?'never':'ask'},permissionPresets:{current:()=>mode}}
  const agent={session:{header:{}}}
  assert.deepEqual(executionPermissions(ctx,agent,'antigravity',false),{mode:'default',level:1,approval:'ask'})
  mode='danger-full-access'
  assert.deepEqual(executionPermissions(ctx,agent,'antigravity',false),{mode:'default',level:2,approval:'allow'})
  assert.deepEqual(executionPermissions(ctx,agent,'antigravity',true),{mode:'plan',level:0,approval:'deny'})
  mode='read-only'
  assert.deepEqual(executionPermissions(ctx,agent,'antigravity',false),{mode:'plan',level:0,approval:'deny'})
})

test('Antigravity defers permission widening even when both presets use the same ACP mode', async () => {
  const {watchPermissions}=await import('../src/host/permission-update.ts')
  let current={mode:'default',level:1,approval:'ask'}
  let deferred=false
  let paused=false
  const watch=watchPermissions({initial:current,read:()=>current,signal:new AbortController().signal,
    deferred:value=>{deferred=value},pause:()=>{paused=true}})
  current={mode:'default',level:2,approval:'allow'}
  watch.schedule()
  await Promise.resolve()
  assert.equal(deferred,true)
  assert.equal(watch.approval(),'ask')
  current={mode:'default',level:1,approval:'ask'}
  watch.schedule()
  await Promise.resolve()
  assert.equal(deferred,false)
  assert.equal(paused,false)
  watch.stop()
})
test('handoff excludes DSH instructions, reasoning, and raw tool output', () => {
  const data = [
    {role:'user',source:{kind:'user'},content:[{type:'text',text:'Fix x'}]},
    {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'internal'}]},
    {role:'assistant',content:[{type:'reasoning',text:'private'},{type:'text',text:'Fixed x'}]},
    {role:'tool',content:[{type:'text',text:'raw output'}]},
  ]
  const summary = summarize(data)
  assert.match(summary,/Fix x/)
  assert.match(summary,/Fixed x/)
  assert.doesNotMatch(summary,/private|internal|raw output/)
})

test('handoff preserves the original remote task when reconnecting', () => {
  const task = {id:'job-1',role:'user',source:{kind:'dsh-remote-tasks',eventId:'job-1'},
    content:[{type:'text',text:'Check the current build.'}]}
  const resume = {...task,id:'job-1:resume:1',content:[{type:'text',text:'Continue this task.'}]}
  const supplement = {role:'user',source:{kind:'user'},content:[{type:'text',text:'Only validate the existing files.'}]}
  const toolActivity = Array.from({length:50},()=>[
    {role:'assistant',content:[{type:'tool-call',name:'bash'}]},
    {role:'tool',content:[{type:'text',text:'tool output'}]},
  ]).flat()
  const longReply = {role:'assistant',content:[{type:'text',text:'progress '.repeat(2500)}]}
  const summary = summarize([task,supplement,...toolActivity,resume,longReply])
  assert.match(summary,/Check the current build/)
  assert.match(summary,/Only validate the existing files/)
  assert.ok(summary.length <= 32_000)
  assert.doesNotMatch(summary,/tool output/)
})

test('handoff preserves the reply and drops obsolete skill preloading notices', () => {
  const reply = {role:'assistant',content:[{type:'text',text:
    '> 未带入以下 DSH 技能：clarify\n\n> DSH 技能已作为会话上下文提供。\n\nThe changes are ready.'}]}
  assert.equal(summarize([reply]),'助手：The changes are ready.')
})

test('DSH native tool records advertise calls before starting them and keep one id through the result', async () => {
  const {dshTools} = await import('../src/driver/map-updates.ts')
  const events = []
  const agent = {session:{append(type,data,options){events.push({type,data,options})}}}
  const native = dshTools(agent,{turn:2,step:1},{provider:'external-acp-kimi-code',model:'local'})
  const first = native.receive({toolCallId:'remote-1',kind:'edit',title:'Edit test',status:'pending'})
  native.receive({toolCallId:'remote-1',status:'in_progress'})
  native.receive({toolCallId:'remote-1',status:'completed',content:[{type:'diff',path:'/test',newText:'hello'}]})
  native.flush()
  assert.deepEqual(events.map(e=>e.type),['assistant/message','tool/call','tool/result'])
  const call = events[0].data.message.content[0]
  assert.equal(call.id,first.id)
  assert.equal(events[1].data.callId,call.id)
  assert.equal(events[1].data.arguments,call.arguments)
  assert.equal(events[2].data.message.toolCallId,call.id)
  assert.match(events[2].data.message.content[0].text,/\+hello/)
})

test('plan mode denies escalation even when the DSH profile is fully open', async () => {
  const {approve} = await import('../src/host/interactions.ts')
  const ctx = {approval:{request(){assert.fail('A plan-only session must not offer escalation')}}}
  const req = {options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}
  const result = await approve(ctx,{},req,new AbortController().signal,()=> 'deny')
  assert.deepEqual(result,{outcome:{outcome:'selected',optionId:'no'}})
})

test('ACP forms return typed native DSH answers and reject mislabelled choices', async () => {
  const {elicit} = await import('../src/host/interactions.ts')
  const req = {mode:'form', message:'Choose',requestedSchema:{
    type:'object',required:['selected','count'],properties:{
      selected:{type:'string',oneOf:[{const:'a',title:'First'},{const:'b',title:'Second'}]},
      count:{type:'integer',minimum:1,maximum:9},
    },
  }}
  const signal = new AbortController().signal
  let label = 'Second'
  const ctx = {userQuestions:{async ask({questions}) {
    assert.deepEqual(questions.map(item=>item.id),['selected','count'])
    return {answers:[{id:'selected',selected:[label]},{id:'count',selected:[],custom:'3'}]}
  }}}
  const result = await elicit(ctx,{},req,signal)
  assert.equal(result.action,'accept')
  assert.equal(result.content.selected,'b')
  assert.equal(result.content.count,3)
  label = 'Not advertised'
  assert.deepEqual(await elicit(ctx,{},req,signal),{action:'decline'})
})
