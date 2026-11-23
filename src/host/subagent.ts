import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SystemPromptMessageSource } from '@deepseek-ai/dsh-llm/message'
import {
  PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, renderPrompt, type PromptPresentation,
} from '@deepseek-ai/dsh-system-prompt'
import { messageText, type Message } from '../driver/context.ts'

export function isDelegatedChild(agent: Agent): boolean {
  const header = agent.session.header
  return header.origin === 'subagent' && !!header.parentSession && (header.delegationDepth ?? 0) > 0
}

export function childPersonaSections(assembly: PromptPresentation): string[] {
  return assembly.sections
    .filter(section => section.name === PERSONA_PREFIX_SECTION || section.name === PERSONA_SUFFIX_SECTION)
    .map(section => renderPrompt({...assembly,sections:[section],tools:[],systemUpdates:()=>[]}))
    .filter(Boolean)
}

export function delegationInstructions(sections: readonly string[] = [], messages: readonly Message[]): string {
  // DSH can replace the assembled prompt with a complete persona after its
  // assembly event. Only send role sections present in the effective request.
  // DSH 0.2.3 admits named sections incrementally. The last system message
  // may only update an unrelated tool, or retire a role with a notice whose
  // text must never become instructions. Fold the attributed text blocks.
  const active = new Map<string,string>()
  let legacy = ''
  for (const message of messages) {
    if (message.role !== 'system' || message.source?.kind !== 'system-prompt') continue
    const source = message.source as SystemPromptMessageSource
    if (!source.sections) {
      active.clear()
      legacy = messageText(message)
      continue
    }
    if (source.reset || source.complete) { active.clear(); legacy = '' }
    for (const section of source.sections) {
      if (section.name !== PERSONA_PREFIX_SECTION && section.name !== PERSONA_SUFFIX_SECTION) continue
      if (section.state === 'retired') { active.delete(section.name); continue }
      const block = message.content[section.contentIndex]
      active.set(section.name,block?.type === 'text' ? block.text ?? '' : '')
    }
  }
  const effective = '\n\n' + [legacy,...active.values()].filter(Boolean).join('\n\n') + '\n\n'
  const persona = sections.filter(section => effective.includes('\n\n' + section + '\n\n')).join('\n\n')
  const role = persona ? 'DSH subagent role instructions:\n' + persona + '\n\n' : ''
  return role + 'You are working on a delegated DSH task. Your parent receives your final answer. '
    + 'Follow the delegated permission scope. Report any blocked operation or missing information in your answer.'
}
