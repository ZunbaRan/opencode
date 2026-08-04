import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "../../src/provider/provider"
import { SessionTools } from "../../src/session/tools"
import { MCP } from "../../src/mcp"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import type { Agent } from "../../src/agent/agent"
import type { Session } from "../../src/session/session"
import type { TaskPromptOps } from "../../src/tool/task"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const model: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("test"),
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1_000, input: 1_000, output: 1_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const app: NonNullable<MCP.McpTool["app"]> = {
  server: "demo",
  tool: "open_dashboard",
  toolKey: "demo_open_dashboard",
  title: "Open dashboard",
  meta: {
    resourceUri: "ui://demo/dashboard",
    visibility: ["model", "app"],
  },
}

test("publishes a validated MCP App binding before invoking the MCP tool", async () => {
  const sessionID = SessionID.make("ses_test")
  const messageID = MessageID.make("msg_test")
  const callID = "call-app"
  let part = {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "tool",
    tool: app.toolKey,
    callID,
    state: { status: "pending", input: {}, raw: "" },
  } as SessionV1.ToolPart
  let metadataAtExecute: unknown
  let completed: Record<string, unknown> | undefined
  const failureResult = {
    isError: true,
    content: [{ type: "text" as const, text: "dashboard write rejected" }],
    structuredContent: { revision: 4, accepted: false },
    _meta: { trace: "trace-safe" },
  }

  const client = {
    callTool: async () => {
      metadataAtExecute = "metadata" in part.state ? part.state.metadata : undefined
      return failureResult
    },
  } as unknown as MCP.McpTool["client"]

  const layers = Layer.mergeAll(
    Layer.succeed(
      Plugin.Service,
      Plugin.Service.of({
        init: () => Effect.void,
        list: () => Effect.succeed([]),
        trigger: ((_name: unknown, _input: unknown, output: unknown) =>
          Effect.succeed(output)) as Plugin.Interface["trigger"],
      }),
    ),
    Layer.succeed(
      Permission.Service,
      Permission.Service.of({
        ask: () => Effect.void,
        reply: () => Effect.void,
        list: () => Effect.succeed([]),
      }),
    ),
    Layer.mock(ToolRegistry.Service, { tools: () => Effect.succeed([]) }),
    Layer.mock(MCP.Service, {
      clients: () => Effect.succeed({}),
      tools: () =>
        Effect.succeed({
          [app.toolKey]: {
            def: {
              name: app.tool,
              title: app.title,
              inputSchema: { type: "object", properties: {} },
            } as MCPToolDef,
            client,
            app,
          },
        }),
    }),
    Layer.succeed(
      Truncate.Service,
      Truncate.Service.of({
        cleanup: () => Effect.void,
        write: () => Effect.succeed("unused"),
        output: (text) => Effect.succeed({ content: text, truncated: false }),
        limits: () => Effect.succeed({ maxLines: 2_000, maxBytes: 50 * 1024 }),
      }),
    ),
    RuntimeFlags.layer(),
  )

  const agent = {
    name: "build",
    mode: "primary",
    permission: Permission.fromConfig({ "*": "allow" }),
    options: {},
  } as Agent.Info
  const session = { id: sessionID, permission: Permission.fromConfig({ "*": "allow" }) } as Session.Info
  const processor = {
    message: { id: messageID, sessionID, role: "assistant" } as SessionV1.Assistant,
    updateToolCall: (_toolCallID: string, update: (value: SessionV1.ToolPart) => SessionV1.ToolPart) =>
      Effect.sync(() => {
        part = update(part)
        return part
      }),
    completeToolCall: (_toolCallID: string, output: Record<string, unknown>) =>
      Effect.sync(() => {
        completed = output
      }),
  }

  const tools = await Effect.runPromise(
    SessionTools.resolve({
      agent,
      model,
      session,
      processor,
      bypassAgentCheck: false,
      messages: [],
      promptOps: {} as TaskPromptOps,
    }).pipe(Effect.provide(layers)),
  )
  const execute = tools[app.toolKey]?.execute
  expect(execute).toBeDefined()
  await expect(
    execute!({}, { toolCallId: callID, messages: [], abortSignal: new AbortController().signal }),
  ).rejects.toThrow("dashboard write rejected")

  expect(metadataAtExecute).toEqual({
    mcpApp: {
      server: app.server,
      tool: app.tool,
      toolKey: app.toolKey,
      resourceUri: app.meta.resourceUri,
      meta: app.meta,
    },
  })
  expect(completed).toMatchObject({
    output: "dashboard write rejected",
    content: failureResult.content,
    metadata: {
      mcpApp: {
        server: app.server,
        tool: app.tool,
        toolKey: app.toolKey,
        resourceUri: app.meta.resourceUri,
        meta: app.meta,
      },
      mcpResult: failureResult,
      structuredContent: failureResult.structuredContent,
      mcpResultMeta: failureResult._meta,
      mcpIsError: true,
      truncated: false,
    },
  })
})
