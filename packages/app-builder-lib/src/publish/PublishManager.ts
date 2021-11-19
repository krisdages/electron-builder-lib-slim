import BluebirdPromise from "bluebird-lst"
import { Arch, asArray, AsyncTaskManager, InvalidConfigurationError, log, safeStringifyJson, serializeToYaml } from "builder-util"
import { CancellationToken, GenericServerOptions, PublishConfiguration, } from "builder-util-runtime"
import _debug from "debug"
import { writeFile } from "fs/promises"
import * as path from "path"
import * as url from "url"
import { ArtifactCreated, Configuration, Platform, PlatformSpecificBuildOptions, Target } from "../index"
import { Packager } from "../packager"
import { PlatformPackager } from "../platformPackager"
import { expandMacro } from "../util/macroExpander"
import { WinPackager } from "../winPackager"
import { createUpdateInfoTasks, UpdateInfoFileTask, writeUpdateInfoFiles } from "./updateInfoBuilder"

const debug = _debug("electron-builder:publish")

export class PublishManager {

  private readonly taskManager: AsyncTaskManager

  readonly isPublish: boolean = false

  private readonly updateFileWriteTask: Array<UpdateInfoFileTask> = []

  constructor(private readonly packager: Packager, readonly cancellationToken: CancellationToken = packager.cancellationToken) {
    this.taskManager = new AsyncTaskManager(cancellationToken)

    packager.addAfterPackHandler(async event => {
      const packager = event.packager
      if (event.electronPlatformName === "darwin") {
        if (!event.targets.some(it => it.name === "dmg" || it.name === "zip")) {
          return
        }
      } else if (packager.platform === Platform.WINDOWS) {
        if (!event.targets.some(it => isSuitableWindowsTarget(it))) {
          return
        }
      } else {
        // AppImage writes data to AppImage stage dir, not to linux-unpacked
        return
      }

      const publishConfig = await getAppUpdatePublishConfiguration(packager, event.arch, this.isPublish)
      if (publishConfig != null) {
        await writeFile(path.join(packager.getResourcesDir(event.appOutDir), "app-update.yml"), serializeToYaml(publishConfig))
      }
    })

    packager.artifactCreated(event => {
      const publishConfiguration = event.publishConfig
      if (publishConfiguration == null) {
        this.taskManager.addTask(this.artifactCreatedWithoutExplicitPublishConfig(event))
      } else if (this.isPublish) {
        if (debug.enabled) {
          debug(`artifactCreated (isPublish: ${this.isPublish}): ${safeStringifyJson(event, new Set(["packager"]))},\n  publishConfig: ${safeStringifyJson(publishConfiguration)}`)
        }
      }
    })
  }

  async getGlobalPublishConfigurations(): Promise<Array<PublishConfiguration> | null> {
    const publishers = this.packager.config.publish
    return await resolvePublishConfigurations(publishers, null, this.packager, null, true)
  }

  private async artifactCreatedWithoutExplicitPublishConfig(event: ArtifactCreated) {
    const platformPackager = event.packager
    const target = event.target
    const publishConfigs = await getPublishConfigs(platformPackager, target == null ? null : target.options, event.arch, this.isPublish)

    if (debug.enabled) {
      debug(`artifactCreated (isPublish: ${this.isPublish}): ${safeStringifyJson(event, new Set(["packager"]))},\n  publishConfigs: ${safeStringifyJson(publishConfigs)}`)
    }

    const eventFile = event.file
    if (publishConfigs == null) {
      if (this.isPublish) {
        log.debug({ file: eventFile, reason: "no publish configs" }, "not published")
      }
      return
    }

    if (
      event.isWriteUpdateInfo &&
      target != null &&
      eventFile != null &&
      !this.cancellationToken.cancelled &&
      (platformPackager.platform !== Platform.WINDOWS || isSuitableWindowsTarget(target))
    ) {
      this.taskManager.addTask(createUpdateInfoTasks(event, publishConfigs).then(it => this.updateFileWriteTask.push(...it)))
    }
  }

  // noinspection JSUnusedGlobalSymbols
  cancelTasks() {
    this.taskManager.cancelTasks()
  }

  async awaitTasks(): Promise<void> {
    await this.taskManager.awaitTasks()

    const updateInfoFileTasks = this.updateFileWriteTask
    if (this.cancellationToken.cancelled || updateInfoFileTasks.length === 0) {
      return
    }

    await writeUpdateInfoFiles(updateInfoFileTasks, this.packager)
    await this.taskManager.awaitTasks()
  }
}

export async function getAppUpdatePublishConfiguration(packager: PlatformPackager<any>, arch: Arch, errorIfCannot: boolean) {
  const publishConfigs = await getPublishConfigs(packager, null, arch, errorIfCannot)
  if (publishConfigs == null || publishConfigs.length === 0) {
    return null
  }

  const publishConfig = {
    ...publishConfigs[0],
    updaterCacheDirName: packager.appInfo.updaterCacheDirName,
  }

  if (packager.platform === Platform.WINDOWS && publishConfig.publisherName == null) {
    const winPackager = packager as WinPackager
    const publisherName = winPackager.isForceCodeSigningVerification ? await winPackager.computedPublisherName.value : undefined
    if (publisherName != null) {
      publishConfig.publisherName = publisherName
    }
  }
  return publishConfig
}

