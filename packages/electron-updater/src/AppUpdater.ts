import { AllPublishOptions, asArray, CancellationError, CancellationToken, DownloadOptions, newError, PublishConfiguration, UpdateInfo, UUID } from "builder-util-runtime"
import { randomBytes } from "crypto"
import { Notification } from "electron"
import { EventEmitter } from "events"
import { outputFile } from "fs-extra"
import { mkdir, readFile, rename, unlink } from "fs/promises"
import { OutgoingHttpHeaders } from "http"
import { load } from "js-yaml"
import { Lazy } from "lazy-val"
import * as path from "path"
import { eq as isVersionsEqual, gt as isVersionGreaterThan, lt as isVersionLessThan, parse as parseVersion, SemVer } from "semver"
import { AppAdapter, ExternalAppAdapter } from "./AppAdapter"
import { createTempUpdateFile, DownloadedUpdateHelper } from "./DownloadedUpdateHelper"
import { ElectronAppAdapter } from "./ElectronAppAdapter"
import { ElectronHttpExecutor, getNetSession } from "./electronHttpExecutor"
import { DOWNLOAD_PROGRESS, Logger, Provider, ResolvedUpdateFileInfo, UPDATE_DOWNLOADED, UpdateCheckResult, UpdateDownloadedEvent, UpdaterSignal } from "./main"
import { createClient, isUrlProbablySupportMultiRangeRequests } from "./providerFactory"
import { GenericProvider } from "./providers/GenericProvider"
import { ProviderPlatform } from "./providers/Provider"
import Session = Electron.Session

export abstract class AppUpdater extends EventEmitter {
  /**
   * Whether to automatically download an update when it is found.
   */
  autoDownload = true

  /**
   * Whether to automatically install a downloaded update on app quit (if `quitAndInstall` was not called before).
   */
  autoInstallOnAppQuit = true

  /**
   * Whether to allow version downgrade (when a user from the beta channel wants to go back to the stable channel).
   *
   * Taken in account only if channel differs (pre-release version component in terms of semantic versioning).
   *
   * @default false
   */
  allowDowngrade = false

  /**
   * Whether to use semantic versioning to compare/order app versions.
   *
   * If false, there is no concept of upgrade/downgrade, so any difference between the current version string
   *  and the update version string will trigger an update.
   * If set to "loose", current and update versions will be parsed with `{ loose: true }` option set.
   *
   * @default true
   */
  useSemver: boolean | "loose" = true

  /**
   * The current application version.
   */
  get currentVersion(): SemVer | null {
    if (this.useSemver === false) return null

    return parseVersion(this.currentVersionString, this.useSemver === "loose" ? { loose: true } : undefined)
  }

  readonly currentVersionString: string

  private _channel: string | null = null

  protected downloadedUpdateHelper: DownloadedUpdateHelper | null = null

  /**
   * Get the update channel. Not applicable for GitHub. Doesn't return `channel` from the update configuration, only if was previously set.
   */
  get channel(): string | null {
    return this._channel
  }

  /**
   * Set the update channel. Not applicable for GitHub. Overrides `channel` in the update configuration.
   *
   * `allowDowngrade` will be automatically set to `true`. If this behavior is not suitable for you, simple set `allowDowngrade` explicitly after.
   */
  set channel(value: string | null) {
    if (this._channel != null) {
      // noinspection SuspiciousTypeOfGuard
      if (typeof value !== "string") {
        throw newError(`Channel must be a string, but got: ${value}`, "ERR_UPDATER_INVALID_CHANNEL")
      } else if (value.length === 0) {
        throw newError(`Channel must be not an empty string`, "ERR_UPDATER_INVALID_CHANNEL")
      }
    }

    this._channel = value
    this.allowDowngrade = true
  }

  /**
   *  The request headers.
   */
  requestHeaders: OutgoingHttpHeaders | null = null

  /**
   *  Shortcut for explicitly adding auth tokens to request headers
   */
  addAuthHeader(token: string) {
    this.requestHeaders = Object.assign({}, this.requestHeaders, {
      authorization: token,
    })
  }

  protected _logger: Logger = console

  // noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
  get netSession(): Session {
    return getNetSession()
  }

