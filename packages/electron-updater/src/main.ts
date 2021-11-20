import { CancellationToken, PackageFileInfo, ProgressInfo, UpdateFileInfo, UpdateInfo } from "builder-util-runtime"
import { EventEmitter } from "events"
import { URL } from "url"
import { AppUpdater } from "./AppUpdater"
import { LoginCallback } from "./electronHttpExecutor"

export { AppUpdater, NoOpLogger } from "./AppUpdater"
export { CancellationToken, PackageFileInfo, ProgressInfo, UpdateFileInfo, UpdateInfo }
export { Provider } from "./providers/Provider"
export { AppImageUpdater } from "./AppImageUpdater"
export { MacUpdater } from "./MacUpdater"
export { NsisUpdater } from "./NsisUpdater"

// autoUpdater to mimic electron bundled autoUpdater
let _autoUpdater: any

// required for jsdoc
export declare const autoUpdater: AppUpdater

function doLoadAutoUpdater(): AppUpdater {
  // tslint:disable:prefer-conditional-expression
  if (process.platform === "win32") {
    _autoUpdater = new (require("./NsisUpdater").NsisUpdater)()
  } else if (process.platform === "darwin") {
    _autoUpdater = new (require("./MacUpdater").MacUpdater)()
  } else {
    _autoUpdater = new (require("./AppImageUpdater").AppImageUpdater)()
  }
  return _autoUpdater
}

Object.defineProperty(exports, "autoUpdater", {
  enumerable: true,
  get: () => {
    return _autoUpdater || doLoadAutoUpdater()
  },
})

export interface ResolvedUpdateFileInfo {
  readonly url: URL
  readonly info: UpdateFileInfo

  packageInfo?: PackageFileInfo
}

export interface UpdateCheckResult {
  readonly updateInfo: UpdateInfo | null

  readonly downloadPromise?: Promise<ReadonlyArray<string>> | null

  readonly cancellationToken?: CancellationToken

  /** @deprecated */
  readonly versionInfo: UpdateInfo | null

  readonly isUpdaterUnconfigured?: true;
}

export type UpdaterEvents = "login" | "checking-for-update" | "update-available" | "update-not-available" | "update-cancelled" | "download-progress" | "update-downloaded" | "error"

export const DOWNLOAD_PROGRESS: UpdaterEvents = "download-progress"
export const UPDATE_DOWNLOADED: UpdaterEvents = "update-downloaded"

export type LoginHandler = (authInfo: any, callback: LoginCallback) => void

export class UpdaterSignal {
  constructor(private emitter: EventEmitter) {}

  /**
   * Emitted when an authenticating proxy is [asking for user credentials](https://github.com/electron/electron/blob/master/docs/api/client-request.md#event-login).
   */
  login(handler: LoginHandler, disposed?: Promise<unknown>): void {
    addHandler(this.emitter, "login", handler, disposed)
  }

  progress(handler: (info: ProgressInfo) => void, disposed?: Promise<unknown>): void {
    addHandler(this.emitter, DOWNLOAD_PROGRESS, handler, disposed)
  }

  updateDownloaded(handler: (info: UpdateDownloadedEvent) => void, disposed?: Promise<unknown>): void {
    addHandler(this.emitter, UPDATE_DOWNLOADED, handler, disposed)
  }

  updateCancelled(handler: (info: UpdateInfo) => void, disposed?: Promise<unknown>): void {
    addHandler(this.emitter, "update-cancelled", handler, disposed)
  }
}

export interface UpdateDownloadedEvent extends UpdateInfo {
  downloadedFile: string
}

const isLogEvent = false

function addHandler(emitter: EventEmitter, event: UpdaterEvents, handler: (...args: Array<any>) => void, disposed?: Promise<unknown>): void {
  const effHandler = (isLogEvent)
    ? (...args: Array<any>) => {
      console.log("%s %s", event, args)
      handler(...args)
    }
    : handler

  emitter.on(event, effHandler)
  disposed?.finally(() => emitter.off(event, effHandler))
}

export interface Logger {
  info(message?: any): void

  warn(message?: any): void

  error(message?: any): void

  debug?(message: string): void
}
