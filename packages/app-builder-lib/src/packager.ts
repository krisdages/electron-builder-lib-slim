import { addValue, Arch, archFromString, AsyncTaskManager, DebugLogger, deepAssign, InvalidConfigurationError, log, safeStringifyJson, serializeToYaml, TmpDir } from "builder-util"
import { CancellationToken } from "builder-util-runtime"
import { getArtifactArchName } from "builder-util/out/arch"
import { executeFinally, orNullIfFileNotExist } from "builder-util/out/promise"
import { EventEmitter } from "events"
import { chmod, mkdirs, outputFile } from "fs-extra"
import { Lazy } from "lazy-val"
import { release as getOsRelease } from "os"
import * as path from "path"
import { AppInfo } from "./appInfo"
import { readAsarJson } from "./asar/asar"
import { AfterPackContext, Configuration, RawAppOptions } from "./configuration"
import { Platform, Target } from "./core"
import { createElectronFrameworkSupport } from "./electron/ElectronFramework"
import { Framework } from "./Framework"
import { Metadata } from "./options/metadata"
import { AsarOptions } from "./options/PlatformSpecificBuildOptions"
import { ArtifactBuildStarted, ArtifactCreated, PackagerOptions } from "./packagerApi"
import { PlatformPackager, resolveFunction } from "./platformPackager"
import { computeArchToTargetNamesMap, createTargets, NoOpTarget } from "./targets/targetFactory"
import { computeDefaultAppDirectory, getConfig, validateConfig } from "./util/config"
import { expandMacro } from "./util/macroExpander"
import { createLazyProductionDeps, NodeModuleDirInfo } from "./util/packageDependencies"
import { checkMetadata, readPackageJson } from "./util/packageMetadata"
import { PACKAGE_VERSION } from "./version"

function addHandler(emitter: EventEmitter, event: string, handler: (...args: Array<any>) => void) {
  emitter.on(event, handler)
}

export async function createFrameworkInfo(configuration: Configuration, packager: Packager): Promise<Framework | null> {
  return(configuration.rawApp != null)
    ? new RawAppFramework(configuration.rawApp)
    : createElectronFrameworkSupport(configuration, packager);
}

export class Packager {
  readonly projectDir: string

  private _appDir: string
  get appDir(): string {
    return this._appDir
  }

  private _metadata: Metadata | null = null
  get metadata(): Metadata {
    return this._metadata!
  }

  private _nodeModulesHandledExternally = false

  get areNodeModulesHandledExternally(): boolean {
    return this._nodeModulesHandledExternally
  }

  private _isPrepackedAppAsar = false

  get isPrepackedAppAsar(): boolean {
    return this._isPrepackedAppAsar
  }

  private _devMetadata: Metadata | null = null
  get devMetadata(): Metadata | null {
    return this._devMetadata
  }

  private _configuration: Configuration | null = null

  get config(): Configuration {
    return this._configuration!
  }

  isTwoPackageJsonProjectLayoutUsed = false

  readonly eventEmitter = new EventEmitter()

  _appInfo: AppInfo | null = null
  get appInfo(): AppInfo {
    return this._appInfo!
  }

  readonly tempDirManager = new TmpDir("packager")

  private readonly afterPackHandlers: Array<(context: AfterPackContext) => Promise<any> | null> = []

  readonly options: PackagerOptions

  readonly debugLogger = new DebugLogger(log.isDebugEnabled)

  private nodeDependencyInfo = new Map<string, Lazy<Array<any>>>()

  getNodeDependencyInfo(platform: Platform | null): Lazy<Array<NodeModuleDirInfo>> {
    let key = ""
    let excludedDependencies: Array<string> | null = null
    if (platform != null && this.framework.getExcludedDependencies != null) {
      excludedDependencies = this.framework.getExcludedDependencies(platform)
      if (excludedDependencies != null) {
        key += `-${platform.name}`
      }
    }

    let result = this.nodeDependencyInfo.get(key)
    if (result == null) {
      result = createLazyProductionDeps(this.appDir, excludedDependencies)
      this.nodeDependencyInfo.set(key, result)
    }
    return result
  }

  stageDirPathCustomizer: (target: Target, packager: PlatformPackager<any>, arch: Arch) => string = (target, packager, arch) => {
    return path.join(target.outDir, `__${target.name}-${getArtifactArchName(arch, target.name)}`)
  }

  private _buildResourcesDir: string | null = null

  get buildResourcesDir(): string {
    let result = this._buildResourcesDir
    if (result == null) {
      result = path.resolve(this.projectDir, this.relativeBuildResourcesDirname)
      this._buildResourcesDir = result
    }
    return result
  }

