#!/usr/bin/env bun

import path from "node:path"
import { $ } from "bun"

const version = process.env.FORK_VERSION
if (!version) throw new Error("FORK_VERSION is required")

const output = path.resolve(".openchamber-sdk-package")
await $`rm -rf ${output}`
await $`mkdir -p ${output}`
await $`cp -R packages/sdk/js/dist ${output}/dist`

await Bun.write(
  path.join(output, "package.json"),
  JSON.stringify(
    {
      name: "@zunbaran/opencode-sdk",
      version,
      description: "Generated SDK for the OpenChamber-managed OpenCode fork",
      license: "MIT",
      type: "module",
      files: ["dist"],
      dependencies: {
        "cross-spawn": "7.0.6",
      },
      exports: {
        ".": "./dist/index.js",
        "./client": "./dist/client.js",
        "./server": "./dist/server.js",
        "./v2": "./dist/v2/index.js",
        "./v2/client": "./dist/v2/client.js",
        "./v2/server": "./dist/v2/server.js",
        "./v2/types": "./dist/v2/gen/types.gen.js",
      },
      publishConfig: {
        registry: "https://npm.pkg.github.com",
        access: "public",
      },
      repository: {
        type: "git",
        url: "git+https://github.com/ZunbaRan/opencode.git",
      },
    },
    null,
    2,
  ),
)
