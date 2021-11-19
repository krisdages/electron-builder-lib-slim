import { executeFinally } from "builder-util/out/promise"
import { log, InvalidConfigurationError, Arch, archFromString } from "builder-util"
import { asArray } from "builder-util-runtime"
import { Platform } from "./core"
import { Packager } from "./packager"
import { PackagerOptions } from "./packagerApi"
import { resolveFunction } from "./platformPackager"
import { PublishManager } from "./publish/PublishManager"

export { Packager, BuildResult } from "./packager"
export { PackagerOptions, ArtifactCreated, ArtifactBuildStarted } from "./packagerApi"
export {
  TargetConfiguration,
  Platform,
  Target,
  DIR_TARGET,
  BeforeBuildContext,
  TargetSpecificOptions,
  TargetConfigType,
  DEFAULT_TARGET,
  CompressionLevel,
} from "./core"
export { getArchSuffix, Arch, archFromString } from "builder-util"
export { Configuration, AfterPackContext, MetadataDirectories } from "./configuration"
export { ElectronBrandingOptions, ElectronDownloadOptions, ElectronPlatformName } from "./electron/ElectronFramework"
export { PlatformSpecificBuildOptions, AsarOptions, FileSet, Protocol, ReleaseInfo } from "./options/PlatformSpecificBuildOptions"
export { FileAssociation } from "./options/FileAssociation"
export { MacConfiguration, DmgOptions, MacOsTargetName, DmgContent, DmgWindow } from "./options/macOptions"
export { WindowsConfiguration } from "./options/winOptions"
export { MsiOptions } from "./options/MsiOptions"
export { CommonWindowsInstallerConfiguration } from "./options/CommonWindowsInstallerConfiguration"
export { NsisOptions, NsisWebOptions, PortableOptions, CommonNsisOptions } from "./targets/nsis/nsisOptions"
export { LinuxConfiguration, DebOptions, CommonLinuxOptions, LinuxTargetSpecificOptions, AppImageOptions, FlatpakOptions } from "./options/linuxOptions"
export { Metadata, AuthorMetadata, RepositoryInfo } from "./options/metadata"
export { AppInfo } from "./appInfo"
export {
  WindowsSignOptions,
  CustomWindowsSignTaskConfiguration,
  WindowsSignTaskConfiguration,
  CustomWindowsSign,
  FileCodeSigningInfo,
  CertificateFromStoreInfo,
} from "./codeSign/windowsCodeSign"
export { CancellationToken, ProgressInfo } from "builder-util-runtime"
export { PublishManager } from "./publish/PublishManager"
export { PlatformPackager } from "./platformPackager"
export { Framework, PrepareApplicationStageDirectoryOptions } from "./Framework"

const expectedOptions = new Set(["publish", "targets", "mac", "win", "linux", "projectDir", "platformPackagerFactory", "config", "effectiveOptionComputed", "prepackaged"])

export function checkBuildRequestOptions(options: PackagerOptions) {
  for (const optionName of Object.keys(options)) {
    if (!expectedOptions.has(optionName) && (options as any)[optionName] !== undefined) {
      throw new InvalidConfigurationError(`Unknown option "${optionName}"`)
    }
  }
}

export function build(options: PackagerOptions, packager: Packager = new Packager(options)): Promise<Array<string>> {
  checkBuildRequestOptions(options)

  const publishManager = new PublishManager(packager)
  const sigIntHandler = () => {
    log.warn("cancelled by SIGINT")
    packager.cancellationToken.cancel()
    publishManager.cancelTasks()
  }
  process.once("SIGINT", sigIntHandler)

  const promise = packager.build().then(async buildResult => {
    const afterAllArtifactBuild = resolveFunction(buildResult.configuration.afterAllArtifactBuild, "afterAllArtifactBuild")
    if (afterAllArtifactBuild != null) {
      const newArtifacts = asArray(await Promise.resolve(afterAllArtifactBuild(buildResult)))
      if (newArtifacts.length === 0 || !publishManager.isPublish) {
        return buildResult.artifactPaths
      }

      const publishConfigurations = await publishManager.getGlobalPublishConfigurations()
      if (publishConfigurations == null || publishConfigurations.length === 0) {
        return buildResult.artifactPaths
      }

      for (const newArtifact of newArtifacts) {
        buildResult.artifactPaths.push(newArtifact)
      }
    }
    return buildResult.artifactPaths
  })

  return executeFinally(promise, isErrorOccurred => {
    let promise: Promise<any>
    if (isErrorOccurred) {
      publishManager.cancelTasks()
      promise = Promise.resolve(null)
    } else {
      promise = publishManager.awaitTasks()
    }

    return promise.then(() => process.removeListener("SIGINT", sigIntHandler))
  })
}

export function createTargets(platforms: Array<Platform>, type?: string | null, arch?: string | null): Map<Platform, Map<Arch, Array<string>>> {
  const targets = new Map<Platform, Map<Arch, Array<string>>>()
  for (const platform of platforms) {
    const archs =
      arch === "all" ? (platform === Platform.MAC ? [Arch.x64, Arch.arm64, Arch.universal] : [Arch.x64, Arch.ia32]) : [archFromString(arch == null ? process.arch : arch)]
    const archToType = new Map<Arch, Array<string>>()
    targets.set(platform, archToType)

    for (const arch of archs) {
      archToType.set(arch, type == null ? [] : [type])
    }
  }
  return targets
}
