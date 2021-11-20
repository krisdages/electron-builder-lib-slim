import * as path from "path"
import { homedir as getHomedir } from "os"

interface AppAdapterBase {
  readonly version: string
  readonly name: string

  /**
   * Path to update metadata file.
   */
  readonly appUpdateConfigPath: string

  /**
   * Path to cache directory.
   */
  readonly baseCachePath: string
}

/** Adapter for the currently running app. */
export interface AppAdapter extends AppAdapterBase {
  readonly isExternalApp: false;

  readonly isPackaged: boolean

  /**
   * Path to user data directory.
   */
  readonly userDataPath: string

  whenReady(): Promise<void>

  quit(): void

  onQuit(handler: (exitCode: number) => void): void
}

/** Adapter for an external app that does not require quitting the current app before installing. */
export interface ExternalAppAdapter extends AppAdapterBase {
  readonly isExternalApp: true

  /**
   * Path to the staging user ID file. If not set, staging will not be supported.
   */
  readonly stagingUserIdPath?: string

  readonly installPathForElevationCheck?: string
}

export function getAppCacheDir() {
  const homedir = getHomedir()
  // https://github.com/electron/electron/issues/1404#issuecomment-194391247
  let result: string
  if (process.platform === "win32") {
    result = process.env["LOCALAPPDATA"] || path.join(homedir, "AppData", "Local")
  } else if (process.platform === "darwin") {
    result = path.join(homedir, "Library", "Application Support", "Caches")
  } else {
    result = process.env["XDG_CACHE_HOME"] || path.join(homedir, ".cache")
  }
  return result
}
