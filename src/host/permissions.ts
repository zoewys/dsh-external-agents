import type { PermissionOption } from '@agentclientprotocol/sdk'

export type Posture = 'full_open' | 'restricted'

// The stock DSH unrestricted preset is danger-full-access + never.
// Auto also has a full-access sandbox, but goes through the reviewer.
export function posture(sandbox: string, preset: string, approval: string): Posture {
  return sandbox === 'danger-full-access' && preset === 'danger-full-access' && approval === 'never'
    ? 'full_open' : 'restricted'
}

export function permissionChoice(options: readonly PermissionOption[], allowed: boolean): PermissionOption | undefined {
  return allowed ? options.find(item => item.kind === 'allow_once')
    : options.find(item => item.kind === 'reject_once')
}
