import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childEnvironment, parseConfig } from '../src/host/profiles.ts'
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
  const task = {role:'user',source:{kind:'dsh-remote-tasks',eventId:'job-1'},
    content:[{type:'text',text:'Check the current build.'}]}
  assert.match(summarize([task]),/Check the current build/)
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
