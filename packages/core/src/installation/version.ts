declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
  const OPENCODE_DISTRIBUTION: string
  const OPENCODE_UPSTREAM_COMMIT: string
  const OPENCODE_FORK_COMMIT: string
}

export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
export const InstallationChannel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
export const InstallationDistribution =
  typeof OPENCODE_DISTRIBUTION === "string" ? OPENCODE_DISTRIBUTION : "anomalyco/opencode"
export const InstallationUpstreamCommit =
  typeof OPENCODE_UPSTREAM_COMMIT === "string" ? OPENCODE_UPSTREAM_COMMIT : "unknown"
export const InstallationForkCommit = typeof OPENCODE_FORK_COMMIT === "string" ? OPENCODE_FORK_COMMIT : "unknown"
export const InstallationManaged = InstallationDistribution === "ZunbaRan/opencode"
