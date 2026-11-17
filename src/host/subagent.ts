import type { Agent } from '@deepseek-ai/dsh-agent'
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
    .map(section => renderPrompt({...assembly,sections:[section],tools:[]}))
    .filter(Boolean)
}

export function delegationInstructions(sections: readonly string[] = [], messages: readonly Message[]): string {
  // DSH can replace the assembled prompt with a complete persona after its
  // assembly event. Only send role sections present in the effective request.
  const snapshot = messages.findLast(message =>
    message.role === 'system' && message.source?.kind === 'system-prompt' && message.content.length > 0)
  const effective = snapshot ? '\n\n' + messageText(snapshot) + '\n\n' : ''
  const persona = sections.filter(section => effective.includes('\n\n' + section + '\n\n')).join('\n\n')
  const role = persona ? 'DSH subagent role instructions:\n' + persona + '\n\n' : ''
  return role + 'You are working on a delegated DSH task. Your parent receives your final answer. '
    + 'Follow the delegated permission scope. Report any blocked operation or missing information in your answer.'
}
