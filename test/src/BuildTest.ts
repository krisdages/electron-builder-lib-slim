import { createTargets, DIR_TARGET, Platform } from "app-builder-lib"
import { doMergeConfigs } from "app-builder-lib/out/util/config"
import { promises as fs } from "fs"
import { outputJson } from "fs-extra"
import * as path from "path"
import { app, appTwo, appTwoThrows, assertPack, linuxDirTarget, modifyPackageJson } from "./helpers/packTester"
import { ELECTRON_VERSION } from "./helpers/testConfig"

test("merge configurations", () => {
  const result = doMergeConfigs([
    {
      files: [
        {
          from: "dist/renderer",
        },
        {
          from: "dist/renderer-dll",
        },
      ],
    },
    {
      files: [
        {
          from: ".",
          filter: ["package.json"],
        },
        {
          from: "dist/main",
        },
      ],
    },
    {
      files: ["**/*", "!webpack", "!.*", "!config/jsdoc.json", "!package.*"],
    },
    {
      files: [
        {
          from: ".",
          filter: ["!docs"],
        },
      ],
    },
    {
      files: ["!private"],
    },
  ])

  // console.log("data: " + JSON.stringify(result, null, 2))
  expect(result).toMatchObject({
    directories: {
      output: "dist",
      buildResources: "build",
    },
    files: [
      {
        filter: ["package.json", "**/*", "!webpack", "!.*", "!config/jsdoc.json", "!package.*", "!docs", "!private"],
      },
      {
        from: "dist/main",
      },
      {
        from: "dist/renderer",
      },
      {
        from: "dist/renderer-dll",
      },
    ],
  })
})

test(
  "build in the app package.json",
  appTwoThrows(
    { targets: linuxDirTarget },
    {
      projectDirCreated: it =>
        modifyPackageJson(
          it,
          data => {
            data.build = {
              productName: "bar",
            }
          },
          true
        ),
    }
  )
)

test(
  "relative index",
  appTwo(
    {
      targets: linuxDirTarget,
    },
    {
      projectDirCreated: projectDir =>
        modifyPackageJson(
          projectDir,
          data => {
            data.main = "./index.js"
          },
          true
        ),
    }
  )
)

it.ifDevOrLinuxCi(
  "electron version from electron-prebuilt dependency",
  app(
    {
      targets: linuxDirTarget,
    },
    {
      projectDirCreated: projectDir =>
        Promise.all([
          outputJson(path.join(projectDir, "node_modules", "electron-prebuilt", "package.json"), {
            version: ELECTRON_VERSION,
          }),
          modifyPackageJson(projectDir, data => {
            delete data.build.electronVersion
            data.devDependencies = {}
          }),
        ]),
    }
  )
)

test.ifDevOrLinuxCi(
  "electron version from electron dependency",
  app(
    {
      targets: linuxDirTarget,
    },
    {
      projectDirCreated: projectDir =>
        Promise.all([
          outputJson(path.join(projectDir, "node_modules", "electron", "package.json"), {
            version: ELECTRON_VERSION,
          }),
          modifyPackageJson(projectDir, data => {
            delete data.build.electronVersion
            data.devDependencies = {}
          }),
        ]),
    }
  )
)

test.ifDevOrLinuxCi(
  "electron version from build",
  app(
    {
      targets: linuxDirTarget,
    },
    {
      projectDirCreated: projectDir =>
        modifyPackageJson(projectDir, data => {
          data.devDependencies = {}
          data.build.electronVersion = ELECTRON_VERSION
        }),
    }
  )
)

test(
  "www as default dir",
  appTwo(
    {
      targets: Platform.LINUX.createTarget(DIR_TARGET),
    },
    {
      projectDirCreated: projectDir => fs.rename(path.join(projectDir, "app"), path.join(projectDir, "www")),
    }
  )
)

test.ifLinuxOrDevMac("afterPack", () => {
  let called = 0
  return assertPack(
    "test-app-one",
    {
      targets: createTargets([Platform.LINUX, Platform.MAC], DIR_TARGET),
      config: {
        afterPack: () => {
          called++
          return Promise.resolve()
        },
      },
    },
    {
      packed: async () => {
        expect(called).toEqual(2)
      },
    }
  )
})

test.ifLinuxOrDevMac("afterSign", () => {
  let called = 0
  return assertPack(
    "test-app-one",
    {
      targets: createTargets([Platform.LINUX, Platform.MAC], DIR_TARGET),
      config: {
        afterSign: () => {
          called++
          return Promise.resolve()
        },
      },
    },
    {
      packed: async () => {
        expect(called).toEqual(2)
      },
    }
  )
})

test.ifLinuxOrDevMac("beforeBuild", () => {
  let called = 0
  return assertPack(
    "test-app-one",
    {
      targets: createTargets([Platform.LINUX, Platform.MAC], DIR_TARGET),
      config: {
        // This functionality was removed in the slim package
        // npmRebuild: true,
        beforeBuild: async () => {
          called++
        },
      },
    },
    {
      packed: async () => {
        expect(called).toEqual(2)
      },
    }
  )
})

export function removeUnstableProperties(data: any) {
  return JSON.parse(
    JSON.stringify(data, (name, value) => {
      if (name === "offset") {
        return undefined
      } else if (name.endsWith(".node") && value.size != null) {
        // size differs on various OS
        value.size = "<size>"
        return value
      }
      return value
    })
  )
}
