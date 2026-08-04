import { describe, expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { McpPaths } from "../../src/server/routes/instance/httpapi/groups/mcp"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { provideInstanceEffect, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { Session } from "../../src/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const context = Context.empty() as Context.Context<unknown>
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()).pipe(Effect.ignore))
  }),
)
const it = testEffectShared(Layer.mergeAll(testStateLayer, LayerNode.compile(Session.node)))

function app() {
  return Server.Default().app
}
type TestApp = ReturnType<typeof app>
type TestHandler = ReturnType<typeof HttpApiApp.webHandler>

const request = Effect.fnUntraced(function* (
  handler: TestHandler,
  route: string,
  directory: string,
  init?: RequestInit,
) {
  const headers = new Headers(init?.headers)
  headers.set("x-opencode-directory", directory)
  return yield* Effect.promise(() =>
    Promise.resolve(
      handler.handler(
        new Request(`http://localhost${route}`, {
          ...init,
          headers,
        }),
        context,
      ),
    ),
  )
})

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>)
const modernFixture = new URL("../mcp/fixtures/mcp-2026-server.ts", import.meta.url).pathname

const readResponse = Effect.fnUntraced(function* (input: { app: TestApp; path: string; headers: HeadersInit }) {
  const response = yield* Effect.promise(() =>
    Promise.resolve(input.app.request(input.path, { method: "POST", headers: input.headers })),
  )
  return {
    status: response.status,
    body: yield* Effect.promise(() => response.text()),
  }
})