  /**
   * The logger. You can pass [electron-log](https://github.com/megahertz/electron-log), [winston](https://github.com/winstonjs/winston) or another logger with the following interface: `{ info(), warn(), error() }`.
   * Set it to `null` if you would like to disable a logging feature.
   */
  get logger(): Logger | null {
    return this._logger
  }

  set logger(value: Logger | null) {
    this._logger = value == null ? new NoOpLogger() : value
  }

  // noinspection JSUnusedGlobalSymbols
  /**
   * For type safety you can use signals, e.g. `autoUpdater.signals.updateDownloaded(() => {})` instead of `autoUpdater.on('update-available', () => {})`
   */
  readonly signals = new UpdaterSignal(this)

  private _appUpdateConfigPath: string | null = null

  // noinspection JSUnusedGlobalSymbols
  /**
   * test only
   * @private
   */
  set updateConfigPath(value: string | null) {
    this.clientPromise = null
    this._appUpdateConfigPath = value
    this.configOnDisk = new Lazy<any>(() => this.loadUpdateConfig())
  }

  private clientPromise: Promise<Provider | null> | null = null

  protected readonly stagingUserIdPromise = new Lazy<string | null>(() => this.getOrCreateStagingUserId())

  // public, allow to read old config for anyone
  /** @internal */
  configOnDisk = new Lazy<PublishConfiguration | null>(() => this.loadUpdateConfig())

  private checkForUpdatesPromise: Promise<UpdateCheckResult> | null = null

  protected readonly app: AppAdapter | ExternalAppAdapter

  protected updateInfoAndProvider: UpdateInfoAndProvider | null = null

  /** @internal */
  readonly httpExecutor: ElectronHttpExecutor

  protected constructor(options: AllPublishOptions | null | undefined, app?: AppAdapter | ExternalAppAdapter) {
    super()

    this.on("error", (error: Error) => {
      this._logger.error(`Error: ${error.stack ?? error.message}`)
    })

    if (app == null) {
      this.app = new ElectronAppAdapter()
      this.httpExecutor = new ElectronHttpExecutor((authInfo, callback) => this.emit("login", authInfo, callback))
    } else {
      this.app = app
      this.httpExecutor = null as any
    }

    this.currentVersionString = this.app.version

    if (options != null) {
      this.setFeedURL(options)

      if (typeof options !== "string" && options.requestHeaders) {
        this.requestHeaders = options.requestHeaders
      }
    }
  }

  //noinspection JSMethodCanBeStatic,JSUnusedGlobalSymbols
  getFeedURL(): string | null | undefined {
    return "Deprecated. Do not use it."
  }

  /**
   * Configure update provider. If value is `string`, [GenericServerOptions](/configuration/publish#genericserveroptions) will be set with value as `url`.
   * @param options If you want to override configuration in the `app-update.yml`.
   */
  setFeedURL(options: PublishConfiguration | AllPublishOptions | string) {
    const runtimeOptions = this.createProviderRuntimeOptions()
    // https://github.com/electron-userland/electron-builder/issues/1105
    let provider: Provider
    if (typeof options === "string") {
      provider = new GenericProvider({ provider: "generic", url: options }, this, {
        ...runtimeOptions,
        isUseMultipleRangeRequest: isUrlProbablySupportMultiRangeRequests(options),
      })
    } else {
      provider = createClient(options, this, runtimeOptions)
    }
    this.clientPromise = Promise.resolve(provider)
  }

  /**
   * Asks the server whether there is an update.
   */
  checkForUpdates(): Promise<UpdateCheckResult> {
    let checkForUpdatesPromise = this.checkForUpdatesPromise
    if (checkForUpdatesPromise != null) {
      this._logger.info("Checking for update (already in progress)")
      return checkForUpdatesPromise
    }

    const nullizePromise = () => (this.checkForUpdatesPromise = null)

    this._logger.info("Checking for update")
    checkForUpdatesPromise = this.doCheckForUpdates()
      .then(it => {
        nullizePromise()
        return it
      })
      .catch(e => {
        nullizePromise()
        this.emit("error", e, `Cannot check for updates: ${(e.stack || e).toString()}`)
        throw e
      })

    this.checkForUpdatesPromise = checkForUpdatesPromise
    return checkForUpdatesPromise
  }

