import React, {useEffect,useRef,useState} from 'react'
import { registerPluginSettings } from './plugin-settings.jsx'

const base = './api/dsh-external-agents'
const names = {'external-acp-kimi-code':'Kimi Code','external-acp-codex':'Codex'}
let nonceRequest

async function control(body) {
  nonceRequest ??= fetch(base + '/bootstrap',{credentials:'same-origin'}).then(res => {
    if (!res.ok) throw new Error('无法连接外部 Agent 插件。')
    return res.json()
  })
  try {
    const {nonce} = await nonceRequest
    const response = await fetch(base,{method:'POST',credentials:'same-origin',headers:{
      'content-type':'application/json','x-dsh-external-agents':nonce,
    },body:JSON.stringify(body)})
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || '无法连接外部 Agent 插件。')
    return payload
  } catch (error) {
    nonceRequest = undefined
    throw error
  }
}

const styles = `
.ea-button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;padding:6px 11px}
.ea-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ea-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}
.ea-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.ea-button:disabled{cursor:default;opacity:.55}
.ea-permission-status{color:var(--dsw-alias-label-secondary);font-size:.875em}
.ea-dialog{padding:0;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;width:min(640px,calc(100vw - 28px));max-height:calc(100vh - 28px);font:inherit;box-shadow:0 18px 52px rgba(0,0,0,.2)}
.ea-dialog::backdrop{background:var(--dsw-alias-bg-mask-3)}
.ea-dialog-title{display:flex;align-items:center;justify-content:space-between;padding:15px 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ea-wizard{display:grid;grid-template-columns:minmax(134px, 30%) 1fr;min-height:220px}
.ea-steps{margin:0;padding:20px;list-style:none;background:var(--dsw-specific-sidebar-fill);color:var(--dsw-alias-label-secondary);border-right:1px solid var(--dsw-alias-border-l2)}
.ea-steps li{margin-bottom:14px}
.ea-steps [aria-current]{color:var(--dsw-alias-label-primary);font-weight:650}
.ea-main{min-width:0;padding:21px}
.ea-main h3{font-size:15px;margin:0 0 8px}
.ea-main p{color:var(--dsw-alias-label-secondary);margin:0 0 12px}
.ea-main code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:11px;margin:12px 0}
.ea-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ea-controls{display:grid;gap:12px}
.ea-controls label{display:flex;gap:10px;align-items:center;justify-content:space-between}
.ea-controls select{max-width:60%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:4px}
@media(max-width:430px){.ea-steps{padding:14px}.ea-main{padding:14px}.ea-wizard{grid-template-columns:111px 1fr}}
`