  get relativeBuildResourcesDirname(): string {
    return this.config.directories!.buildResources!
  }

  private _framework: Framework | null = null
  get framework(): Framework {
    return this._framework!
  }

  private readonly toDispose: Array<() => Promise<void>> = []

  disposeOnBuildFinish(disposer: () => Promise<void>) {
    this.toDispose.push(disposer)
  }

  //noinspection JSUnusedGlobalSymbols
  constructor(options: PackagerOptions, readonly cancellationToken = new CancellationToken()) {
    if ("devMetadata" in options) {
      throw new InvalidConfigurationError("devMetadata in the options is deprecated, please use config instead")
    }
    if ("extraMetadata" in options) {
      throw new InvalidConfigurationError("extraMetadata in the options is deprecated, please use config.extraMetadata instead")
    }

    const targets = options.targets || new Map<Platform, Map<Arch, Array<string>>>()
    if (options.targets == null) {
      options.targets = targets
    }

    function processTargets(platform: Platform, types: Array<string>) {
      function commonArch(currentIfNotSpecified: boolean): Array<Arch> {
        const result = Array<Arch>()
        return result.length === 0 && currentIfNotSpecified ? [archFromString(process.arch)] : result
      }

      let archToType = targets.get(platform)
      if (archToType == null) {
        archToType = new Map<Arch, Array<string>>()
        targets.set(platform, archToType)
      }

      if (types.length === 0) {
        for (const arch of commonArch(false)) {
          archToType.set(arch, [])
        }
        return
      }

      for (const type of types) {
        const suffixPos = type.lastIndexOf(":")
        if (suffixPos > 0) {
          addValue(archToType, archFromString(type.substring(suffixPos + 1)), type.substring(0, suffixPos))
        } else {
          for (const arch of commonArch(true)) {
            addValue(archToType, arch, type)
          }
        }
      }
    }

    if (options.mac != null) {
      processTargets(Platform.MAC, options.mac)
    }
    if (options.linux != null) {
      processTargets(Platform.LINUX, options.linux)
    }
    if (options.win != null) {
      processTargets(Platform.WINDOWS, options.win)
    }

    this.projectDir = options.projectDir == null ? process.cwd() : path.resolve(options.projectDir)
    this._appDir = this.projectDir
    this.options = {
      ...options,
      prepackaged: options.prepackaged == null ? null : path.resolve(this.projectDir, options.prepackaged),
    }

    try {
      log.info({ version: PACKAGE_VERSION, os: getOsRelease() }, "electron-builder")
    } catch (e) {
      // error in dev mode without babel
      if (!(e instanceof ReferenceError)) {
        throw e
      }
    }
  }

  addAfterPackHandler(handler: (context: AfterPackContext) => Promise<any> | null) {
    this.afterPackHandlers.push(handler)
  }

  artifactCreated(handler: (event: ArtifactCreated) => void): Packager {
    addHandler(this.eventEmitter, "artifactCreated", handler)
    return this
  }

  async callArtifactBuildStarted(event: ArtifactBuildStarted, logFields?: any): Promise<void> {
    log.info(
      logFields || {
        target: event.targetPresentableName,
        arch: event.arch == null ? null : Arch[event.arch],
        file: log.filePath(event.file),
      },
      "building"
    )
    const handler = resolveFunction(this.config.artifactBuildStarted, "artifactBuildStarted")
    if (handler != null) {
      await Promise.resolve(handler(event))
    }
  }

  /**
   * Only for sub artifacts (update info), for main artifacts use `callArtifactBuildCompleted`.
   */
  dispatchArtifactCreated(event: ArtifactCreated): void {
    this.eventEmitter.emit("artifactCreated", event)
  }

  async callArtifactBuildCompleted(event: ArtifactCreated): Promise<void> {
    this.dispatchArtifactCreated(event)

    const handler = resolveFunction(this.config.artifactBuildCompleted, "artifactBuildCompleted")
    if (handler != null) {
      await Promise.resolve(handler(event))
    }
  }

  async callMsiProjectCreated(path: string): Promise<void> {
    const handler = resolveFunction(this.config.msiProjectCreated, "msiProjectCreated")
    if (handler != null) {
      await Promise.resolve(handler(path))
    }
  }

