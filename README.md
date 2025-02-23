## @krisdages/electron-builder-lib-slim<br/>@krisdages/electron-updater

#### This is an UNSUPPORTED fork of electron-builder and electron-updater intended to have a smaller footprint for only a few basic use cases:

* Programmatic use as a library
* Packaging without native dependencies
* Electron framework only for `win32`, `darwin`, and `linux` platforms
* Code signing
* Archive (e.g. zip, tar) targets 
* Auto-update targets (nsis, AppImage, dmg)
  * As of 2021-11, dmg auto-update is likely broken because the mac ZIP layout was changed
    and the app-update.yml file was removed. Will be addressing this soon.
* `generic` or `custom` updater feeds

Please refer to the main project for documentation, as docs were removed from this repo. 

### Additions/changes:
* `AsarOptions.prebuiltPath`: Prebuilt app.asar option similar to electron-packager
* `autoUpdater.useSemver = false` to compare update versions as string without the concept of upgrade/downgrade.
* Archive target layout prepends the archive name as a directory to all entries for all platforms.
  
### Removals
* CLI
* Publisher providers
* elevate.exe helper
* snap, deb, pkg, mas, Squirrel.Windows, and all other targets not listed above.
* node-gyp/electron-compile/rebuild etc
* Proton, libui frameworks
* CI detection
* Disabled the git hooks; test suites do not all pass since they were reliant on providers and targets 
  that were removed, and I haven't fixed them yet <br/>
  (sorry, I'm bad, I know, but I'm expecting to be the only consumer of this fork)

Original README follows:

