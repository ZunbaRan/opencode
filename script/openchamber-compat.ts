#!/usr/bin/env bun

import { strict as assert } from "node:assert"
import path from "node:path"
import { Global } from "../packages/core/src/global"

const dataHome = path.join(process.env.HOME ?? "", ".local", "share")
const configHome = path.join(process.env.HOME ?? "", ".config")

assert.equal(Global.Path.config, path.join(configHome, "opencode"))
assert.ok(Global.Path.data.startsWith(path.join(dataHome, "opencode")))

const dbSource = await Bun.file("packages/core/src/database/database.ts").text()
assert.match(dbSource, /OPENCODE_DISABLE_CHANNEL_DB/)
assert.doesNotMatch(dbSource, /openchamber/i)

const versionSource = await Bun.file("packages/core/src/installation/version.ts").text()
assert.match(versionSource, /ZunbaRan\/opencode/)
assert.match(versionSource, /InstallationPluginVersion/)
assert.match(versionSource, /InstallationUpstreamVersion/)

for (const sourcePath of [
  "packages/opencode/src/config/config.ts",
  "packages/opencode/src/config/tui.ts",
]) {
  const source = await Bun.file(sourcePath).text()
  assert.match(source, /version: InstallationPluginVersion/)
  assert.doesNotMatch(source, /version: InstallationLocal \? undefined : InstallationVersion/)
}

console.log("OpenChamber compatibility invariants verified")
