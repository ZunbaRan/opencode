#!/usr/bin/env bun

import path from "node:path"

const dir = path.resolve("packages/opencode/dist")
const version = process.env.RELEASE_VERSION
const upstreamCommit = process.env.UPSTREAM_COMMIT
const forkCommit = process.env.FORK_COMMIT
if (!version || !upstreamCommit || !forkCommit) throw new Error("release provenance environment is incomplete")

const files = (await Array.fromAsync(new Bun.Glob("*.{zip,gz,tgz}").scan({ cwd: dir }))).sort()
const entries = []
for (const file of files) {
  const bytes = await Bun.file(path.join(dir, file)).arrayBuffer()
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  entries.push({ file, sha256, size: bytes.byteLength })
}

await Bun.write(
  path.join(dir, "SHA256SUMS"),
  entries.map((entry) => `${entry.sha256}  ${entry.file}`).join("\n") + "\n",
)
await Bun.write(
  path.join(dir, "openchamber-provenance.json"),
  JSON.stringify(
    {
      schema: "com.openchamber.opencode.provenance.v1",
      distribution: "ZunbaRan/opencode",
      version,
      upstream: { repository: "anomalyco/opencode", branch: "dev", commit: upstreamCommit },
      fork: { repository: "ZunbaRan/opencode", branch: "openchamber-apps", commit: forkCommit },
      files: entries,
      generatedAt: new Date().toISOString(),
    },
    null,
    2,
  ),
)

