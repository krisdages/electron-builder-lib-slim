import BluebirdPromise from "bluebird-lst"
import { AsyncTaskManager, log } from "builder-util"
import { CONCURRENCY, FileCopier, FileTransformer, Link, MAX_FILE_REQUESTS, statOrNull, walk } from "builder-util/out/fs"
import { Stats } from "fs"
import { mkdir, readlink, symlink } from "fs/promises"
import * as path from "path"
import { isLibOrExe } from "../asar/unpackDetector"
import { Platform } from "../core"
import { excludedExts, FileMatcher } from "../fileMatcher"
import { NODE_MODULES_PATTERN } from "../fileTransformer"
import { Packager } from "../packager"
import { PlatformPackager } from "../platformPackager"
import { AppFileWalker } from "./AppFileWalker"
import { NodeModuleCopyHelper } from "./NodeModuleCopyHelper"

export function getDestinationPath(file: string, fileSet: ResolvedFileSet) {
  if (file === fileSet.src) {
    return fileSet.destination
  } else {
    const src = fileSet.src
    const dest = fileSet.destination
    if (file.length > src.length && file.startsWith(src) && file[src.length] === path.sep) {
      return dest + file.substring(src.length)
    } else {
      // hoisted node_modules
      // not lastIndexOf, to ensure that nested module (top-level module depends on) copied to parent node_modules, not to top-level directory
      // project https://github.com/angexis/punchcontrol/commit/cf929aba55c40d0d8901c54df7945e1d001ce022
      let index = file.indexOf(NODE_MODULES_PATTERN)
      if (index < 0 && file.endsWith(`${path.sep}node_modules`)) {
        index = file.length - 13
      }
      if (index < 0) {
        throw new Error(`File "${file}" not under the source directory "${fileSet.src}"`)
      }
      return dest + file.substring(index)
    }
  }
}

export async function copyAppFiles(fileSet: ResolvedFileSet, packager: Packager, transformer: FileTransformer) {
  const metadata = fileSet.metadata
  // search auto unpacked dir
  const taskManager = new AsyncTaskManager(packager.cancellationToken)
  const createdParentDirs = new Set<string>()

  const fileCopier = new FileCopier(file => {
    // https://github.com/electron-userland/electron-builder/issues/3038
    return !(isLibOrExe(file) || file.endsWith(".node"))
  }, transformer)
  const links: Array<Link> = []
  for (let i = 0, n = fileSet.files.length; i < n; i++) {
    const sourceFile = fileSet.files[i]
    const stat = metadata.get(sourceFile)
    if (stat == null) {
      // dir
      continue
    }

    const destinationFile = getDestinationPath(sourceFile, fileSet)
    if (stat.isSymbolicLink()) {
      links.push({ file: destinationFile, link: await readlink(sourceFile) })
      continue
    }

    const fileParent = path.dirname(destinationFile)
    if (!createdParentDirs.has(fileParent)) {
      createdParentDirs.add(fileParent)
      await mkdir(fileParent, { recursive: true })
    }

    taskManager.addTask(fileCopier.copy(sourceFile, destinationFile, stat))
    if (taskManager.tasks.length > MAX_FILE_REQUESTS) {
      await taskManager.awaitTasks()
    }
  }

  if (taskManager.tasks.length > 0) {
    await taskManager.awaitTasks()
  }
  if (links.length > 0) {
    await BluebirdPromise.map(links, it => symlink(it.link, it.file), CONCURRENCY)
  }
}

// os path separator is used
export interface ResolvedFileSet {
  src: string
  destination: string

  files: Array<string>
  metadata: Map<string, Stats>
  transformedFiles?: Map<number, string | Buffer> | null
}