  public isUpdaterActive(): boolean {
    if (!this.app.isExternalApp && !this.app.isPackaged) {
      this._logger.info("Skip checkForUpdatesAndNotify because application is not packed")
      return false
    }
    return true
  }

  // noinspection JSUnusedGlobalSymbols
  async checkForUpdatesAndNotify(downloadNotification?: DownloadNotification, electronNotificationOut?: { notification?: Notification }): Promise<UpdateCheckResult | null> {
    if (!this.isUpdaterActive()) {
      return null
    }

    const updateCheckResult = await this.checkForUpdates()
    const { updateInfo, downloadPromise } = updateCheckResult

    if (updateInfo == null) {
      this._logger.debug?.("checkForUpdatesAndNotify called, updateInfo is null")
      return updateCheckResult;
    }

    if (downloadPromise == null) {
      this._logger.debug?.("checkForUpdatesAndNotify called, downloadPromise is null")
      return updateCheckResult
    }

    await downloadPromise;
    const notificationContent = AppUpdater.formatDownloadNotification(updateInfo.version, this.app.name, downloadNotification)
    const notification = new (require("electron").Notification(notificationContent))

    notification.show()

    if (electronNotificationOut != null)
      electronNotificationOut.notification = notification

    return updateCheckResult
  }

  private static formatDownloadNotification(version: string, appName: string, downloadNotification?: DownloadNotification): DownloadNotification {
    if (downloadNotification == null) {
      downloadNotification = {
        title: "A new update is ready to install",
        body: `{appName} version {version} has been downloaded and will be automatically installed on exit`,
      }
    }
    downloadNotification = {
      title: downloadNotification.title.replace("{appName}", appName).replace("{version}", version),
      body: downloadNotification.body.replace("{appName}", appName).replace("{version}", version),
    }
    return downloadNotification
  }

  private isStagingMatch(updateInfo: UpdateInfo, stagingUserId: string | null): boolean {
    const rawStagingPercentage = updateInfo.stagingPercentage
    let stagingPercentage = rawStagingPercentage
    if (stagingPercentage == null) {
      return true
    }

    stagingPercentage = parseInt(stagingPercentage as any, 10)
    if (isNaN(stagingPercentage)) {
      this._logger.warn(`Staging percentage is NaN: ${rawStagingPercentage}`)
      return true
    }

    if (stagingUserId == null) {
      this._logger.warn(`Staging user ID is not supported, allowing the update`)
      return true
    }

    // convert from user 0-100 to internal 0-1
    stagingPercentage = stagingPercentage / 100

    const val = UUID.parse(stagingUserId).readUInt32BE(12)
    const percentage = val / 0xffffffff
    this._logger.info(`Staging percentage: ${stagingPercentage}, percentage: ${percentage}, user id: ${stagingUserId}`)
    return percentage < stagingPercentage
  }

  private computeFinalHeaders(headers: OutgoingHttpHeaders) {
    if (this.requestHeaders != null) {
      Object.assign(headers, this.requestHeaders)
    }
    return headers
  }

  private isUpdateAvailable(updateInfoAndProvider: UpdateInfoAndProvider): boolean {
    const { info: updateInfo, stagingUserId } = updateInfoAndProvider;

    if (this.useSemver === false) return updateInfo.version !== this.currentVersionString

    const latestVersion = parseVersion(updateInfo.version, this.useSemver === "loose" ? { loose: true } : undefined)
    if (latestVersion == null) {
      throw newError(
        `This file could not be downloaded, or the latest version (from update server) does not have a valid semver version: "${updateInfo.version}"`,
        "ERR_UPDATER_INVALID_VERSION"
      )
    }

    const currentVersion = this.currentVersion
    if (currentVersion == null) {
      throw newError(`App version is not a valid semver version: "${this.currentVersionString}"`, "ERR_UPDATER_INVALID_VERSION")
    }
    if (isVersionsEqual(latestVersion, currentVersion)) {
      return false
    }

    const isStagingMatch = this.isStagingMatch(updateInfo, stagingUserId)
    if (!isStagingMatch) {
      return false
    }

    // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405033227
    // https://github.com/electron-userland/electron-builder/pull/3111#issuecomment-405030797
    const isLatestVersionNewer = isVersionGreaterThan(latestVersion, currentVersion)
    const isLatestVersionOlder = isVersionLessThan(latestVersion, currentVersion)

    if (isLatestVersionNewer) {
      return true
    }
    return this.allowDowngrade && isLatestVersionOlder
  }

