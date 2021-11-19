import { Arch, MacConfiguration, Packager, Target } from "app-builder-lib"
import { getBinFromUrl } from "app-builder-lib/out/binDownload"
import { Identity } from "app-builder-lib/out/codeSign/macCodeSign"
import MacPackager from "app-builder-lib/out/macPackager"
import { WinPackager } from "app-builder-lib/out/winPackager"
import { AsyncTaskManager, isEmptyOrSpaces } from "builder-util"
import { DmgTarget } from "dmg-builder"
import { SignOptions as MacSignOptions } from "electron-osx-sign"
import * as path from "path"

export class CheckingWinPackager extends WinPackager {
  effectiveDistOptions: any

  constructor(info: Packager) {
    super(info)
  }

  //noinspection JSUnusedLocalSymbols
  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    // skip pack
    this.effectiveDistOptions = await new FakeWindowsTarget(this, outDir).computeEffectiveDistOptions()

    await this.sign(this.computeAppOutDir(outDir, arch))
  }

  //noinspection JSUnusedLocalSymbols
  packageInDistributableFormat(appOutDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): void {
    // skip
  }
}

export class CheckingMacPackager extends MacPackager {
  effectiveDistOptions: any
  effectiveSignOptions: MacSignOptions | null = null

  constructor(info: Packager) {
    super(info)
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): Promise<any> {
    for (const target of targets) {
      // do not use instanceof to avoid dmg require
      if (target.name === "dmg") {
        this.effectiveDistOptions = await (target as DmgTarget).computeDmgOptions()
        break
      }
    }
    // http://madole.xyz/babel-plugin-transform-async-to-module-method-gotcha/
    return await MacPackager.prototype.pack.call(this, outDir, arch, targets, taskManager)
  }

  //noinspection JSUnusedLocalSymbols
  async doPack(outDir: string, appOutDir: string, platformName: string, arch: Arch, customBuildOptions: MacConfiguration, targets: Array<Target>) {
    // skip
  }

  //noinspection JSUnusedGlobalSymbols
  async doSign(opts: MacSignOptions): Promise<any> {
    this.effectiveSignOptions = opts
  }

  //noinspection JSUnusedGlobalSymbols,JSUnusedLocalSymbols
  async doFlat(appPath: string, outFile: string, identity: Identity, keychain?: string | null): Promise<any> {
    // skip
  }

  //noinspection JSUnusedGlobalSymbols,JSUnusedLocalSymbols
  packageInDistributableFormat(appOutDir: string, arch: Arch, targets: Array<Target>, taskManager: AsyncTaskManager): void {
    // skip
  }

  protected async writeUpdateInfo(appOutDir: string, outDir: string) {
    // ignored
  }
}

class FakeWindowsTarget extends Target {
  //tslint:disable-next-line:no-object-literal-type-assertion
  readonly options = { ...this.packager.platformSpecificBuildOptions };

  constructor(private readonly packager: CheckingWinPackager, readonly outDir: string) {
    super("fake")
  }

  private get appName() {
    return this.packager.appInfo.name
  }

  build(): Promise<any> {
    throw Error("Not implemented");
  }

  async computeEffectiveDistOptions() {
    const packager = this.packager
    const iconUrl = "https://raw.githubusercontent.com/szwacz/electron-boilerplate/master/resources/windows/icon.ico"
    // let iconUrl = this.options.iconUrl
    // if (iconUrl == null) {
    //   const info = await packager.info.repositoryInfo
    //   if (info != null) {
    //     iconUrl = `https://github.com/${info.user}/${info.project}/blob/master/${packager.info.relativeBuildResourcesDirname}/icon.ico?raw=true`
    //   }
    //
    //   if (iconUrl == null) {
    //     throw new InvalidConfigurationError(
    //       "squirrelWindows.iconUrl is not specified, please see https://www.electron.build/configuration/squirrel-windows#SquirrelWindowsOptions-iconUrl"
    //     )
    //   }
    // }

    const appInfo = packager.appInfo
    const projectUrl = await appInfo.computePackageUrl()
    const appName = this.appName
    const options = {
      name: appName,
      productName: appInfo.productName,
      appId: appName,
      version: appInfo.version,
      description: appInfo.description,
      // better to explicitly set to empty string, to avoid any nugget errors
      authors: appInfo.companyName || "",
      iconUrl,
      extraMetadataSpecs: projectUrl == null ? null : `\n    <projectUrl>${projectUrl}</projectUrl>`,
      copyright: appInfo.copyright,
      packageCompressionLevel: parseInt((process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || packager.compression === "store" ? 0 : 9) as any, 10),
      vendorPath: await getBinFromUrl("Squirrel.Windows", "1.9.0", "zJHk4CMATM7jHJ2ojRH1n3LkOnaIezDk5FAzJmlSEQSiEdRuB4GGLCegLDtsRCakfHIVfKh3ysJHLjynPkXwhQ=="),
      ...(this.options as any),
    }

    if (isEmptyOrSpaces(options.description)) {
      options.description = options.productName
    }

    if (!("loadingGif" in options)) {
      const resourceList = await packager.resourceList
      if (resourceList.includes("install-spinner.gif")) {
        options.loadingGif = path.join(packager.buildResourcesDir, "install-spinner.gif")
      }
    }

    return options
  }
}