function Dialog({view,error,busy,close,retry,setOption}) {
  const ref = useRef(null)
  const [stepOverride,setStep] = useState(null)
  const [copied,setCopied] = useState(false)
  useEffect(() => { ref.current.showModal() },[])
  const readiness = view?.readiness?.status
  const step = stepOverride ?? (readiness === 'not_installed' ? 0 : readiness === 'not_logged_in' ? 1 : 2)
  const setup = readiness !== 'ready'
  const command = step === 0 ? view?.install : view?.login
  const detect = () => { setStep(null); setCopied(false); void retry() }
  const mode = view?.options?.find(o => o.category === 'mode')
  const planAvailable = mode?.choices.some(o => o.value === 'plan') || view?.agent === 'codex'
  const model = view?.options?.find(o => o.category === 'model')
  return <dialog className="ea-dialog" ref={ref} onCancel={close} aria-label={(view?.name || '外部 Agent') + (setup ? ' 设置向导' : ' 会话设置')}>
    <style>{styles}</style>
    <div className="ea-dialog-title"><strong>{view?.name ?? '外部 Agent'} {setup ? '设置向导' : '会话设置'}</strong>
      <button className="ea-button" onClick={close} aria-label="关闭">×</button></div>
    {setup ? <div className="ea-wizard">
      <ol className="ea-steps">{['安装 CLI','登录账号','检测连通'].map((label,index) =>
        <li key={label} aria-current={step === index ? 'step' : undefined}>{step > index ? '✓' : (index+1)+'.'} {label}</li>)}</ol>
      <div className="ea-main">
        <h3>{step === 0 ? '安装 ' + view?.name + ' CLI' : step === 1 ? '登录 ' + view?.name : busy ? '检测中' : '检测未通过'}</h3>
        <p>{step === 0 ? '在运行 DSH 的电脑上执行安装命令。' : step === 1 ? '在系统终端登录。登录状态由 CLI 保存。' :
          busy ? '正在检查本机 CLI 和 ACP 连接。' : view?.readiness?.message || error || '请确认 CLI 已安装并完成登录。'}</p>
        {step < 2 && command && <code>{command}</code>}
        <div className="ea-actions">
          {step < 2 && command && <button className="ea-button" onClick={async()=>{
            try { await navigator.clipboard.writeText(command); setCopied(true) } catch { setCopied(false) }
          }}>{copied ? '已复制' : '复制命令'}</button>}
          {step > 0 && <button className="ea-button" onClick={()=>{setStep(step-1);setCopied(false)}}>上一步</button>}
          <button className="ea-button ea-primary" disabled={busy} onClick={detect}>{step === 0 ? '已安装，下一步' : '重新检测'}</button>
        </div>
      </div>
    </div> : <div className="ea-main ea-controls">
      <p>当前模型：{model?.choices.find(o=>o.value === (view.model === '@default' ? model.currentValue : view.model))?.name ?? view.model}</p>
      {mode && <p>运行模式随 DSH 权限：{mode.choices.find(o=>o.value === mode.currentValue)?.name ?? mode.currentValue}</p>}
      {planAvailable && <label>仅规划 <input type="checkbox" checked={view.plan} disabled={busy || view.running}
        onChange={event=>void setOption('@plan',event.target.checked)} /></label>}
      {view.options.filter(option => ['thought_level','model_config','collaboration_mode'].includes(option.category)).map(option => <label key={option.id}>{option.name}
        {option.type === 'boolean'
          ? <input type="checkbox" checked={option.currentValue} disabled={busy || view.running || !view.connected} onChange={event=>void setOption(option.id,event.target.checked)} />
          : <select value={option.currentValue} disabled={busy || view.running || !view.connected} onChange={event=>void setOption(option.id,event.target.value)}>
            {option.choices.map(choice=><option key={choice.value} value={choice.value}>{choice.name}</option>)}
          </select>}
      </label>)}
      {!view.connected && <p>发送第一条消息后，可以调整当前 ACP 会话的参数。</p>}
      {view.details && <details><summary>详情</summary><p style={{whiteSpace:'pre-wrap'}}>{view.details}</p></details>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </dialog>
}

function HeaderAction({sessionId,useProjection,useSession,blankOnly=false}) {
  const provider = useProjection('modelSelection', value => (value?.next ?? value?.lastUsed)?.provider)
  const model = useProjection('modelSelection', value => (value?.next ?? value?.lastUsed)?.model)
  const running = useSession(value => value.running)
  const blank = useSession(value => value.blank)
  const visible = blank === blankOnly
  const [view,setView] = useState(null)
  const [error,setError] = useState(null)
  const [open,setOpen] = useState(false)
  const [busy,setBusy] = useState(false)
  const dismissed = useRef(false)
  const generation = useRef(0)
  const update = async (action='status',key,value) => {
    const epoch = generation.current
    try {
      if (action === 'option' || action === 'resume') await control({id:sessionId,action,key,value})
      const next = await control({id:sessionId,action:action === 'probe' ? action : 'status'})
      if (generation.current !== epoch) return
      setView(next)
      setError(null)
      if (next && !dismissed.current && ['not_installed','not_logged_in','error'].includes(next.readiness.status)) setOpen(true)
      if (action === 'probe' && next?.readiness.status === 'ready') setOpen(false)
    } catch (failure) {
      if (generation.current === epoch) setError(failure.message)
    }
  }
  useEffect(()=>{
    generation.current++
    dismissed.current = false
    setView(null)
    setOpen(false)
    setError(null)
    if (visible && sessionId && names[provider]) void update()
    return ()=>{generation.current++}
  },[sessionId,provider,model,running,visible])
  useEffect(()=>{
    if (!visible || !names[provider] || (!running && !open)) return
    const timer = setInterval(()=>void update(),2000)
    return ()=>clearInterval(timer)
  },[sessionId,provider,model,running,open,visible])
  if (!visible || !names[provider] || !sessionId) return null
  const perform = async (action,key,value) => {
    setBusy(true)
    try { await update(action,key,value) } finally { setBusy(false) }
  }
  const paused = !running && view?.permissionUpdate === 'paused'
  const status = paused ? '权限收紧，已暂停' : view?.pending ? '等待审批或回答' : running ? '进行中' : view?.error || error || view?.readiness?.status === 'error' ? '出错' : '空闲'
  return <>
    <style>{styles}</style>
    <button className="ea-button" type="button" aria-label={names[provider]+' 会话设置'}
      title={[view?.permission,status,view?.notice].filter(Boolean).join(' · ')}
      onClick={()=>{setOpen(true);void update()}}>{names[provider]} · {status}</button>
    {view?.permissionUpdate === 'next-turn' && <span className="ea-permission-status" role="status">新权限将在下一轮生效</span>}
    {paused && <button className="ea-button" type="button" disabled={busy}
      onClick={()=>void perform('resume',view.permissionPause)}>按新权限继续</button>}
    {paused && error && <span className="ea-permission-status" role="alert">{error}</span>}
    {open && <Dialog view={view} error={error} busy={busy} close={()=>{dismissed.current=true;setOpen(false)}}
      retry={()=>perform('probe')} setOption={(key,value)=>perform('option',key,value)} />}
  </>
}

export const inject = ['slots','configForms']
export function apply(ctx) {
  registerPluginSettings(ctx)
  const slot = 'conversation.session.header.utilities'
  ctx.slots.inject(slot,()=>ctx.slots.register({name:slot,id:'external-agents-session',order:10}, HeaderAction))
  const setup = 'conversation.input.right'
  ctx.slots.inject(setup,()=>ctx.slots.register({name:setup,id:'external-agents-setup',order:10},
    props => <HeaderAction {...props} blankOnly />))
}
