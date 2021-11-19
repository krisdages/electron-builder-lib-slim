// test custom windows sign using path to file

import { CustomWindowsSignTaskConfiguration, FileCodeSigningInfo } from "app-builder-lib"

export default async function (configuration: CustomWindowsSignTaskConfiguration) {
  const info = configuration.cscInfo!! as FileCodeSigningInfo
  expect(info.file).toEqual("secretFile")
  expect(info.password).toEqual("pass")
}