  async getProvider(): Promise<Provider | null> {
    /* wait until the currently running electron app is ready to load the provider */
    await (this.app.isExternalApp ? require("electron").app : this.app).whenReady()

    if (this.clientPromise == null) {
      this.clientPromise = this.configOnDisk.value.then(it => it == null ? null : createClient(it, this, this.createProviderRuntimeOptions()))
    }

    return await this.clientPromise ?? null
  }

  protected async getUpdateInfoAndProvider(provider: Provider): Promise<UpdateInfoAndProvider> {
    const stagingUserId = await this.stagingUserIdPromise.value;

    provider.setRequestHeaders(this.computeFinalHeaders({ "x-user-staging-id": stagingUserId ?? "" }))
    return {
      info: await provider.getLatestVersion(),
      provider,
      stagingUserId
    }
  }

  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  private createProviderRuntimeOptions() {
    return {
      isUseMultipleRangeRequest: true,
      platform: this._testOnlyOptions == null ? (process.platform as ProviderPlatform) : this._testOnlyOptions.platform,
      executor: this.httpExecutor,
    }
  }

  private async doCheckForUpdates(): Promise<UpdateCheckResult> {
    const provider = await this.getProvider();
    if (provider == null) {
      this._logger.info(`Update for version ${this.currentVersionString} is not available (update provider is not configured).`)
      return { updateInfo: null, versionInfo: null, isUpdaterUnconfigured: true };
    }

    this.emit("checking-for-update");

    //Moved the emit of checking-for-update here to getUpdateInfoAndProvider, so it doesn't emit if updater is not configured.
    const result = await this.getUpdateInfoAndProvider(provider)

    const updateInfo = result.info
    if (!this.isUpdateAvailable(result)) {
      if (this.useSemver === false) {
        this._logger.info(`Update for version ${this.currentVersionString} is not available (latest version: ${updateInfo.version}).`)
      } else {
        this._logger.info(
          `Update for version ${this.currentVersionString} is not available (latest version: ${updateInfo.version}, downgrade is ${this.allowDowngrade ? "allowed" : "disallowed"}).`
        )
      }
      this.emit("update-not-available", updateInfo)
      return {
        versionInfo: updateInfo,
        updateInfo,
      }
    }

    this.updateInfoAndProvider = result
    this.onUpdateAvailable(updateInfo)

    const cancellationToken = new CancellationToken()
    //noinspection ES6MissingAwait
    return {
      versionInfo: updateInfo,
      updateInfo,
      cancellationToken,
      downloadPromise: this.autoDownload ? this.downloadUpdate(cancellationToken) : null,
    }
  }

  protected onUpdateAvailable(updateInfo: UpdateInfo): void {
    this._logger.info(
      `Found version ${updateInfo.version} (url: ${asArray(updateInfo.files)
        .map(it => it.url)
        .join(", ")})`
    )
    this.emit("update-available", updateInfo)
  }

  /**
   * Start downloading update manually. You can use this method if `autoDownload` option is set to `false`.
   * @returns {Promise<string>} Path(s) to downloaded file(s).
   */
  downloadUpdate(cancellationToken: CancellationToken = new CancellationToken()): Promise<readonly string[]> {
    const updateInfoAndProvider = this.updateInfoAndProvider
    if (updateInfoAndProvider == null) {
      const error = new Error("Please check update first")
      this.dispatchError(error)
      return Promise.reject(error)
    }

    this._logger.info(
      `Downloading update from ${asArray(updateInfoAndProvider.info.files)
        .map(it => it.url)
        .join(", ")}`
    )
    const errorHandler = (e: Error): Error => {
      // https://github.com/electron-userland/electron-builder/issues/1150#issuecomment-436891159
      if (!(e instanceof CancellationError)) {
        try {
          this.dispatchError(e)
        } catch (nestedError) {
          this._logger.warn(`Cannot dispatch error event: ${nestedError.stack || nestedError}`)
        }
      }

      return e
    }

    try {
      return this.doDownloadUpdate({
        updateInfoAndProvider,
        requestHeaders: this.computeRequestHeaders(updateInfoAndProvider.provider),
        cancellationToken,
      }).catch(e => {
        throw errorHandler(e)
      })
    } catch (e) {
      return Promise.reject(errorHandler(e))
    }
  }