// used only for ASAR, if no asar, file transformed on the fly
export async function transformFiles(transformer: FileTransformer, fileSet: ResolvedFileSet): Promise<void> {
  if (transformer == null) {
    return
  }

  let transformedFiles = fileSet.transformedFiles
  if (fileSet.transformedFiles == null) {
    transformedFiles = new Map()
    fileSet.transformedFiles = transformedFiles
  }

  const metadata = fileSet.metadata
  await BluebirdPromise.filter(
    fileSet.files,
    (it, index) => {
      const fileStat = metadata.get(it)
      if (fileStat == null || !fileStat.isFile()) {
        return false
      }

      const transformedValue = transformer(it)
      if (transformedValue == null) {
        return false
      }

      if (typeof transformedValue === "object" && "then" in transformedValue) {
        return (transformedValue as Promise<any>).then(it => {
          if (it != null) {
            transformedFiles!.set(index, it)
          }
          return false
        })
      }
      transformedFiles!.set(index, transformedValue as string | Buffer)
      return false
    },
    CONCURRENCY
  )
}

export async function computeFileSets(
  matchers: Array<FileMatcher>,
  transformer: FileTransformer | null,
  platformPackager: PlatformPackager<any>
): Promise<Array<ResolvedFileSet>> {
  const fileSets: Array<ResolvedFileSet> = []
  const packager = platformPackager.info

  for (const matcher of matchers) {
    const fileWalker = new AppFileWalker(matcher, packager)

    const fromStat = await statOrNull(matcher.from)
    if (fromStat == null) {
      log.debug({ directory: matcher.from, reason: "doesn't exist" }, `skipped copying`)
      continue
    }

    const files = await walk(matcher.from, fileWalker.filter, fileWalker)
    const metadata = fileWalker.metadata
    fileSets.push(validateFileSet({ src: matcher.from, files, metadata, destination: matcher.to }))
  }

  return fileSets
}

function getNodeModuleExcludedExts(platformPackager: PlatformPackager<any>) {
  // do not exclude *.h files (https://github.com/electron-userland/electron-builder/issues/2852)
  const result = [".o", ".obj"].concat(excludedExts.split(",").map(it => `.${it}`))
  if (platformPackager.config.includePdb !== true) {
    result.push(".pdb")
  }
  if (platformPackager.platform !== Platform.WINDOWS) {
    // https://github.com/electron-userland/electron-builder/issues/1738
    result.push(".dll")
    result.push(".exe")
  }
  return result
}

function validateFileSet(fileSet: ResolvedFileSet): ResolvedFileSet {
  if (fileSet.src == null || fileSet.src.length === 0) {
    throw new Error("fileset src is empty")
  }
  return fileSet
}

/** @internal */
export async function computeNodeModuleFileSets(platformPackager: PlatformPackager<any>, mainMatcher: FileMatcher): Promise<Array<ResolvedFileSet>> {
  const deps = await platformPackager.info.getNodeDependencyInfo(platformPackager.platform).value
  const nodeModuleExcludedExts = getNodeModuleExcludedExts(platformPackager)
  // serial execution because copyNodeModules is concurrent and so, no need to increase queue/pressure
  const result = new Array<ResolvedFileSet>()
  let index = 0
  for (const info of deps) {
    const source = info.dir
    const destination = getDestinationPath(source, { src: mainMatcher.from, destination: mainMatcher.to, files: [], metadata: null as any })

    // use main matcher patterns, so, user can exclude some files in such hoisted node modules
    // source here includes node_modules, but pattern base should be without because users expect that pattern "!node_modules/loot-core/src{,/**/*}" will work
    const matcher = new FileMatcher(path.dirname(source), destination, mainMatcher.macroExpander, mainMatcher.patterns)
    const copier = new NodeModuleCopyHelper(matcher, platformPackager.info)
    const files = await copier.collectNodeModules(
      source,
      info.deps.map(it => it.name),
      nodeModuleExcludedExts
    )
    result[index++] = validateFileSet({ src: source, destination, files, metadata: copier.metadata })
  }
  return result
}