function requireProviderClass(provider: string, packager: Packager): any | null {
  switch (provider) {
    case "generic":
      return null
    default: {
      const name = `electron-publisher-${provider}`
      let module: any = null
      try {
        module = require(path.join(packager.buildResourcesDir, name + ".js"))
      } catch (ignored) {
        console.log(ignored)
      }

      if (module == null) {
        module = require(name)
      }
      return module.default || module
    }
  }
}

export function computeDownloadUrl(publishConfiguration: PublishConfiguration, fileName: string | null, packager: PlatformPackager<any>) {
  if (publishConfiguration.provider === "generic") {
    const baseUrlString = (publishConfiguration as GenericServerOptions).url
    if (fileName == null) {
      return baseUrlString
    }

    const baseUrl = url.parse(baseUrlString)
    return url.format({ ...(baseUrl as url.UrlObject), pathname: path.posix.resolve(baseUrl.pathname || "/", encodeURI(fileName)) })
  }
  return null
}

export async function getPublishConfigs(
  platformPackager: PlatformPackager<any>,
  targetSpecificOptions: PlatformSpecificBuildOptions | null | undefined,
  arch: Arch | null,
  errorIfCannot: boolean
): Promise<Array<PublishConfiguration> | null> {
  let publishers

  // check build.nsis (target)
  if (targetSpecificOptions != null) {
    publishers = targetSpecificOptions.publish
    // if explicitly set to null - do not publish
    if (publishers === null) {
      return null
    }
  }

  // check build.win (platform)
  if (publishers == null) {
    publishers = platformPackager.platformSpecificBuildOptions.publish
    if (publishers === null) {
      return null
    }
  }

  if (publishers == null) {
    publishers = platformPackager.config.publish
    if (publishers === null) {
      return null
    }
  }
  return await resolvePublishConfigurations(publishers, platformPackager, platformPackager.info, arch, errorIfCannot)
}

async function resolvePublishConfigurations(
  publishers: any,
  platformPackager: PlatformPackager<any> | null,
  packager: Packager,
  arch: Arch | null,
  errorIfCannot: boolean
): Promise<Array<PublishConfiguration> | null> {
  if (publishers == null) {
    return []
  }

  debug(`Explicit publish provider: ${safeStringifyJson(publishers)}`)
  return await (BluebirdPromise.map(asArray(publishers), it =>
    getResolvedPublishConfig(platformPackager, packager, typeof it === "string" ? { provider: it } : it, arch, errorIfCannot)
  ) as Promise<Array<PublishConfiguration>>)
}

function isSuitableWindowsTarget(target: Target) {
  return target.name === "nsis" || target.name.startsWith("nsis-")
}

function expandPublishConfig(options: any, platformPackager: PlatformPackager<any> | null, packager: Packager, arch: Arch | null): void {
  for (const name of Object.keys(options)) {
    const value = options[name]
    if (typeof value === "string") {
      const archValue = arch == null ? null : Arch[arch]
      const expanded = platformPackager == null ? expandMacro(value, archValue, packager.appInfo) : platformPackager.expandMacro(value, archValue)
      if (expanded !== value) {
        options[name] = expanded
      }
    }
  }
}

function isDetectUpdateChannel(platformSpecificConfiguration: PlatformSpecificBuildOptions | null, configuration: Configuration) {
  const value = platformSpecificConfiguration == null ? null : platformSpecificConfiguration.detectUpdateChannel
  return value == null ? configuration.detectUpdateChannel !== false : value
}

async function getResolvedPublishConfig(
  platformPackager: PlatformPackager<any> | null,
  packager: Packager,
  options: PublishConfiguration,
  arch: Arch | null,
  errorIfCannot: boolean
): Promise<PublishConfiguration | null> {
  options = { ...options }
  expandPublishConfig(options, platformPackager, packager, arch)

  let channelFromAppVersion: string | null = null
  if (
    (options as GenericServerOptions).channel == null &&
    isDetectUpdateChannel(platformPackager == null ? null : platformPackager.platformSpecificBuildOptions, packager.config)
  ) {
    channelFromAppVersion = packager.appInfo.channel
  }

  const provider = options.provider
  if (provider === "generic") {
    const o = options as GenericServerOptions
    if (o.url == null) {
      throw new InvalidConfigurationError(`Please specify "url" for "generic" update server`)
    }

    if (channelFromAppVersion != null) {
      ;(o as any).channel = channelFromAppVersion
    }
    return options
  }

  const providerClass = requireProviderClass(options.provider, packager)
  if (providerClass != null && providerClass.checkAndResolveOptions != null) {
    await providerClass.checkAndResolveOptions(options, channelFromAppVersion, errorIfCannot)
    return options
  }

  return options
}
