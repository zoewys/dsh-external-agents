export interface Message {
  role: string
  id?: string
  source?: {kind?: string; eventId?: string}
  content: readonly {type: string; text?: string; name?: string}[]
}

export function messageText(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
}

export function isUserOrRemoteTaskInput(message: Pick<Message,'role'|'source'>): boolean {
  const source = message.source?.kind
  return message.role === 'user' && (source === 'user' || source === 'dsh-remote-tasks')
}

export function summarize(history: readonly Message[]): string {
  const inputs = history.filter(isUserOrRemoteTaskInput)
  const latestTask = inputs.findLast(message => message.source?.kind === 'dsh-remote-tasks')
  const taskId = latestTask?.source?.eventId
  const task = taskId ? inputs.find(message =>
    message.source?.kind === 'dsh-remote-tasks' && message.source.eventId === taskId && message.id === taskId,
  ) ?? latestTask : latestTask
  const supplements = inputs.filter(message => message.source?.kind === 'user').slice(-6)
  const prioritized = new Set(task ? [task,...supplements] : supplements)
  const taskText = task ? ('用户：' + messageText(task)).slice(0,24_000) : ''
  const supplementText = supplements.map(message => '用户：' + messageText(message)).join('\n\n').slice(-6_000)
  const instructions = [taskText,supplementText].filter(Boolean).join('\n\n')
  const progress = history.slice(-80).filter(message => !prioritized.has(message)).flatMap(message => {
    if (isUserOrRemoteTaskInput(message)) return ['用户：' + messageText(message)]
    if (message.role === 'assistant') {
      const text = messageText(message).replace(
        /^> (?:未带入以下 DSH 技能：[^\n]*|DSH 技能已作为会话上下文提供。|读取 DSH 技能失败。)(?:\n+|$)/gm, '',
      )
      const tools = message.content.filter(block => block.type === 'tool-call' && block.name).map(block => block.name)
      return [...text ? ['助手：' + text] : [], ...tools.length ? ['曾调用工具：' + tools.join('、')] : []]
    }
    return []
  }).join('\n\n')
  const recent = progress.slice(-Math.min(16_000,32_000 - instructions.length - 2))
  return [instructions,recent].filter(Boolean).join('\n\n')
}
