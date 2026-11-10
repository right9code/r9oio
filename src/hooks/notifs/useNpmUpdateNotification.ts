import type { Notification } from 'src/context/notifications.js'
import {
  getLatestVersion,
  getMaxVersion,
  shouldSkipVersion,
} from 'src/utils/autoUpdater.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gte, gt } from 'src/utils/semver.js'
import { getInitialSettings } from 'src/utils/settings/settings.js'
import { useStartupNotification } from './useStartupNotification.js'

export function useNpmUpdateNotification(): void {
  useStartupNotification(checkForNpmUpdate)
}

async function checkForNpmUpdate(): Promise<Notification | null> {
  if ("production" === 'test' || "production" === 'development') {
    logForDebugging('NpmUpdateNotification: skipping update check in test/dev environment')
    return null
  }

  try {
    const currentVersion = MACRO.VERSION
    const channel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
    let latestVersion = await getLatestVersion(channel)

    const maxVersion = await getMaxVersion()
    if (maxVersion && latestVersion && gt(latestVersion, maxVersion)) {
      logForDebugging(
        `NpmUpdateNotification: maxVersion ${maxVersion} is set, capping update from ${latestVersion} to ${maxVersion}`,
      )
      if (gte(currentVersion, maxVersion)) {
        return null
      }
      latestVersion = maxVersion
    }

    if (
      !latestVersion ||
      gte(currentVersion, latestVersion) ||
      shouldSkipVersion(latestVersion)
    ) {
      return null
    }

    logForDebugging(
      `NpmUpdateNotification: update available ${currentVersion} -> ${latestVersion}`,
    )

    return {
      key: 'npm-update-available',
      text: `Tau update available: ${currentVersion} -> ${latestVersion}. Run: tau update`,
      color: 'warning',
      priority: 'low',
      timeoutMs: 5000,
    }
  } catch (error) {
    logForDebugging(`NpmUpdateNotification: update check failed: ${error}`, {
      level: 'error',
    })
    return null
  }
}
