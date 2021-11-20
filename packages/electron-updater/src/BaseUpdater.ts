import * as fs from "fs"
import * as path from "path"
import { AllPublishOptions } from "builder-util-runtime"
import { AppAdapter, ExternalAppAdapter } from "./AppAdapter"
import { AppUpdater, DownloadExecutorTask } from "./AppUpdater"
import { CachedUpdateInfo } from "./DownloadedUpdateHelper"

export abstract class BaseUpdater extends AppUpdater {
  protected installCalled = false
  private quitHandlerAdded = false

  installPathElevationCheckEnabled = process.platform === "win32"

  protected constructor(options?: AllPublishOptions | null, app?: AppAdapter | ExternalAppAdapter) {
    super(options, app)
  }

  quitAndInstall(isSilent = false, isForceRunAfter = false): void {
    const { app } = this;
    if (app.isExternalApp) {
      throw new Error("App is external, quitAndInstall is not supported.")
    }

    this._logger.info(`Install on explicit quitAndInstall`)
    const isInstalled = this.install(isSilent, isSilent ? isForceRunAfter : true)
    if (isInstalled) {
      setImmediate(() => {
        // this event is normally emitted when calling quitAndInstall, this emulates that
        require("electron").autoUpdater.emit("before-quit-for-update")
        app.quit()
      })
    } else {
      this.installCalled = false
    }
  }

  async installExternal(isSilent = false, isForceRunAfter = false): Promise<boolean> {
    const { app } = this;
    if (!app.isExternalApp) {
      throw new Error("App is not external; must use quitAndInstall instead to update the current app.")
    }

    this._logger.info(`Install with installExternal`)
    const [willInstall, installed] = this.install(isSilent, isSilent ? isForceRunAfter : true)
    try {
      if (!willInstall)
        return false

      await installed
      return true
    }
    finally {
      this.installCalled = false
    }
  }

  protected executeDownload(taskOptions: DownloadExecutorTask): Promise<Array<string>> {
    return super.executeDownload({
      ...taskOptions,
      done: event => {
        this.dispatchUpdateDownloaded(event)
        this.addQuitHandler()
        return Promise.resolve()
      },
    })
  }

  // must be sync
  protected abstract doInstall(options: InstallOptions, downloadedFileInfo: CachedUpdateInfo): InstallResultTuple

  // must be sync (because quit event handler is not async)
  private onQuitInstall(isSilent: boolean, isForceRunAfter: boolean): boolean {
    return this.install(isSilent, isForceRunAfter)[0];
  }

  protected install(isSilent: boolean, isForceRunAfter: boolean): InstallResultTuple {
    const { app } = this

    const download = this.ensureDownloadedInstaller()
    if (download == null)
      return [false]
    const [installerPath, downloadedFileInfo] = download

    try {
      const installPathForElevationCheck = app.isExternalApp ? app.installPathForElevationCheck : process.execPath
      let installPathRequiresElevation: boolean | null = installPathForElevationCheck == null ? null : false
      if (!app.isExternalApp && this.installPathElevationCheckEnabled) {
        try {
          const accessTestPath = path.join(path.dirname(process.execPath), `access-${Math.floor(Math.random() * 100)}.tmp`)
          fs.writeFileSync(accessTestPath, " ")
          fs.rmSync(accessTestPath)
        } catch (err) {
          // Require admin rights if needed
          installPathRequiresElevation = true
        }
      }

      this._logger.info(`Install: isSilent: ${isSilent}, isForceRunAfter: ${isForceRunAfter}, installPathRequiresElevation: ${installPathRequiresElevation ?? "N/A" }`)
      const [willInstall, installed] = this.doInstall({
        installerPath,
        isSilent,
        isForceRunAfter,
        isAdminRightsRequired: installPathRequiresElevation || downloadedFileInfo.isAdminRightsRequired,
      }, downloadedFileInfo);
      return [willInstall, installed?.catch(e => this.dispatchError(e))] as InstallResultTuple;
    } catch (e) {
      this.dispatchError(e)
      return [false]
    }
  }

  protected ensureDownloadedInstaller(): readonly [installerPath: string, downloadedFileInfo: CachedUpdateInfo] | null {
    const verb = this.app.isExternalApp ? "install" : "quit and install"

    if (this.installCalled) {
      this._logger.warn("install call ignored: installCalled is set to true")
      return null
    }

    const downloadedUpdateHelper = this.downloadedUpdateHelper
    const installerPath = downloadedUpdateHelper == null ? null : downloadedUpdateHelper.file
    const downloadedFileInfo = downloadedUpdateHelper == null ? null : downloadedUpdateHelper.downloadedFileInfo
    if (installerPath == null || downloadedFileInfo == null) {
      this.dispatchError(new Error(`No valid update available, can't ${verb}`))
      return null
    }

    // prevent calling several times
    this.installCalled = true

    return [installerPath, downloadedFileInfo]
  }

  protected addQuitHandler(): void {
    if (this.quitHandlerAdded || !this.autoInstallOnAppQuit || this.app.isExternalApp) {
      return
    }

    this.quitHandlerAdded = true

    this.app.onQuit(exitCode => {
      if (this.installCalled) {
        this._logger.info("Update installer has already been triggered. Quitting application.")
        return
      }

      if (!this.autoInstallOnAppQuit) {
        this._logger.info("Update will not be installed on quit because autoInstallOnAppQuit is set to false.")
        return
      }

      if (exitCode !== 0) {
        this._logger.info(`Update will be not installed on quit because application is quitting with exit code ${exitCode}`)
        return
      }

      this._logger.info("Auto install update on quit")
      this.onQuitInstall(true, false)
    })
  }
}

export interface InstallOptions {
  readonly installerPath: string
  readonly isSilent: boolean
  readonly isForceRunAfter: boolean
  readonly isAdminRightsRequired: boolean
}

export type InstallResultTuple = readonly [willInstall: false, installed?: undefined] | [willInstall: true, installed: Promise<unknown>];