  protected dispatchError(e: Error): void {
    this.emit("error", e, (e.stack || e).toString())
  }

  protected dispatchUpdateDownloaded(event: UpdateDownloadedEvent): void {
    this.emit(UPDATE_DOWNLOADED, event)
  }

  protected abstract doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>>

  /**
   * Restarts the app and installs the update after it has been downloaded.
   * It should only be called after `update-downloaded` has been emitted.
   *
   * **Note:** `autoUpdater.quitAndInstall()` will close all application windows first and only emit `before-quit` event on `app` after that.
   * This is different from the normal quit event sequence.
   *
   * @param isSilent *windows-only* Runs the installer in silent mode. Defaults to `false`.
   * @param isForceRunAfter Run the app after finish even on silent install. Not applicable for macOS. Ignored if `isSilent` is set to `false`.
   */
  abstract quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void

  private async loadUpdateConfig(): Promise<any> {
    if (this._appUpdateConfigPath == null) {
      this._appUpdateConfigPath = this.app.appUpdateConfigPath
    }
    return load(await readFile(this._appUpdateConfigPath, "utf-8"))
  }

  private computeRequestHeaders(provider: Provider<any>): OutgoingHttpHeaders {
    const fileExtraDownloadHeaders = provider.fileExtraDownloadHeaders
    if (fileExtraDownloadHeaders != null) {
      const requestHeaders = this.requestHeaders
      return requestHeaders == null
        ? fileExtraDownloadHeaders
        : {
            ...fileExtraDownloadHeaders,
            ...requestHeaders,
          }
    }
    return this.computeFinalHeaders({ accept: "*/*" })
  }

  private async getOrCreateStagingUserId(): Promise<string | null> {
    const file = this.app.isExternalApp ? this.app.stagingUserIdPath : path.join(this.app.userDataPath, ".updaterId")
    if (file == null)
      return null

    try {
      const id = await readFile(file, "utf-8")
      if (UUID.check(id)) {
        return id
      } else {
        this._logger.warn(`Staging user id file exists, but content was invalid: ${id}`)
      }
    } catch (e) {
      if (e.code !== "ENOENT") {
        this._logger.warn(`Couldn't read staging user ID, creating a blank one: ${e}`)
      }
    }

    const id = UUID.v5(randomBytes(4096), UUID.OID)
    this._logger.info(`Generated new staging user ID: ${id}`)
    try {
      await outputFile(file, id)
    } catch (e) {
      this._logger.warn(`Couldn't write out staging user ID: ${e}`)
    }
    return id
  }

  /** @internal */
  get isAddNoCacheQuery(): boolean {
    const headers = this.requestHeaders
    // https://github.com/electron-userland/electron-builder/issues/3021
    if (headers == null) {
      return true
    }

    for (const headerName of Object.keys(headers)) {
      const s = headerName.toLowerCase()
      if (s === "authorization" || s === "private-token") {
        return false
      }
    }
    return true
  }

  /**
   * @private
   * @internal
   */
  _testOnlyOptions: TestOnlyUpdaterOptions | null = null

  private async getOrCreateDownloadHelper(): Promise<DownloadedUpdateHelper> {
    let result = this.downloadedUpdateHelper
    if (result == null) {
      const dirName = (await this.configOnDisk.value)?.updaterCacheDirName
      const logger = this._logger
      if (dirName == null) {
        logger.error("updaterCacheDirName is not specified in app-update.yml Was app build using at least electron-builder 20.34.0?")
      }
      const cacheDir = path.join(this.app.baseCachePath, dirName || this.app.name)
      logger.debug?.(`updater cache dir: ${cacheDir}`)

      result = new DownloadedUpdateHelper(cacheDir)
      this.downloadedUpdateHelper = result
    }
    return result
  }

