import type { NewSessionResponse, SessionConfigOption } from '@agentclientprotocol/sdk/unstable'
type LegacyModel = { modelId: string; name: string; description?: string }
type LegacyModels = { currentModelId: string; availableModels: LegacyModel[] }
type SessionInfo = Omit<NewSessionResponse, 'sessionId'> & { models?: LegacyModels | null }

export function choices(option: SessionConfigOption) {
  return option.type === 'select' ? option.options.flatMap(item => 'options' in item ? item.options : [item]) : []
}

export function sessionOptions(info: SessionInfo | undefined): SessionConfigOption[] {
  const options = [...info?.configOptions ?? []]
  const models = info?.models
  if (models && !options.some(item => item.category === 'model')) {
    options.push({ type: 'select', category: 'model', id: '@model', name: 'Model', currentValue: models.currentModelId,
      options: models.availableModels.map(({modelId, name, description}) => ({value:modelId,name,description})) })
  }
  const modes = info?.modes
  if (modes && !options.some(item => item.category === 'mode')) {
    options.push({ type: 'select', category: 'mode', id: '@mode', name: 'Mode', currentValue: modes.currentModeId,
      options: modes.availableModes.map(({id, name, description}) => ({value:id,name,description})) })
  }
  return options
}
