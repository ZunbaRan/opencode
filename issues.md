# Issues

## P2 execution authority

- OpenChamber P2 implementation plan: `/Users/loloru/Documents/data/project/openChamber/openchamber/docs/CONVERSATIONAL_INTERACTIVE_UI_P2_IMPLEMENTATION_PLAN.md`
- OpenChamber P3 follow-on plan: `/Users/loloru/Documents/data/project/openChamber/openchamber/docs/P3_NEXT_WAVE_CAPABILITIES_IMPLEMENTATION_PLAN.md`
- This ledger owns only the OpenCode-side P2 policy alignment. Publishing a Release, SDK, CLI, tag, push, or changing OpenChamber's package pin is outside the current authority.

## issue-001: Align Generative Widget policy with conversational interleaving

- Status: RESOLVED
- Classification: NORMAL
- Goal / user outcome: The always-on `show-widget` prompt and its on-demand design skill permit short prose before, after, and between multiple different-focus widgets while preserving one visual per focus, a soft four-visual limit, same-data deduplication, sandbox constraints, and short-answer restraint.
- First-principles root cause: The current skill demonstrates multi-widget narratives but the always-on prompt does not freeze the P2 routing hierarchy, bridge-text behavior, same-business-data dedupe, or a soft visual limit, leaving the OpenCode instruction seam weaker and potentially contradictory with OpenChamber's authoritative routing policy.
- Core acceptance invariant: Keep the `show-widget` JSON fence wire format byte-contract, string fields, streaming ordering, sandbox/no-network rules, drill-down channel, human-language title, transparent/min-height rules, design examples, and built-in skill registration unchanged; add policy text and semantic tests only; never add a hard runtime counter or require a widget for short factual answers.
- Dependencies: OpenChamber issue-088 defines the frozen wording contract; no source dependency is required for this isolated repository lane.
- Dispatch order: OpenCode policy lane may run in parallel with OpenChamber Wave 1 because ownership and repositories are disjoint; its result gates OpenChamber model-routing parity acceptance and any later publish/pin request.
- Ownership: `packages/opencode/src/session/prompt/generative-widget.txt`; `packages/opencode/src/skill/generative-widget-guidelines.ts`; `packages/opencode/test/session/system.test.ts`; `packages/opencode/test/skill/skill.test.ts`.
- Focused verification: from `packages/opencode`, run `bun test test/session/system.test.ts test/skill/skill.test.ts`; success requires all existing tests plus positive assertions for prose bridges, multiple different-focus widgets, soft limit four, same-business-data dedupe, and short-answer restraint, together with negative assertions against one-primary/stop-after-first/exactly-one-sentence language.
- Pi binding: run/session `15f01e61-f0f6-4d4b-a49f-9475836701a0`; worktree `/Users/loloru/.codex/sol-pi-advisor/worktrees/15f01e61-f0f6-4d4b-a49f-9475836701a0`; base `2722bfb3b2291ccf3a71445210230dc7052717f2`; revision 0; pid 32458; supervised-local, sandbox not enforced.
- Pi attempts: initial candidate completed without correction; exactly the four owned paths changed and policy guard reported no violations.
- Primary attempts: not eligible while Pi retries remain.
- Current evidence: Primary inspected and integrated the complete four-file diff. In the OpenCode integration worktree, `bun test test/session/system.test.ts test/skill/skill.test.ts` passes 41/41 with 139 assertions, package typecheck passes, and `git diff --check` passes. The exact show-widget fence, exactly-once injection, streaming/sandbox/drill-down/CDN/design contracts, built-in Skill registration, four-track hierarchy, bridge prose, 1-N different-focus visuals, soft four limit, same-data dedupe, generated-data labeling, and short-answer restraint are all asserted; prohibited global one-primary/stop-after-first/mandatory-widget absolutes are absent.
- Suspension decision: n/a
- Resume condition: n/a
- Continuation decision: Change source prompt/skill text and their semantic tests only; do not publish, tag, push, regenerate packages, or alter release/provenance scripts.
- Next action: Closed for local source acceptance. Publishing/tagging/pushing and updating OpenChamber's managed SDK/CLI pin remain outside current authority and are tracked by OpenChamber issue-102.
