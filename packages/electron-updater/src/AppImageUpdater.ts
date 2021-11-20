import { AllPublishOptions, newError } from "builder-util-runtime"
import { execFileSync, spawn } from "child_process"
import { chmod, ensureDir, move, symlink, statSync } from "fs-extra"
import { unlinkSync } from "fs"
import * as path from "path"
import { AppAdapter, ExternalAppAdapter } from "./AppAdapter"
import { DownloadUpdateOptions } from "./AppUpdater"
import { BaseUpdater, InstallOptions, InstallResultTuple } from "./BaseUpdater"
import { DifferentialDownloaderOptions } from "./differentialDownloader/DifferentialDownloader"
import { FileWithEmbeddedBlockMapDifferentialDownloader } from "./differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader"
import { DOWNLOAD_PROGRESS } from "./main"
import { findFile } from "./providers/Provider"

export interface ExternalAppImageAdapter extends ExternalAppAdapter {
  readonly appImageDestination: AppImageFileDestination | AppImageSymlinkDestination;
  readonly symlinkPath?: string;
  readonly backup: boolean | { readonly path: string };
}

export interface AppImageSymlinkDestination {
  readonly type: "symlink";
  readonly pathAbs: string;
  readonly targetPath: string;
}

export interface AppImageFileDestination {
  readonly type: "file";
  readonly pathAbs: string;
}

export class AppImageUpdater extends BaseUpdater {
  constructor(options?: AllPublishOptions | null, app?: AppAdapter | ExternalAppImageAdapter) {
    super(options, app)
  }

  readonly app!: AppAdapter | ExternalAppImageAdapter;

  public isUpdaterActive(): boolean {
    if (!this.app.isExternalApp && process.env["APPIMAGE"] == null) {
      if (process.env["SNAP"] == null) {
        this._logger.warn("APPIMAGE env is not defined, current application is not an AppImage")
      } else {
        this._logger.info("SNAP env is defined, updater is disabled")
      }
      return false
    }
    return super.isUpdaterActive()
  }

  /*** @private */
  protected doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider
    const fileInfo = findFile(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "AppImage")!
    return this.executeDownload({
      fileExtension: "AppImage",
      fileInfo,
      downloadUpdateOptions,
      task: async (updateFile, downloadOptions) => {
        const oldFile = process.env["APPIMAGE"]!
        if (oldFile == null) {
          throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
        }

        let isDownloadFull = false
        try {
          const downloadOptions: DifferentialDownloaderOptions = {
            newUrl: fileInfo.url,
            oldFile,
            logger: this._logger,
            newFile: updateFile,
            isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
            requestHeaders: downloadUpdateOptions.requestHeaders,
            cancellationToken: downloadUpdateOptions.cancellationToken,
          }

          if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
            downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
          }

          await new FileWithEmbeddedBlockMapDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download()
        } catch (e) {
          this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
          // during test (developer machine mac) we must throw error
          isDownloadFull = process.platform === "linux"
        }

        if (isDownloadFull) {
          await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions)
        }

        await chmod(updateFile, 0o755)
      },
    })
  }

  protected doInstall(options: InstallOptions): InstallResultTuple {
    let destination: string

    if (this.app.isExternalApp) {
      return [true, this._doInstallExternal(options, this.app)]
    }
    else {
      //TODO: The process of renaming/forceRun etc looks like it needs to be improved.

      const appImageFile = process.env["APPIMAGE"]!
      if (appImageFile == null) {
        throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
      }

      // https://stackoverflow.com/a/1712051/1910191
      unlinkSync(appImageFile)

      const existingBaseName = path.basename(appImageFile)
      // https://github.com/electron-userland/electron-builder/issues/2964
      // if no version in existing file name, it means that user wants to preserve current custom name
      if (path.basename(options.installerPath) === existingBaseName || !/\d+\.\d+\.\d+/.test(existingBaseName)) {
        // no version in the file name, overwrite existing
        destination = appImageFile
      } else {
        destination = path.join(path.dirname(appImageFile), path.basename(options.installerPath))
      }

      execFileSync("mv", ["-f", options.installerPath, destination])

      if (destination !== appImageFile) {
        this.emit("appimage-filename-updated", destination)
      }

      const env: any = {
        ...process.env,
        APPIMAGE_SILENT_INSTALL: "true",
      }

      if (options.isForceRunAfter) {
        return [true, Promise.resolve(spawn(destination, [], {
          detached: true,
          stdio: "ignore",
          env,
        }).unref())]
      } else {
        env.APPIMAGE_EXIT_AFTER_INSTALL = "true"
        return [true, Promise.resolve(execFileSync(destination, [], { env }))]
      }
    }
  }

  private async _doInstallExternal(options: InstallOptions, app: ExternalAppImageAdapter) {
    const { appImageDestination } = app;
    await ensureDir(path.dirname(appImageDestination.pathAbs))
    if (appImageDestination.type === "file") {
      await move(options.installerPath, appImageDestination.pathAbs, { overwrite: true });
    }
    else {
      const { targetPath, pathAbs: linkPathAbs } = appImageDestination;
      if (/* linkExists */ (() => { try { return statSync(linkPathAbs).isSymbolicLink() } catch { return false; } })()) {
        unlinkSync(linkPathAbs)
      }

      await Promise.all([
        move(options.installerPath, path.resolve(linkPathAbs, targetPath), { overwrite: true }),
        symlink(targetPath, linkPathAbs)
       ])
    }

    const env: any = {
      ...process.env,
      APPIMAGE_SILENT_INSTALL: "true",
    }

    return options.isForceRunAfter
      ? spawn(appImageDestination.pathAbs, [], {
        detached: true,
        stdio: "ignore",
        env,
      }).unref()
      : undefined;
  }
}
