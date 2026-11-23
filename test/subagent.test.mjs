import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childPersonaSections, delegationInstructions } from '../src/host/subagent.ts'
import { Session } from '@deepseek-ai/dsh-session'
import { dshTools } from '../src/driver/map-updates.ts'

const prefix = 'Review only for correctness.'
const suffix = 'Lead with the verdict.'
const role = [prefix, suffix]
const system = (source, texts) => ({role:'system',source:{kind:'system-prompt',...source},content:texts.map(text=>({type:'text',text}))})
const section = (name, contentIndex, order = 0) => ({name,state:'active',contentIndex,order})
const initial = () => system({reset:true,sections:[section('deployment:persona-prefix',0),section('deployment:persona-suffix',1,10)]},role)

test('DSH 0.2.3 role sections survive an unrelated incremental system update', () => {
  const messages = [initial(),system({sections:[section('tool:bash',0)]},['Reserved tool instructions.'])]
  const output = delegationInstructions(role,messages)
  assert.ok(output.includes(prefix))
  assert.ok(output.includes(suffix))
  assert.ok(!output.includes('Reserved tool instructions.'))
})

test('retired and replaced roles do not leak stale instructions or retirement notices', () => {
  const messages = [initial(),system({sections:[
    {name:'deployment:persona-prefix',state:'retired',noticeIndex:[0]},
    section('deployment:persona-suffix',1),
  ]},['The earlier instructions no longer apply.','Return JSON only.'])]
  const output = delegationInstructions([...role,'Return JSON only.'],messages)
  assert.ok(output.includes('Return JSON only.'))
  assert.ok(!output.includes(prefix))
  assert.ok(!output.includes(suffix))
  assert.ok(!output.includes('The earlier instructions'))
})

test('a complete system prompt replaces previously admitted child roles', () => {
  const messages = [initial(),system({reset:true,complete:true,sections:[section('deployment:persona-prefix',0)]},[prefix])]
  const output = delegationInstructions(role,messages)
  assert.ok(output.includes(prefix))
  assert.ok(!output.includes(suffix))
})

test('an empty reset removes all earlier role instructions', () => {
  const output = delegationInstructions(role,[initial(),system({reset:true,sections:[]},[])])
  assert.ok(!output.includes(prefix))
  assert.ok(!output.includes(suffix))
})

test('unrelated sections cannot reintroduce a retired child role', () => {
  const output = delegationInstructions(role,[initial(),system({sections:[
    {name:'deployment:persona-prefix',state:'retired'},section('tool:bash',0),
  ]},[prefix])])
  assert.ok(!output.includes(prefix))
  assert.ok(output.includes(suffix))
})

test('legacy whole-prompt messages still use only their latest effective contents', () => {
  const output = delegationInstructions(role,[system({},[role.join('\n\n')]),system({},[prefix])])
  assert.ok(output.includes(prefix))
  assert.ok(!output.includes(suffix))
})

test('role rendering follows DSH interpolation, literal text and retirement semantics', () => {
  const output = childPersonaSections({sections:[
    {name:'deployment:persona-prefix',text:'Review {{topic}}.'},
    {name:'deployment:persona-suffix',text:'Keep {{literal}}.',interpolate:false},
    {name:'deployment:persona-prefix',text:'Retired role.',retire:true},
    {name:'tool:bash',text:'Reserved tool instructions.'},
  ],contexts:[],variables:{topic:'correctness'}})
  assert.deepEqual(output,['Review correctness.','Keep {{literal}}.'])
})

test('DSH 0.2.3 accepts external tool calls and results in a real Session', () => {
  const session = Session.create('external-compat-test')
  const tools = dshTools({session},{turn:1,step:1},{provider:'external-acp-codex',model:'test'})
  tools.receive({toolCallId:'read-1',kind:'read',title:'Read a file',status:'in_progress'})
  assert.equal(tools.pending,true)
  tools.receive({toolCallId:'read-1',status:'completed',content:[{type:'content',content:{type:'text',text:'File contents.'}}]})
  assert.equal(tools.pending,false)
  assert.deepEqual(session.ownEvents().map(event=>event.type),['assistant/message','tool/call','tool/result'])
  assert.equal(session.ownEvents().at(-1).data.message.content[0].text,'File contents.')
})