  async build(): Promise<BuildResult> {
    let configPath: string | null = null
    let configFromOptions = this.options.config
    if (typeof configFromOptions === "string") {
      // it is a path to config file
      configPath = configFromOptions
      configFromOptions = null
    } else if (configFromOptions != null && typeof configFromOptions.extends === "string" && configFromOptions.extends.includes(".")) {
      configPath = configFromOptions.extends
      delete configFromOptions.extends
    }

    const projectDir = this.projectDir

    const devPackageFile = path.join(projectDir, "package.json")
    this._devMetadata = await orNullIfFileNotExist(readPackageJson(devPackageFile))

    const devMetadata = this.devMetadata
    const configuration = await getConfig(projectDir, configPath, configFromOptions, new Lazy(() => Promise.resolve(devMetadata)))
    if (log.isDebugEnabled) {
      log.debug({ config: getSafeEffectiveConfig(configuration) }, "effective config")
    }

    this._appDir = await computeDefaultAppDirectory(projectDir, configuration.directories!.app)
    this.isTwoPackageJsonProjectLayoutUsed = this._appDir !== projectDir

    const appPackageFile = this.isTwoPackageJsonProjectLayoutUsed ? path.join(this.appDir, "package.json") : devPackageFile

    // tslint:disable:prefer-conditional-expression
    if (configuration.rawApp?.metadata != null) {
      this._metadata = configuration.rawApp.metadata
    }
    else if (this.devMetadata != null && !this.isTwoPackageJsonProjectLayoutUsed) {
      this._metadata = this.devMetadata
    }
    else {
      this._metadata = await this.readProjectMetadataIfTwoPackageStructureOrPrepacked(appPackageFile)
    }
    deepAssign(this.metadata, configuration.extraMetadata)

    if (this.isTwoPackageJsonProjectLayoutUsed) {
      log.debug({ devPackageFile, appPackageFile }, "two package.json structure is used")
    }
    checkMetadata(this.metadata, this.devMetadata, appPackageFile, devPackageFile)

    return await this._build(configuration, this._metadata, this._devMetadata)
  }

  // external caller of this method always uses isTwoPackageJsonProjectLayoutUsed=false and appDir=projectDir, no way (and need) to use another values
  async _build(configuration: Configuration, metadata: Metadata, devMetadata: Metadata | null): Promise<BuildResult> {
    await validateConfig(configuration, this.debugLogger)
    this._configuration = configuration
    this._metadata = metadata
    this._devMetadata = devMetadata

    this._appInfo = new AppInfo(this, null)
    this._framework = await createFrameworkInfo(this.config, this)

    const commonOutDirWithoutPossibleOsMacro = path.resolve(
      this.projectDir,
      expandMacro(configuration.directories!.output!, null, this._appInfo, {
        os: "",
      })
    )

    if ((process.stdout as any).isTTY) {
      const effectiveConfigFile = path.join(commonOutDirWithoutPossibleOsMacro, "builder-effective-config.yaml")
      log.info({ file: log.filePath(effectiveConfigFile) }, "writing effective config")
      await outputFile(effectiveConfigFile, getSafeEffectiveConfig(configuration))
    }

    // because artifact event maybe dispatched several times for different publish providers
    const artifactPaths = new Set<string>()
    this.artifactCreated(event => {
      if (event.file != null) {
        artifactPaths.add(event.file)
      }
    })

    this.disposeOnBuildFinish(() => this.tempDirManager.cleanup())
    const platformToTargets = await executeFinally(this.doBuild(), async () => {
      if (this.debugLogger.isEnabled) {
        await this.debugLogger.save(path.join(commonOutDirWithoutPossibleOsMacro, "builder-debug.yml"))
      }

      const toDispose = this.toDispose.slice()
      this.toDispose.length = 0
      for (const disposer of toDispose) {
        await disposer().catch(e => {
          log.warn({ error: e }, "cannot dispose")
        })
      }
    })

    return {
      outDir: commonOutDirWithoutPossibleOsMacro,
      artifactPaths: Array.from(artifactPaths),
      platformToTargets,
      configuration,
    }
  }

  private async readProjectMetadataIfTwoPackageStructureOrPrepacked(appPackageFile: string): Promise<Metadata> {
    let data;
    const asarPrebuiltPath = ((this.options.config as Partial<Configuration> | null | undefined)?.asar as Partial<AsarOptions> | null | undefined)?.prebuiltPath;
    if (asarPrebuiltPath != null) {
      data = await orNullIfFileNotExist(readAsarJson(path.join(path.resolve(this.projectDir, asarPrebuiltPath)), "package.json"));
      if (data != null) {
        this._isPrepackedAppAsar = true;
        this._nodeModulesHandledExternally = true;
        return data;
      }
    }
    data = await orNullIfFileNotExist(readPackageJson(appPackageFile));
    if (data != null) {
      return data
    }

    data = await orNullIfFileNotExist(readAsarJson(path.join(this.projectDir, "app.asar"), "package.json"))
    if (data != null) {
      this._isPrepackedAppAsar = true
      return data
    }

    throw new Error(`Cannot find package.json in the ${path.dirname(appPackageFile)}`)
  }

