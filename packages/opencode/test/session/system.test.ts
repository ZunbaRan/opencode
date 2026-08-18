import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import PROMPT_GENERATIVE_WIDGET from "../../src/session/prompt/generative-widget.txt"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    expect(SystemPrompt.provider({ api: { id: "meta/muse-spark-preview" } } as Provider.Model)[0]).toContain(
      "Meta Muse Spark",
    )
  })

  test("always includes the Generative Widget wire-format prompt", () => {
    const environment = SystemPrompt.environment(
      {
        providerID: "openchamber",
        api: { id: "generative-widget-test" },
      },
      {
        directory: "/workspace/project",
        worktree: "/workspace/project",
        project: { vcs: "git" },
      },
      [],
    )

    expect(environment.filter((part) => part === PROMPT_GENERATIVE_WIDGET)).toHaveLength(1)
  })

  describe("generative widget prompt semantics", () => {
    test("keeps the exact show-widget JSON fence wire format", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("```show-widget")
      expect(PROMPT_GENERATIVE_WIDGET).toMatch(/```show-widget\s*\n\{"widget_code":/)
      expect(PROMPT_GENERATIVE_WIDGET).toContain('"title"')
      expect(PROMPT_GENERATIVE_WIDGET).toContain("widget_code is a JSON string")
    })

    test("preserves sandbox, streaming, and drill-down contracts", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("sandboxed iframe")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("no network APIs")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Streaming order: SVG defs first")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("window.__widgetSendMessage")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Transparent background")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("min-height not fixed height")
    })

    test("states the visual selection hierarchy across the four tracks", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("installed specialized Tool/View")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Declarative interactive_ui")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("show-widget for small free-form")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("html_artifact for complex custom")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("four-track numbering")
    })

    test("allows multiple different-focus visuals with bridge prose in order", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("1-N visuals")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("genuinely different focuses")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("preserve generation order")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("before the first visual, after the last, and between visuals")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("narrative bridges")
    })

    test("sets one primary visual per focus with a soft four-visual limit", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("one primary visual per focus")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("no more than four primary visuals in one answer")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("strong user need")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("guidance, not a hard gate")
    })

    test("forbids same-business-data repetition across tracks", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Never repeat the same business data or same conclusion")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("text for explanation or a different-focus visual")
    })

    test("requires labeling example/simulated/generated data", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Label example/simulated/generated data clearly")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("governed by its Tool authority")
    })

    test("keeps short factual answers as prose without mandatory widgets", () => {
      expect(PROMPT_GENERATIVE_WIDGET).toContain("remain prose")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Do not require a widget")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("show-widget is not a Tool")
      expect(PROMPT_GENERATIVE_WIDGET).toContain("Do not force a visual merely because the capability exists")
    })

    test("rejects one-per-answer and stop-after-first absolutes", () => {
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("The ONLY way")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("non-negotiable")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("exactly one widget")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("exactly one visual")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("one primary View for the entire answer")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("stop after the first visual")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("exactly one sentence")
      expect(PROMPT_GENERATIVE_WIDGET).not.toContain("must always include a widget")
    })
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
