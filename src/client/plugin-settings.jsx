import React, {useCallback,useState,useSyncExternalStore} from 'react'

const packageName = 'dsh-external-agents'
const sectionId = 'dsh-external-agents-settings'
const fields = ['injectDshSkills','injectDshMcp','codexTransport']

const styles = `
.ea-settings{display:grid;gap:14px;color:var(--dsw-alias-label-primary);scroll-margin:18px}
.ea-settings h4,.ea-settings p{margin:0}
.ea-settings p,.ea-setting-row small{color:var(--dsw-alias-label-secondary)}
.ea-settings form{display:grid;gap:12px}
.ea-setting-row{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.ea-setting-row span{display:grid;gap:4px}
.ea-setting-row input{accent-color:var(--dsw-alias-button-primary-fill)}
.ea-setting-row select{max-width:52%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px}
.ea-settings-footer{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.ea-settings-button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;padding:6px 11px}
.ea-settings-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.ea-settings-save{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}
.ea-settings-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.ea-settings-button:disabled{cursor:default;opacity:.55}
`

function SettingsPage({form}) {
  const subscribe = useCallback(listener=>form.subscribe(listener),[form])
  const getSnapshot = useCallback(()=>form.getSnapshot(),[form])
  const snapshot = useSyncExternalStore(subscribe,getSnapshot)
  const [draft,setDraft] = useState(null)
  const [saving,setSaving] = useState(false)
  const [feedback,setFeedback] = useState(null)
  const current = snapshot.value ?? {}
  const values = draft?.values ?? current
  const ready = snapshot.status === 'ready'
  const changes = fields.filter(key=>values[key] !== current[key])
  const editable = ready && snapshot.writable && !saving

  function edit(key,value) {
    setDraft({revision:draft?.revision ?? snapshot.revision,values:{...values,[key]:value}})
    setFeedback(null)
  }

  async function save(event) {
    event.preventDefault()
    if (!editable || !draft || changes.length === 0) return
    setSaving(true)
    try {
      const accepted = await form.mutate(changes.map(key=>({op:'set',path:[key],value:values[key]})),draft.revision)
      setDraft(null)
      setFeedback(accepted ? {text:'设置已保存'} : {error:true,text:'设置保存失败，请重新选择后再试。'})
    } catch {
      setFeedback({error:true,text:'无法保存设置，请重试。'})
    } finally {
      setSaving(false)
    }
  }

  return <section className="ea-settings" id={sectionId} tabIndex={-1} aria-labelledby={sectionId+'-title'}>
    <style>{styles}</style>
    <h4 id={sectionId+'-title'}>外部 Agent 设置</h4>
    {ready ? <>
      <p>保存后，受影响的外部 Agent 会话将在下一轮使用新设置。</p>
      <form onSubmit={save}>
        <label className="ea-setting-row"><span>共享 DSH 技能<small>允许外部 Agent 按需读取当前会话可用的技能。</small></span>
          <input aria-label="共享 DSH 技能" role="switch" type="checkbox" checked={values.injectDshSkills === true} disabled={!editable}
            onChange={event=>edit('injectDshSkills',event.target.checked)} /></label>
        <label className="ea-setting-row"><span>共享 DSH MCP<small>将当前会话可转发的 MCP 服务器提供给外部 Agent。</small></span>
          <input aria-label="共享 DSH MCP" role="switch" type="checkbox" checked={values.injectDshMcp === true} disabled={!editable}
            onChange={event=>edit('injectDshMcp',event.target.checked)} /></label>
        <label className="ea-setting-row"><span>Codex 连接方式<small>默认使用本机 Codex 配置的模型提供商。</small></span>
          <select aria-label="Codex 连接方式" value={values.codexTransport ?? 'native'} disabled={!editable}
            onChange={event=>edit('codexTransport',event.target.value)}>
            <option value="native">本机 Codex 配置</option>
            <option value="https">OpenAI HTTPS</option>
          </select></label>
        <div className="ea-settings-footer">
          <button type="submit" className="ea-settings-button ea-settings-save" disabled={!editable || changes.length === 0}>
            {saving ? '正在保存…' : '保存设置'}</button>
          {feedback && <span role={feedback.error ? 'alert' : 'status'}>{feedback.text}</span>}
          {!snapshot.writable && <span>当前连接可以查看设置。</span>}
        </div>
      </form>
    </> : <p role="status">{snapshot.status === 'loading' ? '正在读取设置…' : '当前无法读取插件设置。'}</p>}
  </section>
}

export function registerPluginSettings(ctx) {
  const configSlot = 'plugins.bundle.config'
  ctx.slots.inject(configSlot,()=>ctx.slots.register({name:configSlot,key:packageName},
    () => <SettingsPage form={ctx.configForms.get('external-agents')} />))

  const actionSlot = 'plugins.detail.actions'
  ctx.slots.inject(actionSlot,()=>ctx.slots.register({name:actionSlot,id:packageName},({subject}) => {
    if (subject.kind !== 'bundle' || subject.pkg.name !== packageName) return null
    return <button type="button" className="ea-settings-button" aria-label="外部 Agent 设置" aria-controls={sectionId}
      onClick={()=>document.getElementById(sectionId)?.focus()}>设置</button>
  }))
}
