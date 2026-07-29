declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_DISTRIBUTION: string
  const OPENCODE_UPSTREAM_VERSION: string
  const OPENCODE_UPSTREAM_COMMIT: string
  const OPENCODE_FORK_COMMIT: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationDistribution =
  typeof OPENCODE_DISTRIBUTION === "string" ? OPENCODE_DISTRIBUTION : "anomalyco/opencode"
export const InstallationUpstreamVersion =
  typeof OPENCODE_UPSTREAM_VERSION === "string" ? OPENCODE_UPSTREAM_VERSION : InstallationVersion.split("-oc.")[0]
export const InstallationUpstreamCommit =
  typeof OPENCODE_UPSTREAM_COMMIT === "string" ? OPENCODE_UPSTREAM_COMMIT : "unknown"
export const InstallationForkCommit = typeof OPENCODE_FORK_COMMIT === "string" ? OPENCODE_FORK_COMMIT : "unknown"
export const InstallationManaged = InstallationDistribution === "ZunbaRan/opencode"
// The managed fork has its own CLI/SDK semver, but user Tools still import the
// upstream plugin package. Resolve that public dependency from the upstream
// baseline instead of requesting an unpublished `-oc.*` plugin version.
export const InstallationPluginVersion = InstallationLocal
  ? undefined
  : InstallationManaged
    ? InstallationUpstreamVersion
    : InstallationVersion