  private async doBuild(): Promise<Map<Platform, Map<string, Target>>> {
    const taskManager = new AsyncTaskManager(this.cancellationToken)

    const platformToTarget = new Map<Platform, Map<string, Target>>()
    const createdOutDirs = new Set<string>()

    for (const [platform, archToType] of this.options.targets!) {
      if (this.cancellationToken.cancelled) {
        break
      }

      if (platform === Platform.MAC && process.platform === Platform.WINDOWS.nodeName) {
        throw new InvalidConfigurationError("Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build")
      }

      const packager = await this.createHelper(platform)
      const nameToTarget: Map<string, Target> = new Map()
      platformToTarget.set(platform, nameToTarget)

      for (const [arch, targetNames] of computeArchToTargetNamesMap(archToType, packager, platform)) {
        if (this.cancellationToken.cancelled) {
          break
        }

        // support os and arch macro in output value
        const outDir = path.resolve(this.projectDir, packager.expandMacro(this._configuration!.directories!.output!, Arch[arch]))
        const targetList = createTargets(nameToTarget, targetNames.length === 0 ? packager.defaultTarget : targetNames, outDir, packager)
        await createOutDirIfNeed(targetList, createdOutDirs)
        await packager.pack(outDir, arch, targetList, taskManager)
      }

      if (this.cancellationToken.cancelled) {
        break
      }

      for (const target of nameToTarget.values()) {
        taskManager.addTask(target.finishBuild())
      }
    }

    await taskManager.awaitTasks()
    return platformToTarget
  }

  private async createHelper(platform: Platform): Promise<PlatformPackager<any>> {
    if (this.options.platformPackagerFactory != null) {
      return this.options.platformPackagerFactory(this, platform)
    }

    switch (platform) {
      case Platform.MAC: {
        const helperClass = (await import("./macPackager")).default
        return new helperClass(this)
      }

      case Platform.WINDOWS: {
        const helperClass = (await import("./winPackager")).WinPackager
        return new helperClass(this)
      }

      case Platform.LINUX:
        return new (await import("./linuxPackager")).LinuxPackager(this)

      default:
        throw new Error(`Unknown platform: ${platform}`)
    }
  }

  async afterPack(context: AfterPackContext): Promise<any> {
    const afterPack = resolveFunction(this.config.afterPack, "afterPack")
    const handlers = this.afterPackHandlers.slice()
    if (afterPack != null) {
      // user handler should be last
      handlers.push(afterPack)
    }

    for (const handler of handlers) {
      await Promise.resolve(handler(context))
    }
  }
}

function createOutDirIfNeed(targetList: Array<Target>, createdOutDirs: Set<string>): Promise<any> {
  const ourDirs = new Set<string>()
  for (const target of targetList) {
    // noinspection SuspiciousInstanceOfGuard
    if (target instanceof NoOpTarget) {
      continue
    }

    const outDir = target.outDir
    if (!createdOutDirs.has(outDir)) {
      ourDirs.add(outDir)
    }
  }

  if (ourDirs.size === 0) {
    return Promise.resolve()
  }

  return Promise.all(
    Array.from(ourDirs)
      .sort()
      .map(dir => {
        return mkdirs(dir)
          .then(() => chmod(dir, 0o755) /* set explicitly */)
          .then(() => createdOutDirs.add(dir))
      })
  )
}

class RawAppFramework implements Framework {
  constructor(private readonly rawApp: RawAppOptions) {

  }

  readonly defaultAppIdPrefix = "";
  readonly isCopyElevateHelper = true;
  readonly macOsDefaultTargets = [];

  get name() { return this.rawApp.metadata.name; }
  get version() { return this.rawApp.metadata.version; }

  get distMacOsAppName(): string { throw Error("distMacOsAppName is not applicable to 'rawApp'") }

  prepareApplicationStageDirectory(): Promise<any> {
    return Promise.resolve(undefined);
  }
}

export interface BuildResult {
  readonly outDir: string
  readonly artifactPaths: Array<string>
  readonly platformToTargets: Map<Platform, Map<string, Target>>
  readonly configuration: Configuration
}

function getSafeEffectiveConfig(configuration: Configuration): string {
  const o = JSON.parse(safeStringifyJson(configuration))
  if (o.cscLink != null) {
    o.cscLink = "<hidden by builder>"
  }
  return serializeToYaml(o, true)
}