  protected async executeDownload(taskOptions: DownloadExecutorTask): Promise<Array<string>> {
    const fileInfo = taskOptions.fileInfo
    const downloadOptions: DownloadOptions = {
      headers: taskOptions.downloadUpdateOptions.requestHeaders,
      cancellationToken: taskOptions.downloadUpdateOptions.cancellationToken,
      sha2: (fileInfo.info as any).sha2,
      sha512: fileInfo.info.sha512,
    }

    if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
      downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
    }

    const updateInfo = taskOptions.downloadUpdateOptions.updateInfoAndProvider.info
    const version = updateInfo.version
    const packageInfo = fileInfo.packageInfo

    function getCacheUpdateFileName(): string {
      // NodeJS URL doesn't decode automatically
      const urlPath = decodeURIComponent(taskOptions.fileInfo.url.pathname)
      if (urlPath.endsWith(`.${taskOptions.fileExtension}`)) {
        return path.posix.basename(urlPath)
      } else {
        // url like /latest, generate name
        return `update.${taskOptions.fileExtension}`
      }
    }

    const downloadedUpdateHelper = await this.getOrCreateDownloadHelper()
    const cacheDir = downloadedUpdateHelper.cacheDirForPendingUpdate
    await mkdir(cacheDir, { recursive: true })
    const updateFileName = getCacheUpdateFileName()
    let updateFile = path.join(cacheDir, updateFileName)
    const packageFile = packageInfo == null ? null : path.join(cacheDir, `package-${version}${path.extname(packageInfo.path) || ".7z"}`)

    const done = async (isSaveCache: boolean) => {
      await downloadedUpdateHelper.setDownloadedFile(updateFile, packageFile, updateInfo, fileInfo, updateFileName, isSaveCache)
      await taskOptions.done!({
        ...updateInfo,
        downloadedFile: updateFile,
      })
      return packageFile == null ? [updateFile] : [updateFile, packageFile]
    }

    const log = this._logger
    const cachedUpdateFile = await downloadedUpdateHelper.validateDownloadedPath(updateFile, updateInfo, fileInfo, log)
    if (cachedUpdateFile != null) {
      updateFile = cachedUpdateFile
      return await done(false)
    }

    const removeFileIfAny = async () => {
      await downloadedUpdateHelper.clear().catch(() => {
        // ignore
      })
      return await unlink(updateFile).catch(() => {
        // ignore
      })
    }

    const tempUpdateFile = await createTempUpdateFile(`temp-${updateFileName}`, cacheDir, log)
    try {
      await taskOptions.task(tempUpdateFile, downloadOptions, packageFile, removeFileIfAny)
      await rename(tempUpdateFile, updateFile)
    } catch (e) {
      await removeFileIfAny()

      if (e instanceof CancellationError) {
        log.info("cancelled")
        this.emit("update-cancelled", updateInfo)
      }
      throw e
    }

    log.info(`New version ${version} has been downloaded to ${updateFile}`)
    return await done(true)
  }
}

export interface DownloadUpdateOptions {
  readonly updateInfoAndProvider: UpdateInfoAndProvider
  readonly requestHeaders: OutgoingHttpHeaders
  readonly cancellationToken: CancellationToken
}

/** @private */
export class NoOpLogger implements Logger {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  info(message?: any) {
    // ignore
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  warn(message?: any) {
    // ignore
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error(message?: any) {
    // ignore
  }
}

export interface UpdateInfoAndProvider {
  info: UpdateInfo
  provider: Provider
  stagingUserId: string | null
}

export interface DownloadExecutorTask {
  readonly fileExtension: string
  readonly fileInfo: ResolvedUpdateFileInfo
  readonly downloadUpdateOptions: DownloadUpdateOptions
  readonly task: (destinationFile: string, downloadOptions: DownloadOptions, packageFile: string | null, removeTempDirIfAny: () => Promise<any>) => Promise<any>

  readonly done?: (event: UpdateDownloadedEvent) => Promise<any>
}

export interface DownloadNotification {
  body: string
  title: string
}

/** @private */
export interface TestOnlyUpdaterOptions {
  platform: ProviderPlatform

  isUseDifferentialDownload?: boolean
}