# electron-builder [![npm version](https://img.shields.io/npm/v/electron-builder.svg?label=latest)](https://www.npmjs.com/package/electron-builder) [![downloads per month](https://img.shields.io/npm/dm/electron-builder.svg)](https://yarn.pm/electron-builder) [![donate](https://img.shields.io/badge/donate-donorbox-brightgreen.svg)](https://www.electron.build/donate) [![project discussions](https://img.shields.io/badge/discuss-on_github-blue.svg)](https://github.com/electron-userland/electron-builder/discussions)
A complete solution to package and build a ready for distribution [Electron](https://electronjs.org), [Proton Native](https://proton-native.js.org/) app for macOS, Windows and Linux with “auto update” support out of the box.

See documentation on [electron.build](https://www.electron.build).

* NPM packages management:
    * [Native application dependencies](https://electron.atom.io/docs/tutorial/using-native-node-modules/) compilation (including [Yarn](http://yarnpkg.com/) support).
    * Development dependencies are never included. You don't need to ignore them explicitly.
    * [Two package.json structure](https://www.electron.build/tutorials/two-package-structure) is supported, but you are not forced to use it even if you have native production dependencies.
* [Code Signing](https://www.electron.build/code-signing) on a CI server or development machine.
* [Auto Update](https://www.electron.build/auto-update) ready application packaging.
* Numerous target formats:
    * All platforms: `7z`, `zip`, `tar.xz`, `tar.7z`, `tar.lz`, `tar.gz`, `tar.bz2`, `dir` (unpacked directory).
    * [macOS](https://www.electron.build/configuration/mac): `dmg`, `pkg`, `mas`.
    * [Linux](https://www.electron.build/configuration/linux): [AppImage](http://appimage.org), [snap](http://snapcraft.io), debian package (`deb`), `rpm`, `freebsd`, `pacman`, `p5p`, `apk`.
    * [Windows](https://www.electron.build/configuration/win): `nsis` (Installer), `nsis-web` (Web installer), `portable` (portable app without installation), AppX (Windows Store), MSI, Squirrel.Windows.
* [Publishing artifacts](https://www.electron.build/configuration/publish) to GitHub Releases, Amazon S3, DigitalOcean Spaces and Bintray.
* Advanced building:
    * Pack in a distributable format [already packaged app](https://www.electron.build/#pack-only-in-a-distributable-format).
    * Separate [build steps](https://github.com/electron-userland/electron-builder/issues/1102#issuecomment-271845854).
    * Build and publish in parallel, using hard links on CI server to reduce IO and disk space usage.
    * [electron-compile](https://github.com/electron/electron-compile) support (compile for release-time on the fly on build).
* [Docker](https://www.electron.build/multi-platform-build#docker) images to build Electron app for Linux or Windows on any platform.
* [Proton Native](https://www.electron.build/configuration/configuration/#proton-native) support.
* Downloads all required tools files on demand automatically (e.g. to code sign windows application, to make AppX), no need to setup.

| Question | Answer |
|----------|-------|
| “I want to configure electron-builder” | [See options](https://electron.build/configuration/configuration) |
| “I have a question” | [Join the discussions](https://github.com/electron-userland/electron-builder/discussions) |
| “I found a bug” | [Open an issue](https://github.com/electron-userland/electron-builder/issues/new) |
| “I want to support development” | [Donate](https://www.electron.build/donate) |

## Installation
[Yarn](http://yarnpkg.com/) is [strongly](https://github.com/electron-userland/electron-builder/issues/1147#issuecomment-276284477) recommended instead of npm.

`yarn add electron-builder --dev`

## Quick Setup Guide

[electron-webpack-quick-start](https://github.com/electron-userland/electron-webpack-quick-start) is a recommended way to create a new Electron application. See [Boilerplates](https://www.electron.build/#boilerplates).

1. Specify the standard fields in the application `package.json` — [name](https://electron.build/configuration/configuration#Metadata-name), `description`, `version` and [author](https://docs.npmjs.com/files/package.json#people-fields-author-contributors).

2. Specify the [build](https://electron.build/configuration/configuration#build) configuration in the `package.json` as follows:
    ```json
    "build": {
      "appId": "your.id",
      "mac": {
        "category": "your.app.category.type"
      }
    }
    ```
   See [all options](https://www.electron.build/configuration/configuration). Option [files](https://www.electron.build/configuration/contents#files) to indicate which files should be packed in the final application, including the entry file, maybe required.

3. Add [icons](https://www.electron.build/icons).

4. Add the [scripts](https://docs.npmjs.com/cli/run-script) key to the development `package.json`:
    ```json
    "scripts": {
      "pack": "electron-builder --dir",
      "dist": "electron-builder"
    }
    ```
    Then you can run `yarn dist` (to package in a distributable format (e.g. dmg, windows installer, deb package)) or `yarn run pack` (only generates the package directory without really packaging it. This is useful for testing purposes).

    To ensure your native dependencies are always matched electron version, simply add script `"postinstall": "electron-builder install-app-deps"` to your `package.json`.

5. If you have native addons of your own that are part of the application (not as a dependency), set [nodeGypRebuild](https://www.electron.build/configuration/configuration#Configuration-nodeGypRebuild) to `true`.

Please note that everything is packaged into an asar archive [by default](https://electron.build/configuration/configuration#Configuration-asar).

For an app that will be shipped to production, you should sign your application. See [Where to buy code signing certificates](https://www.electron.build/code-signing#where-to-buy-code-signing-certificate).

## Donate

We do this open source work in our free time. If you'd like us to invest more time on it, please [donate](https://www.electron.build/donate). Donation can be used to increase some issue priority.

## Sponsors

<a href="https://workflowy.com"><img src="https://workflowy.com/media/i/icon-28x28.png" alt="WorkFlowy" title="WorkFlowy" width="28" height="28" align="middle"/></a>
<a href="https://tidepool.org"><img src="https://www.electron.build/sponsor-logos/Tidepool_Logo_Light.svg" alt="Tidepool" title="Tidepool" align="middle"/></a>
<a href="https://keygen.sh/?via=electron-builder"><img src="https://keygen.sh/images/badge.png" alt="Keygen" title="Keygen" align="middle"/></a>
