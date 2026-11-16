export interface Message {
  role: string
  id?: string
  source?: {kind?: string}
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
  return history.slice(-80).flatMap(message => {
    if (isUserOrRemoteTaskInput(message)) return ['用户：' + messageText(message)]
    if (message.role === 'assistant') {
      const text = messageText(message).replace(
        /^> (?:未带入以下 DSH 技能：[^\n]*|DSH 技能已作为会话上下文提供。|读取 DSH 技能失败。)(?:\n+|$)/gm, '',
      )
      const tools = message.content.filter(block => block.type === 'tool-call' && block.name).map(block => block.name)
      return [...text ? ['助手：' + text] : [], ...tools.length ? ['曾调用工具：' + tools.join('、')] : []]
    }
    return []
  }).join('\n\n').slice(-16_000)
}
