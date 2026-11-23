import { createInterface } from 'node:readline'
import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
const input = createInterface({input:process.stdin})
const reply = (id,result) => send({id,result})
const send = data => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...data})+'\n')
let current
let skillEndpoint
let sessionCwd
let held
let reportApproval=false
const quotaFixture = process.argv.includes('kimi-quota-log')
const sessionId = quotaFixture ? 'session_'+randomUUID() : 'fake-'+process.pid
const options = [
  {type:'select',id:'mode',category:'mode',name:'Mode',currentValue:'default',options:[
    {value:'default',name:'Default'},{value:'yolo',name:'YOLO'},{value:'workspace-write',name:'Workspace write'},{value:'agent-full-access',name:'Full access'},
    {value:'plan',name:'Plan'},{value:'read-only',name:'Read only'},
  ]},
  {type:'select',id:'model',category:'model',name:'Model',currentValue:'one',options:[{value:'one',name:'One'},{value:'two',name:'Two'}]},
]
if (process.argv.includes('antigravity')) {
  options[0].options=options[0].options.filter(option=>['plan','default'].includes(option.value))
  options[1].currentValue=process.argv.includes('partner-default')?'claude-test':'gemini-test'
  options[1].options=[{value:'gemini-test',name:'Gemini Test'},{value:'gemini-next',name:'Gemini Next'},{value:'claude-test',name:'Claude Test'}]
}
for await (const line of input) {
  const {id,method,params,result} = JSON.parse(line)
  if (method === 'initialize') {
    reply(id,{protocolVersion:1,authMethods:[{id:'login',name:'Login'}],agentCapabilities:{...(process.argv.includes('skill-tools')?{mcpCapabilities:{http:true}}:{}),sessionCapabilities:{resume:{},close:{},delete:{},...(process.argv.includes('cold-model')?{options:{}}:{})},promptCapabilities:{embeddedContext:true}}})
  } else if (method === 'session/new') {
    if (process.argv.includes('slow-session')) await new Promise(resolve=>setTimeout(resolve,40))
    sessionCwd=params.cwd
    skillEndpoint = params.mcpServers.find(server=>server.name==='dsh_skills')?.url
    if (process.argv.includes('cold-model') && params.configOptions?.some(x=>x.configId==='model'&&x.value==='two')) options[1].currentValue='two'
    if (process.argv.includes('logged-out')) send({id,error:{code:-32000,message:'auth required'}})
    else reply(id,{sessionId,configOptions:options})
  } else if (method === 'session/resume') {
    sessionCwd=params.cwd
    if (process.argv.includes('no-resume')) send({id,error:{code:-32002,message:'not found'}})
    else {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'do not replay'}}}})
      reply(id,{configOptions:options})
    }
  } else if (method === 'session/set_config_option') {
    const option = options.find(x=>x.id===params.configId)
    if (option.id==='model' && process.argv.includes('cold-model')) send({id,error:{code:-32601,message:'cannot hot switch'}})
    else if (option.id==='mode' && held && process.argv.includes('reject-live-mode')) send({id,error:{code:-32602,message:'mode can change only between turns'}})
    else {
      if (option.id!=='mode' || !process.argv.includes('ignore-mode')) option.currentValue = params.value
      reply(id,{configOptions:options})
    }
  } else if (method === 'session/prompt') {
    current = id
    const text = params.prompt.at(-1).text
    if (process.argv.includes('skill-tools') && /^(list-dsh-skills|read-dsh-skill |dsh-skills-endpoint)/.test(text)) {
      let output = text === 'dsh-skills-endpoint' ? skillEndpoint : 'no DSH skill endpoint'
      if (skillEndpoint && text !== 'dsh-skills-endpoint') {
        const target = text.split(' ')[1]
        const response = await fetch(skillEndpoint,{
          method:'POST',
          headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},
          body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{
            name:target ? 'read_dsh_skill' : 'list_dsh_skills',arguments:target ? {name:target} : {},
          }}),
        })
        const payload = await response.json()
        output = JSON.stringify(payload.result ?? payload.error)
      }
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:output}}}})
      reply(id,{stopReason:'end_turn'})
    } else if (quotaFixture && ['quota','stale-quota','empty'].includes(text)) {
      if (text !== 'empty') {
        const home = process.env.KIMI_CODE_HOME
        const sessionDir = join(home,'sessions','fixture',params.sessionId)
        await mkdir(join(sessionDir,'logs'),{recursive:true})
        await appendFile(join(home,'session_index.jsonl'),JSON.stringify({sessionDir,sessionId:params.sessionId})+'\n')
        const loggedAt = new Date(Date.now() - (text === 'stale-quota' ? 60_000 : 0)).toISOString()
        await appendFile(join(sessionDir,'logs','kimi-code.log'),loggedAt+
          ' WARN  llm request failed  turnStep=0.1 model=kimi-code/k3 errorName=APIProviderQuotaExhaustedError errorMessage="You reached your 5-hour usage limit. private-log-text" statusCode=429\n')
      }
      reply(id,{stopReason:'end_turn'})
    } else if (text === 'empty-reply') {
      reply(id,{stopReason:'end_turn'})
    } else if (text === 'diagnostic-error') {
      process.stderr.write('ENOTFOUND ENOTFOUND authorization: Bearer fixture-secret\nuntrusted stderr ECONN')
      setTimeout(()=>{
        process.stderr.write('RESET',()=>process.exit(23))
      },30)
    } else if (text === 'disconnect') {
      process.exit(0)
    } else if (text === 'hold-tool') {
      const update = value => send({method:'session/update',params:{sessionId:params.sessionId,update:value}})
      update({sessionUpdate:'tool_call',toolCallId:'slow-tool',title:'Long tool',kind:'execute',status:'in_progress'})
      held=setTimeout(()=>{
        held=undefined
        update({sessionUpdate:'tool_call_update',toolCallId:'slow-tool',status:'completed'})
        update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'tool finished'}})
        reply(id,{stopReason:'end_turn'})
      },380)
    } else if (text === 'report-cwd') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({processCwd:process.cwd(),sessionCwd})}}}})
      reply(id,{stopReason:'end_turn'})
    } else if (text === 'hold-approval') {
      reportApproval=true
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'started:'+options[0].currentValue+'\n'}}}})
      held=setTimeout(()=>{
        held=undefined
        send({id:999,method:'session/request_permission',params:{sessionId:params.sessionId,
          toolCall:{toolCallId:'after-widen',title:'Approval after widening',kind:'execute',status:'pending'},
          options:[{kind:'allow_once',optionId:'yes',name:'Yes'},{kind:'reject_once',optionId:'no',name:'No'}]}})
      },120)
    } else if (text === 'hold-mode' || text === 'report-mode') {
      const chunk = text => send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})
      if (text === 'hold-mode') {
        chunk('started:'+options[0].currentValue+'\n')
        held=setTimeout(()=>{
          held=undefined
          chunk('finished:'+options[0].currentValue)
          reply(id,{stopReason:'end_turn'})
        },process.argv.includes('slow-mode') ? 12_000 : 350)
      } else {
        chunk(options[0].currentValue)
        reply(id,{stopReason:'end_turn'})
      }
    } else if (text === 'approval') {
      send({id:999,method:'session/request_permission',params:{sessionId:params.sessionId,
        toolCall:{toolCallId:'test',title:'Example'},options:[{kind:'reject_once',optionId:'no',name:'No'}]}})
    } else if (params.prompt.at(-1).text !== 'cancel') {
      send({method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(params.prompt)}}}})
      reply(id,{stopReason:'end_turn'})
    }
  } else if (method === 'session/cancel') {
    clearTimeout(held)
    held=undefined
    reply(current,{stopReason:'cancelled'})
  }
  else if (method === 'session/close' || method === 'session/delete') reply(id,{})
  else if (id === 999 && reportApproval) {
    reportApproval=false
    send({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'approval:'+(result?.outcome?.optionId??'cancelled')}}}})
    reply(current,{stopReason:'end_turn'})
  }
  else if (id === 999 && result?.outcome?.optionId === 'no') reply(current,{stopReason:'end_turn'})
  else if (id != null) send({id,error:{code:-32601,message:'unknown'}})
}
