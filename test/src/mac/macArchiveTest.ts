import { Platform } from "app-builder-lib"
import { outputFile } from "fs-extra"
import * as path from "path"
import { assertThat } from "../helpers/fileAssert"
import { app, createMacTargetTest } from "../helpers/packTester"

test.ifMac.ifAll("invalid target", () => assertThat(createMacTargetTest(["ttt" as any])()).throws())

test.ifNotWindows.ifAll("only zip", createMacTargetTest(["zip"], undefined, false /* no need to test sign */))

test.ifNotWindows.ifAll("tar.gz", createMacTargetTest(["tar.gz"]))

test.ifAll.ifMac(
  "extraDistFiles",
  app(
    {
      targets: Platform.MAC.createTarget("zip"),
      config: {
        mac: {
          extraDistFiles: "extra.txt",
        },
      },
    },
    {
      signed: false,
      projectDirCreated: projectDir => {
        return Promise.all([outputFile(path.join(projectDir, "extra.txt"), "test")])
      },
    }
  )
)

// todo failed on Travis CI
//test("tar.xz", createTargetTest(["tar.xz"], ["Test App ßW-1.1.0-mac.tar.xz"]))
