import BluebirdPromise from "bluebird-lst"
import { Arch, log, safeStringifyJson, serializeToYaml } from "builder-util"
import { GenericServerOptions, PublishConfiguration, UpdateInfo } from "builder-util-runtime"
import { outputFile, readFile } from "fs-extra"
import * as path from "path"
import { Platform } from "../core"
import { ReleaseInfo } from "../options/PlatformSpecificBuildOptions"
import { Packager } from "../packager"
import { ArtifactCreated } from "../packagerApi"
import { PlatformPackager } from "../platformPackager"
import { hashFile } from "../util/hash"

async function getReleaseInfo(packager: PlatformPackager<any>) {
  const releaseInfo: ReleaseInfo = { ...(packager.platformSpecificBuildOptions.releaseInfo || packager.config.releaseInfo) }
  if (releaseInfo.releaseNotes == null) {
    const releaseNotesFile = await packager.getResource(
      releaseInfo.releaseNotesFile,
      `release-notes-${packager.platform.buildConfigurationKey}.md`,
      `release-notes-${packager.platform.name}.md`,
      `release-notes-${packager.platform.nodeName}.md`,
      "release-notes.md"
    )
    const releaseNotes = releaseNotesFile == null ? null : await readFile(releaseNotesFile, "utf-8")
    // to avoid undefined in the file, check for null
    if (releaseNotes != null) {
      releaseInfo.releaseNotes = releaseNotes
    }
  }
  delete releaseInfo.releaseNotesFile
  return releaseInfo
}

function isGenerateUpdatesFilesForAllChannels(packager: PlatformPackager<any>) {
  const value = packager.platformSpecificBuildOptions.generateUpdatesFilesForAllChannels
  return value == null ? packager.config.generateUpdatesFilesForAllChannels : value
}

/**
 if this is an "alpha" version, we need to generate only the "alpha" .yml file
 if this is a "beta" version, we need to generate both the "alpha" and "beta" .yml file
 if this is a "stable" version, we need to generate all the "alpha", "beta" and "stable" .yml file
 */
function computeChannelNames(packager: PlatformPackager<any>, publishConfig: PublishConfiguration): Array<string> {
  const currentChannel: string = (publishConfig as GenericServerOptions).channel || "latest"
  // for GitHub should be pre-release way be used
  if (currentChannel === "alpha" || !isGenerateUpdatesFilesForAllChannels(packager)) {
    return [currentChannel]
  }

  switch (currentChannel) {
    case "beta":
      return [currentChannel, "alpha"]

    case "latest":
      return [currentChannel, "alpha", "beta"]

    default:
      return [currentChannel]
  }
}

function getUpdateInfoFileName(channel: string, packager: PlatformPackager<any>, arch: Arch | null): string {
  const osSuffix = packager.platform === Platform.WINDOWS ? "" : `-${packager.platform.buildConfigurationKey}`
  return `${channel}${osSuffix}${getArchPrefixForUpdateFile(arch, packager)}.yml`
}

function getArchPrefixForUpdateFile(arch: Arch | null, packager: PlatformPackager<any>) {
  if (arch == null || arch === Arch.x64 || packager.platform !== Platform.LINUX) {
    return ""
  }
  return arch === Arch.armv7l ? "-arm" : `-${Arch[arch]}`
}

export interface UpdateInfoFileTask {
  readonly file: string
  readonly info: UpdateInfo
  readonly publishConfiguration: PublishConfiguration

  readonly packager: PlatformPackager<any>
}

/** @internal */
export async function createUpdateInfoTasks(event: ArtifactCreated, publishConfigs: Array<PublishConfiguration>): Promise<Array<UpdateInfoFileTask>> {
  const packager = event.packager
  if (publishConfigs == null || publishConfigs.length === 0) {
    return []
  }

  const outDir = event.target!.outDir
  const version = packager.appInfo.version
  const createdFiles = new Set<string>()
  const sharedInfo = await createUpdateInfo(version, event, await getReleaseInfo(packager))
  const tasks: Array<UpdateInfoFileTask> = []
  for (const publishConfiguration of publishConfigs) {
    let dir = outDir
    // Bintray uses different variant of channel file info, better to generate it to a separate dir by always
    if (/*isBintray || */ (publishConfigs.length > 1 && publishConfiguration !== publishConfigs[0])) {
      dir = path.join(outDir, publishConfiguration.provider)
    }

    let info = sharedInfo

    for (const channel of computeChannelNames(packager, publishConfiguration)) {
      const updateInfoFile = path.join(dir, getUpdateInfoFileName(channel, packager, event.arch))
      if (createdFiles.has(updateInfoFile)) {
        continue
      }

      createdFiles.add(updateInfoFile)

      // artifact should be uploaded only to designated publish provider
      tasks.push({
        file: updateInfoFile,
        info,
        publishConfiguration,
        packager,
      })
    }
  }
  return tasks
}

async function createUpdateInfo(version: string, event: ArtifactCreated, releaseInfo: ReleaseInfo): Promise<UpdateInfo> {
  const customUpdateInfo = event.updateInfo
  const url = path.basename(event.file)
  const sha512 = (customUpdateInfo == null ? null : customUpdateInfo.sha512) || (await hashFile(event.file))
  const files = [{ url, sha512 }]
  const result: UpdateInfo = {
    // @ts-ignore
    version,
    // @ts-ignore
    files,
    // @ts-ignore
    path: url /* backward compatibility, electron-updater 1.x - electron-updater 2.15.0 */,
    // @ts-ignore
    sha512 /* backward compatibility, electron-updater 1.x - electron-updater 2.15.0 */,
    ...(releaseInfo as UpdateInfo),
  }

  if (customUpdateInfo != null) {
    // file info or nsis web installer packages info
    Object.assign("sha512" in customUpdateInfo ? files[0] : result, customUpdateInfo)
  }
  return result
}

export async function writeUpdateInfoFiles(updateInfoFileTasks: Array<UpdateInfoFileTask>, packager: Packager) {
  // zip must be first and zip info must be used for old path/sha512 properties in the update info
  updateInfoFileTasks.sort((a, b) => (a.info.files[0].url.endsWith(".zip") ? 0 : 100) - (b.info.files[0].url.endsWith(".zip") ? 0 : 100))

  const updateChannelFileToInfo = new Map<string, UpdateInfoFileTask>()
  for (const task of updateInfoFileTasks) {
    // https://github.com/electron-userland/electron-builder/pull/2994
    const key = `${task.file}@${safeStringifyJson(task.publishConfiguration, new Set(["releaseType"]))}`
    const existingTask = updateChannelFileToInfo.get(key)
    if (existingTask == null) {
      updateChannelFileToInfo.set(key, task)
      continue
    }

    existingTask.info.files.push(...task.info.files)
  }

  const releaseDate = new Date().toISOString()
  await BluebirdPromise.map(
    updateChannelFileToInfo.values(),
    async task => {
      const publishConfig = task.publishConfiguration
      if (publishConfig.publishAutoUpdate === false) {
        log.debug(
          {
            provider: publishConfig.provider,
            reason: "publishAutoUpdate is set to false",
          },
          "auto update metadata file not published"
        )
        return
      }

      if (task.info.releaseDate == null) {
        task.info.releaseDate = releaseDate
      }

      const fileContent = Buffer.from(serializeToYaml(task.info, false, true))
      await outputFile(task.file, fileContent)
      packager.dispatchArtifactCreated({
        file: task.file,
        fileContent,
        arch: null,
        packager: task.packager,
        target: null,
        publishConfig,
      })
    },
    { concurrency: 4 }
  )
}
