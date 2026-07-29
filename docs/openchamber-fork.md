# OpenCode distribution for OpenChamber

This repository is the OpenCode distribution embedded by OpenChamber.

- `origin`: `ZunbaRan/opencode`
- `upstream`: `anomalyco/opencode`
- upstream baseline: `upstream/dev`
- product branch: `openchamber-apps`
- release version: `<upstream-version>-oc.<revision>`
- binary identity and user data paths remain `opencode`

Upstream updates are merged with a merge commit. Published history is never
rebased. A release carries the CLI for every supported platform, generated SDK
tarball, SHA256 manifest, upstream/fork revisions, and GitHub provenance.

The distribution deliberately disables upstream release checks and CLI
self-upgrade. It is upgraded only when a new OpenChamber release updates its
CLI lock file. An externally selected CLI remains a diagnostic override and is
never upgraded by OpenChamber.

The fork does not add a database table or migration. MCP App state is stored in
the existing generic tool-part metadata so official OpenCode at the same or a
newer baseline can still read the session and fall back to raw tool output.