describe("mcp HttpApi", () => {
  it.instance(
    "serves status endpoint",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const response = yield* request(handler, McpPaths.status, tmp.directory)

        expect(response.status).toBe(200)
        expect(yield* json(response)).toEqual({ demo: { status: "disabled" } })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves add, connect, and disconnect endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const added = yield* request(handler, McpPaths.status, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "added",
            config: {
              type: "local",
              command: ["echo", "added"],
              enabled: false,
            },
          }),
        })
        expect(added.status).toBe(200)
        expect(yield* json(added)).toMatchObject({ added: { status: "disabled" } })

        const addedDisconnected = yield* request(handler, "/mcp/added/disconnect", tmp.directory, { method: "POST" })
        expect(addedDisconnected.status).toBe(200)
        expect(yield* json(addedDisconnected)).toBe(true)

        const connected = yield* request(handler, "/mcp/demo/connect", tmp.directory, { method: "POST" })
        expect(connected.status).toBe(200)
        expect(yield* json(connected)).toBe(true)

        const disconnected = yield* request(handler, "/mcp/demo/disconnect", tmp.directory, { method: "POST" })
        expect(disconnected.status).toBe(200)
        expect(yield* json(disconnected)).toBe(true)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "serves deterministic OAuth endpoints",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const start = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "POST" })
        expect(start.status).toBe(400)

        const authenticate = yield* request(handler, "/mcp/demo/auth/authenticate", tmp.directory, { method: "POST" })
        expect(authenticate.status).toBe(400)

        const removed = yield* request(handler, "/mcp/demo/auth", tmp.directory, { method: "DELETE" })
        expect(removed.status).toBe(200)
        expect(yield* json(removed)).toEqual({ success: true })
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns unsupported OAuth error responses",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const dir = tmp.directory
        const headers = { "x-opencode-directory": dir }

        yield* Effect.forEach(["/mcp/demo/auth", "/mcp/demo/auth/authenticate"], (path) =>
          Effect.gen(function* () {
            const response = yield* readResponse({ app: app(), path, headers })

            expect(response).toEqual({
              status: 400,
              body: JSON.stringify({ error: "MCP server demo does not support OAuth" }),
            })
          }),
        )
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance(
    "returns typed not found errors for missing MCP servers",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()

        for (const input of [
          { method: "POST", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/auth/authenticate" },
          { method: "POST", route: "/mcp/missing/auth/callback", body: JSON.stringify({ code: "code" }) },
          { method: "DELETE", route: "/mcp/missing/auth" },
          { method: "POST", route: "/mcp/missing/connect" },
          { method: "POST", route: "/mcp/missing/disconnect" },
        ]) {
          const response = yield* request(handler, input.route, tmp.directory, {
            method: input.method,
            headers: input.body ? { "content-type": "application/json" } : undefined,
            body: input.body,
          })

          expect(response.status).toBe(404)
          expect(yield* json(response)).toEqual({
            _tag: "McpServerNotFoundError",
            name: "missing",
            message: "MCP server not found: missing",
          })
        }
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "lists MCP Apps and rejects resource or tool calls without a session-message binding",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const listed = yield* request(handler, McpPaths.app, tmp.directory)
        expect(listed.status).toBe(200)
        expect(yield* json(listed)).toEqual({})

        const binding = {
          sessionID: "ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
          messageID: "msg_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
          partID: "prt_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
          server: "demo",
          resourceUri: "ui://demo/dashboard",
          toolKey: "demo_open_dashboard",
        }
        const query = new URLSearchParams(binding).toString()
        const resource = yield* request(handler, `${McpPaths.appResource}?${query}`, tmp.directory)
        expect(resource.status).toBe(403)
        expect(yield* json(resource)).toEqual({
          error: "MCP App resource is not bound to this session message",
        })

        const legacyToolCall = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionID: binding.sessionID,
            messageID: binding.messageID,
            server: binding.server,
            resourceUri: binding.resourceUri,
            name: "refresh",
            arguments: {},
          }),
        })
        expect(legacyToolCall.status).toBe(400)

        const toolCall = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...binding,
            partID: "prt_01J5Y5H0AH4Q4NXJ6P4C3P5V2K",
            toolKey: "demo_open_dashboard",
            name: "refresh",
            arguments: {},
          }),
        })
        expect(toolCall.status).toBe(403)
        expect(yield* json(toolCall)).toEqual({
          error: "MCP App tool call is not bound to this session message",
        })
      }),
    { config: { mcp: {} } },
  )

  it.instance(
    "requires the exact completed ToolPart, origin tool key, and app-visible target binding",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const handler = HttpApiApp.webHandler()
        const seeded = yield* provideInstanceEffect(tmp.directory)(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const info = yield* sessions.create({})
            const messageID = MessageID.ascending()
            yield* sessions.updateMessage({
              id: messageID,
              sessionID: info.id,
              role: "user",
              time: { created: Date.now() },
              agent: "test",
              model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
            })
            const partID = PartID.ascending()
            const runningPartID = PartID.ascending()
            const sameResourcePartID = PartID.ascending()
            const metadata = {
              mcpApp: {
                server: "demo",
                tool: "open_dashboard",
                toolKey: "demo_open_dashboard",
                resourceUri: "ui://openchamber/test-dashboard",
                meta: {
                  resourceUri: "ui://openchamber/test-dashboard",
                  visibility: ["model", "app"],
                },
              },
            }
            yield* sessions.updatePart({
              id: partID,
              sessionID: info.id,
              messageID,
              type: "tool",
              tool: "demo_open_dashboard",
              callID: "call-mcp-app",
              state: {
                status: "completed",
                input: {},
                output: "opened",
                title: "Open dashboard",
                metadata,
                time: { start: Date.now(), end: Date.now() },
              },
            })
            yield* sessions.updatePart({
              id: runningPartID,
              sessionID: info.id,
              messageID,
              type: "tool",
              tool: "demo_open_dashboard",
              callID: "call-running-mcp-app",
              state: {
                status: "running",
                input: {},
                title: "Open dashboard",
                metadata,
                time: { start: Date.now() },
              },
            })
            yield* sessions.updatePart({
              id: sameResourcePartID,
              sessionID: info.id,
              messageID,
              type: "tool",
              tool: "demo_other_dashboard",
              callID: "call-same-resource-other-tool",
              state: {
                status: "completed",
                input: {},
                output: "opened elsewhere",
                title: "Open other dashboard",
                metadata: {
                  mcpApp: {
                    ...metadata.mcpApp,
                    tool: "other_dashboard",
                    toolKey: "demo_other_dashboard",
                  },
                },
                time: { start: Date.now(), end: Date.now() },
              },
            })
            return {
              binding: {
                sessionID: info.id,
                messageID,
                partID,
                server: "demo",
                resourceUri: "ui://openchamber/test-dashboard",
                toolKey: "demo_open_dashboard",
              },
              runningPartID,
              sameResourcePartID,
            }
          }),
        )
        const binding = seeded.binding

        const acceptedResource = yield* request(
          handler,
          `${McpPaths.appResource}?${new URLSearchParams(binding).toString()}`,
          tmp.directory,
        )
        expect(acceptedResource.status).toBe(200)

        for (const changed of [
          { sessionID: SessionID.make("ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K") },
          { messageID: MessageID.ascending() },
          { partID: PartID.ascending() },
          { partID: seeded.runningPartID },
          { partID: seeded.sameResourcePartID },
          { server: "other-server" },
          { resourceUri: "ui://openchamber/other-dashboard" },
          { toolKey: "demo_refresh_dashboard" },
        ]) {
          const response = yield* request(
            handler,
            `${McpPaths.appResource}?${new URLSearchParams({ ...binding, ...changed }).toString()}`,
            tmp.directory,
          )
          expect(response.status).toBe(403)
        }

        const accepted = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...binding, name: "refresh_dashboard", arguments: {} }),
        })
        expect(accepted.status).toBe(200)
        const acceptedResult = yield* json<Record<string, unknown>>(accepted)
        expect(acceptedResult).toMatchObject({
          content: [{ type: "text", text: "refreshed" }],
        })
        expect(acceptedResult.data).toBeUndefined()

        const ambiguousUnboundHelper = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...binding, name: "ambiguous_app_helper", arguments: {} }),
        })
        expect(ambiguousUnboundHelper.status).toBe(403)

        for (const changed of [
          { sessionID: SessionID.make("ses_01J5Y5H0AH4Q4NXJ6P4C3P5V2K") },
          { messageID: MessageID.ascending() },
          { partID: PartID.ascending() },
          { partID: seeded.runningPartID },
          { partID: seeded.sameResourcePartID },
          { server: "other-server" },
          { resourceUri: "ui://openchamber/other-dashboard" },
          { toolKey: "demo_refresh_dashboard" },
        ]) {
          const response = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...binding,
              ...changed,
              name: "refresh_dashboard",
              arguments: {},
            }),
          })
          expect(response.status).toBe(403)
        }

        const wrongTool = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...binding, name: "missing_tool", arguments: {} }),
        })
        expect(wrongTool.status).toBe(403)

        const modelOnlyTool = yield* request(handler, McpPaths.appToolCall, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...binding, name: "model_only_status", arguments: {} }),
        })
        expect(modelOnlyTool.status).toBe(403)
      }),
    {
      config: {
        mcp: {
          demo: {
            type: "local",
            command: [process.execPath, modernFixture],
          },
        },
      },
    },
  )
})
