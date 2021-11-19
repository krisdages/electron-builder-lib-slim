import { createTargets, Platform } from "app-builder-lib"
import { GenericServerOptions } from "builder-util-runtime"
import { outputFile } from "fs-extra"
import * as path from "path"
import { app } from "./helpers/packTester"

function genericPublisher(url: string): GenericServerOptions {
  return {
    provider: "generic",
    url,
  }
}

test.ifNotWindows.ifDevOrLinuxCi(
  "generic",
  app({
    targets: Platform.MAC.createTarget("zip"),
    config: {
      generateUpdatesFilesForAllChannels: true,
      mac: {
        electronUpdaterCompatibility: ">=2.16",
      },
      publish: [genericPublisher("https://example.com/downloads")],
    },
  })
)

test.ifNotWindows.ifDevOrLinuxCi.skip(
  "github and spaces (publishAutoUpdate)",
  app({
    targets: Platform.LINUX.createTarget("AppImage"),
    config: {
      mac: {
        electronUpdaterCompatibility: ">=2.16",
      },
      publish: [genericPublisher("https://example.com/downloads")],
    },
  })
)

test.ifMac(
  "mac artifactName ",
  app(
    {
      targets: Platform.MAC.createTarget("zip"),
      config: {
        // tslint:disable-next-line:no-invalid-template-strings
        artifactName: "${productName}_${version}_${os}.${ext}",
        mac: {
          electronUpdaterCompatibility: ">=2.16",
        },
        publish: [genericPublisher("https://example.com/downloads")],
      },
    },
    {
      // publish: undefined,
    }
  )
)

// https://github.com/electron-userland/electron-builder/issues/3261
test.ifAll.ifNotWindows(
  "custom provider",
  app(
    {
      targets: createTargets([Platform.LINUX], "zip"),
      config: {
        publish: {
          provider: "custom",
          boo: "foo",
        },
      },
    },
    {
      // publish: "never",
      projectDirCreated: projectDir =>
        outputFile(
          path.join(projectDir, "build/electron-publisher-custom.js"),
          `class Publisher {
    async upload(task) {
    }
  }
  
  module.exports = Publisher`
        ),
    }
  )
)
