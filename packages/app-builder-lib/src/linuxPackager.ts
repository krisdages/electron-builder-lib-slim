import { DIR_TARGET, Platform, Target } from "./core"
import { LinuxConfiguration } from "./options/linuxOptions"
import { Packager } from "./packager"
import { PlatformPackager } from "./platformPackager"
import AppImageTarget from "./targets/AppImageTarget"
import { LinuxTargetHelper } from "./targets/LinuxTargetHelper"
import { createCommonTarget } from "./targets/targetFactory"
import { sanitizeFileName } from "./util/filename"

export class LinuxPackager extends PlatformPackager<LinuxConfiguration> {
  readonly executableName: string

  constructor(info: Packager) {
    super(info, Platform.LINUX)

    const executableName = this.platformSpecificBuildOptions.executableName
    this.executableName = executableName == null ? this.appInfo.sanitizedName.toLowerCase() : sanitizeFileName(executableName)
  }

  get defaultTarget(): Array<string> {
    return ["appimage"]
  }

  createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void): void {
    let helper: LinuxTargetHelper | null
    const getHelper = () => {
      if (helper == null) {
        helper = new LinuxTargetHelper(this)
      }
      return helper
    }

    for (const name of targets) {
      if (name === DIR_TARGET) {
        continue
      }

      const targetClass: typeof AppImageTarget | null = (() => {
        switch (name) {
          case "appimage":
            return require("./targets/AppImageTarget").default
          default:
            return null
        }
      })()

      mapper(name, outDir => {
        if (targetClass === null) {
          return createCommonTarget(name, outDir, this)
        }

        const target = new targetClass(name, this, getHelper(), outDir)
        if (process.platform === "win32") {
          throw new Error("Linux build on Windows not supported. Use WSL.");
        }
        return target
      })
    }
  }
}
