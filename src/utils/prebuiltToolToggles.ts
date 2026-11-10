import {
  getPrebuiltToolToggleItem,
  PREBUILT_TOOL_TOGGLE_ITEMS,
  type PrebuiltToolToggleId,
} from '../constants/prebuiltToolToggles.js'
import { getPowerModeFromSettings } from './powerMode.js'
import type { SettingsJson } from './settings/types.js'

type SettingsWithPrebuiltToolToggles = Pick<
  SettingsJson,
  'disabledPrebuiltTools' | 'powerMode'
>

const EMPTY_SETTINGS: SettingsWithPrebuiltToolToggles = {}

export function normalizeDisabledPrebuiltToolIds(
  disabledPrebuiltTools: readonly string[] | undefined,
): PrebuiltToolToggleId[] {
  const seen = new Set<string>()
  const result: PrebuiltToolToggleId[] = []

  for (const value of disabledPrebuiltTools ?? []) {
    const item = getPrebuiltToolToggleItem(value)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item.id as PrebuiltToolToggleId)
  }

  return result
}

/**
 * Effective disabled-toggle set. Power mode overrides the saved /tools
 * toggles without rewriting them: cheap forces every optional tool off,
 * full forces every optional tool on, normal applies the saved toggles.
 * The saved list is preserved so returning to normal restores it.
 */
export function getDisabledPrebuiltToolIds(
  settings: SettingsWithPrebuiltToolToggles = EMPTY_SETTINGS,
): Set<PrebuiltToolToggleId> {
  const powerMode = getPowerModeFromSettings(settings)
  if (powerMode === 'cheap') {
    return new Set(
      PREBUILT_TOOL_TOGGLE_ITEMS.map(
        item => item.id as PrebuiltToolToggleId,
      ),
    )
  }
  if (powerMode === 'full') {
    return new Set()
  }
  return new Set(
    normalizeDisabledPrebuiltToolIds(settings.disabledPrebuiltTools),
  )
}

export function isPrebuiltToolToggleDisabled(
  id: string,
  settings: SettingsWithPrebuiltToolToggles = EMPTY_SETTINGS,
): boolean {
  const item = getPrebuiltToolToggleItem(id)
  if (!item) return false
  return getDisabledPrebuiltToolIds(settings).has(item.id as PrebuiltToolToggleId)
}

export function isPrebuiltToolDisabledByToolName(
  toolName: string,
  settings: SettingsWithPrebuiltToolToggles = EMPTY_SETTINGS,
): boolean {
  const item = getPrebuiltToolToggleItem(toolName)
  if (!item) return false
  return isPrebuiltToolToggleDisabled(item.id, settings)
}

export function isOptionalPrebuiltToolName(toolName: string): boolean {
  return getPrebuiltToolToggleItem(toolName) !== undefined
}

export function filterDisabledPrebuiltTools<T extends { name: string }>(
  tools: readonly T[],
  settings: SettingsWithPrebuiltToolToggles = EMPTY_SETTINGS,
): T[] {
  const disabled = getDisabledPrebuiltToolIds(settings)
  if (disabled.size === 0) return [...tools]

  return tools.filter(tool => {
    const item = getPrebuiltToolToggleItem(tool.name)
    return !item || !disabled.has(item.id as PrebuiltToolToggleId)
  })
}

export function setPrebuiltToolToggleEnabled(
  disabledPrebuiltTools: readonly string[] | undefined,
  id: string,
  enabled: boolean,
): PrebuiltToolToggleId[] | null {
  const item = getPrebuiltToolToggleItem(id)
  if (!item) return null

  const disabled = new Set(
    normalizeDisabledPrebuiltToolIds(disabledPrebuiltTools),
  )
  if (enabled) {
    disabled.delete(item.id as PrebuiltToolToggleId)
  } else {
    disabled.add(item.id as PrebuiltToolToggleId)
  }

  const ordered = PREBUILT_TOOL_TOGGLE_ITEMS.map(
    toggle => toggle.id as PrebuiltToolToggleId,
  )
  return ordered.filter(toggleId => disabled.has(toggleId))
}

