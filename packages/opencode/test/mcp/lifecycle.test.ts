import path from "node:path"
import { pathToFileURL } from "node:url"
import { expect } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { CLIENT_CAPABILITIES_META_KEY, createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { z } from "zod"
import type { MCP as MCPNS } from "../../src/mcp/index"
import { MCP } from "../../src/mcp/index"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const stdioFixture = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")

type Page<T> = { items: T[]; nextCursor?: string }

interface LifecycleServerState {
  tools: Tool[]
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  resourceTemplates: Array<{ name: string; uriTemplate: string; description?: string }>
  toolPages?: Record<string, Page<Tool>>
  promptPages?: Record<string, Page<{ name: string; description?: string }>>
  resourcePages?: Record<string, Page<{ name: string; uri: string; description?: string }>>
  resourceTemplatePages?: Record<string, Page<{ name: string; uriTemplate: string; description?: string }>>
  listToolsError?: string
  requestDelay?: number
  unavailable?: boolean
  roots?: Array<{ uri: string; name?: string }>
  requests: string[]
  aborted: number
}

const appExtension = "io.modelcontextprotocol/ui"
const appMimeType = "text/html;profile=mcp-app"

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function requestSupportsApps(context: unknown) {
  const mcpReq = asRecord(asRecord(context)?.mcpReq)
  const envelope = asRecord(mcpReq?.envelope)
  const capabilities = asRecord(envelope?.[CLIENT_CAPABILITIES_META_KEY])
  const extensions = asRecord(capabilities?.extensions)
  const app = asRecord(extensions?.[appExtension])
  return Array.isArray(app?.mimeTypes) && app.mimeTypes.includes(appMimeType)
}

async function settleOnRequestAbort(request: Request, handle: () => Promise<Response>) {
  if (request.signal.aborted) return new Response("aborted", { status: 499 })
  let onAbort: (() => void) | undefined
  const aborted = new Promise<Response>((resolve) => {
    onAbort = () => resolve(new Response("aborted", { status: 499 }))
    request.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([handle(), aborted])
  } finally {
    if (onAbort) request.signal.removeEventListener("abort", onAbort)
  }
}

function lifecycleServer(input?: { capabilities?: ServerCapabilities; instructions?: string; requestRoots?: boolean }) {
  const capabilities = input?.capabilities ?? { tools: {}, prompts: {}, resources: {} }
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const state: LifecycleServerState = {
        tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        requests: [],
        aborted: 0,
      }

      const makeProtocol = async () => {
        const protocol = new Server(
          { name: "mcp-lifecycle", version: "1.0.0" },
          { capabilities, instructions: input?.instructions },
        )
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
        })

        if (capabilities.tools) {
          protocol.setRequestHandler(ListToolsRequestSchema, (request) => {
            if (state.listToolsError) throw new Error(state.listToolsError)
            const page = state.toolPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ tools: page?.items ?? state.tools, nextCursor: page?.nextCursor })
          })
        }
        if (capabilities.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, (request) => {
            const page = state.promptPages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ prompts: page?.items ?? state.prompts, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(GetPromptRequestSchema, async () => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { messages: [{ role: "user", content: { type: "text", text: "prompt result" } }] }
          })
        }
        if (capabilities.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, (request) => {
            const page = state.resourcePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({ resources: page?.items ?? state.resources, nextCursor: page?.nextCursor })
          })
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) => {
            const page = state.resourceTemplatePages?.[request.params?.cursor ?? "initial"]
            return Promise.resolve({
              resourceTemplates: page?.items ?? state.resourceTemplates,
              nextCursor: page?.nextCursor,
            })
          })
          protocol.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            if (state.requestDelay) await Bun.sleep(state.requestDelay)
            return { contents: [{ uri: request.params.uri, text: "resource result" }] }
          })
        }

        protocol.oninitialized = () => {
          if (!input?.requestRoots) return
          if (!protocol.getClientCapabilities()?.roots) return
          void Bun.sleep(25)
            .then(() => protocol.listRoots())
            .then((result) => {
              state.roots = result.roots
            })
            .catch(() => {})
        }
        await protocol.connect(transport)
        return { protocol, transport }
      }

      let current = await makeProtocol()
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          state.requests.push(request.method)
          request.signal.addEventListener("abort", () => state.aborted++)
          if (state.unavailable) return new Response("unavailable", { status: 503 })
          return settleOnRequestAbort(request, () => current.transport.handleRequest(request))
        },
      })

      return {
        state,
        url: http.url.toString(),
        sendToolListChanged: () => current.protocol.sendToolListChanged(),
        restart: async () => {
          current = await makeProtocol()
        },
        close: async () => {
          await current.protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function hangingLifecycleServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "mcp-lifecycle-hanging", version: "1.0.0" }, { capabilities: { tools: {} } })
      protocol.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [] }))
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const requests: string[] = []
      let aborted = 0
      const http = Bun.serve({
        port: 0,
        fetch(request) {
          requests.push(request.method)
          return new Promise<Response>((resolve) => {
            const onAbort = () => {
              aborted++
              // A client-side abort does not settle an arbitrary promise
              // returned by Bun.serve. Leaving this promise pending leaks one
              // server handler per transport probe and can make stop(true)
              // wait behind earlier tests. Resolve only after the abort so the
              // endpoint still behaves like a genuinely hanging server while
              // releasing the server-side request deterministically.
              resolve(new Response("aborted", { status: 499 }))
            }
            if (request.signal.aborted) onAbort()
            else request.signal.addEventListener("abort", onAbort, { once: true })
          })
        },
      })
      return {
        requests,
        aborted: () => aborted,
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          await http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

function modernAppServer(input?: {
  toolsTtlMs?: number
  resourceTtlMs?: number
  advertiseApps?: boolean
  toolName?: string
  collidingToolName?: string
  resourceMimeType?: string
  resourceContentUri?: string
  resourceBlob?: string
  instructions?: string
}) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const state = {
        receivedAppsCapability: false,
        toolName: input?.toolName ?? "open_dashboard",
        resourceUri: "ui://openchamber/remote-2026",
        resourceHtml: "<!doctype html><html><body>remote 2026 app</body></html>",
        resourceMimeType: input?.resourceMimeType ?? appMimeType,
        resourceContentUri: input?.resourceContentUri,
        resourceBlob: input?.resourceBlob,
        listToolsRequests: 0,
        listToolsError: undefined as string | undefined,
        listToolsDelayMs: 0,
        includePrimaryTool: true,
        primaryVisibility: ["model", "app"] as Array<"model" | "app">,
        readResourceRequests: 0,
        appToolCalls: 0,
      }
      const handler = createMcpHandler(
        () => {
          const server = new McpServer(
            { name: "openchamber-remote-2026", version: "1.0.0" },
            {
              capabilities: {
                tools: {},
                resources: {},
                ...(input?.advertiseApps === false
                  ? {}
                  : {
                      extensions: {
                        [appExtension]: {},
                      },
                    }),
              },
              cacheHints: {
                ...(input?.toolsTtlMs === undefined
                  ? {}
                  : { "tools/list": { ttlMs: input.toolsTtlMs, cacheScope: "private" } }),
                ...(input?.resourceTtlMs === undefined
                  ? {}
                  : { "resources/read": { ttlMs: input.resourceTtlMs, cacheScope: "private" } }),
              },
              instructions: input?.instructions,
            },
          )
          const registerTool = server.registerTool.bind(server) as unknown as (
            name: string,
            config: Record<string, unknown>,
            callback: (input: unknown, context: unknown) => unknown,
          ) => unknown

          if (state.includePrimaryTool) {
            registerTool(
              state.toolName,
              {
                inputSchema: z.object({}),
                _meta: {
                  ui: {
                    resourceUri: state.resourceUri,
                    visibility: state.primaryVisibility,
                  },
                },
              },
              async (_input, context) => {
                const supported = requestSupportsApps(context)
                state.receivedAppsCapability ||= supported
                if (!supported) {
                  return {
                    content: [{ type: "text" as const, text: "MCP App capability required; text fallback only." }],
                  }
                }
                return {
                  content: [{ type: "text" as const, text: "remote dashboard" }],
                  structuredContent: { revision: 1 },
                }
              },
            )
          }

          registerTool(
            "refresh_dashboard",
            {
              inputSchema: z.object({}),
              _meta: {
                ui: {
                  visibility: ["app"],
                },
              },
            },
            async () => {
              state.appToolCalls++
              return { content: [{ type: "text" as const, text: "refreshed" }] }
            },
          )

          if (input?.collidingToolName) {
            registerTool(
              input.collidingToolName,
              { inputSchema: z.object({}) },
              async () => ({ content: [{ type: "text" as const, text: "ordinary collision" }] }),
            )
          }

          server.registerResource(
            "remote-dashboard",
            state.resourceUri,
            {
              mimeType: appMimeType,
              ...(input?.resourceTtlMs === undefined
                ? {}
                : { cacheHint: { ttlMs: input.resourceTtlMs, cacheScope: "private" as const } }),
            },
            async (uri) => {
              state.readResourceRequests++
              const identity = state.resourceContentUri ?? uri.href
              return {
                contents: [
                  state.resourceBlob === undefined
                    ? {
                        uri: identity,
                        mimeType: state.resourceMimeType,
                        text: state.resourceHtml,
                      }
                    : {
                        uri: identity,
                        mimeType: state.resourceMimeType,
                        blob: state.resourceBlob,
                      },
                ],
              }
            },
          )
          return server
        },
        { legacy: "reject" },
      )
      const http = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method === "POST") {
            const body = await request
              .clone()
              .json()
              .catch(() => undefined)
            if (asRecord(body)?.method === "tools/list") {
              state.listToolsRequests++
              if (state.listToolsDelayMs > 0) await Bun.sleep(state.listToolsDelayMs)
              if (state.listToolsError) return new Response(state.listToolsError, { status: 503 })
            }
          }
          return handler.fetch(request)
        },
      })
      return {
        url: http.url.toString(),
        state,
        receivedAppsCapability: () => state.receivedAppsCapability,
        close: () => http.stop(true),
      }
    }),
    (server) => Effect.sync(server.close),
  )
}

function statusName(status: Record<string, MCPNS.Status> | MCPNS.Status, server: string) {
  if ("status" in status) return status.status
  return status[server]?.status
}

const remote = (url: string, timeout?: number) => ({ type: "remote" as const, url, oauth: false as const, timeout })

it.instance("remote oauth:false negotiates strict MCP 2026 Apps and hides app-only tools from the model", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-app", remote(server.url))

    expect((yield* mcp.status())["modern-app"]).toEqual({
      status: "connected",
      protocolVersion: "2026-07-28",
      era: "2026-07-28",
      adapter: "2026-sdk",
      apps: {
        client: true,
        server: true,
        negotiated: true,
      },
    })

    const tools = yield* mcp.tools()
    expect(Object.keys(tools)).toEqual(["modern-app_open_dashboard"])
    expect(tools["modern-app_open_dashboard"].app?.tool).toBe("open_dashboard")
    expect(tools["modern-app_open_dashboard"].app?.server).toBe("modern-app")
    expect(tools["modern-app_open_dashboard"].app?.meta.resourceUri).toBe("ui://openchamber/remote-2026")
    const opened = yield* Effect.promise(() =>
      tools["modern-app_open_dashboard"].client.callTool({
        name: "open_dashboard",
        arguments: {},
      }),
    )
    expect(opened.structuredContent).toEqual({ revision: 1 })
    expect(server.receivedAppsCapability()).toBe(true)

    const appOnly = yield* mcp.appToolCall("modern-app", "ui://openchamber/remote-2026", "refresh_dashboard", {})
    expect(appOnly?.content).toEqual([{ type: "text", text: "refreshed" }])
    expect(
      yield* mcp.appToolCall("modern-app", "ui://openchamber/wrong-resource", "refresh_dashboard", {}),
    ).toBeUndefined()
    expect(
      yield* mcp.appToolCall("wrong-server", "ui://openchamber/remote-2026", "refresh_dashboard", {}),
    ).toBeUndefined()
  }),
)

it.instance("does not register or expose Apps after replacement by a server without negotiation", () =>
  Effect.gen(function* () {
    const negotiated = yield* modernAppServer({ toolsTtlMs: 10_000 })
    const server = yield* modernAppServer({ advertiseApps: false, toolsTtlMs: 10_000 })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-no-apps", remote(negotiated.url))
    expect((yield* mcp.apps())["modern-no-apps_open_dashboard"]).toBeDefined()
    expect(yield* mcp.appResource("modern-no-apps", negotiated.state.resourceUri)).toBeDefined()

    yield* mcp.add("modern-no-apps", remote(server.url))

    expect((yield* mcp.status())["modern-no-apps"]).toMatchObject({
      status: "connected",
      apps: { client: true, server: false, negotiated: false },
    })
    const tools = yield* mcp.tools()
    expect(tools["modern-no-apps_open_dashboard"]?.def.name).toBe("open_dashboard")
    expect(tools["modern-no-apps_open_dashboard"]?.app).toBeUndefined()
    expect(yield* mcp.apps()).toEqual({})
    expect(yield* mcp.appResource("modern-no-apps", server.state.resourceUri)).toBeUndefined()
    expect(
      yield* mcp.appToolCall("modern-no-apps", server.state.resourceUri, "refresh_dashboard", {}),
    ).toBeUndefined()
    expect(server.state.readResourceRequests).toBe(0)
    expect(server.state.appToolCalls).toBe(0)
  }),
)

it.instance("keeps legacy metadata-advertised MCP Apps without 2026 capability negotiation", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {}, resources: {} } })
    server.state.tools = [
      {
        name: "open_legacy_dashboard",
        description: "Open the legacy dashboard App",
        inputSchema: { type: "object", properties: {} },
        _meta: { "ui/resourceUri": "ui://legacy/dashboard" },
      },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("legacy-app", remote(server.url))

    expect((yield* mcp.status())["legacy-app"]).toMatchObject({
      status: "connected",
      era: "legacy",
      apps: { negotiated: false },
    })
    const tools = yield* mcp.tools()
    expect(tools["legacy-app_open_legacy_dashboard"]?.app?.meta.resourceUri).toBe(
      "ui://legacy/dashboard",
    )
    expect((yield* mcp.apps())["legacy-app_open_legacy_dashboard"]?.tool).toBe(
      "open_legacy_dashboard",
    )
  }),
)

it.instance("requires exact App resource URI and MIME identity while accepting strict blob content", () =>
  Effect.gen(function* () {
    const wrongUri = yield* modernAppServer({ resourceContentUri: "ui://openchamber/wrong" })
    const wrongMime = yield* modernAppServer({ resourceMimeType: "text/html" })
    const blobHtml = "<!doctype html><html><body>blob app</body></html>"
    const blob = yield* modernAppServer({ resourceBlob: Buffer.from(blobHtml).toString("base64") })
    const mcp = yield* MCP.Service

    yield* mcp.add("wrong-uri", remote(wrongUri.url))
    yield* mcp.add("wrong-mime", remote(wrongMime.url))
    yield* mcp.add("strict-blob", remote(blob.url))

    expect(yield* mcp.appResource("wrong-uri", wrongUri.state.resourceUri, true)).toBeUndefined()
    expect(yield* mcp.appResource("wrong-mime", wrongMime.state.resourceUri, true)).toBeUndefined()
    const resource = yield* mcp.appResource("strict-blob", blob.state.resourceUri, true)
    expect(resource).toMatchObject({
      resourceUri: blob.state.resourceUri,
      mimeType: appMimeType,
      html: blobHtml,
    })
    expect(resource?.sha256).toBe(new Bun.CryptoHasher("sha256").update(Buffer.from(blobHtml)).digest("hex"))
  }),
)

it.instance("rejects normalized tool-key collisions within one server", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({
      toolsTtlMs: 10_000,
      toolName: "open.dashboard",
      collidingToolName: "open_dashboard",
      instructions: "Open the dashboard before refreshing it.",
    })
    const mcp = yield* MCP.Service
    yield* mcp.add("same-server-collision", remote(server.url))

    expect(yield* mcp.tools()).toEqual({})
    expect(yield* mcp.apps()).toEqual({})
    expect(yield* mcp.instructions()).toEqual([
      {
        name: "same-server-collision",
        instructions: "Open the dashboard before refreshing it.",
        tools: [],
      },
    ])
    expect(yield* mcp.appResource("same-server-collision", server.state.resourceUri)).toBeUndefined()
  }),
)

it.instance("rejects normalized tool-key collisions across servers", () =>
  Effect.gen(function* () {
    const app = yield* modernAppServer({ toolsTtlMs: 10_000 })
    const ordinary = yield* lifecycleServer({ capabilities: { tools: {} } })
    ordinary.state.tools = [
      { name: "open_dashboard", inputSchema: { type: "object", properties: {} } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("server.one", remote(app.url))
    expect(yield* mcp.appResource("server.one", app.state.resourceUri)).toBeDefined()
    yield* mcp.add("server_one", remote(ordinary.url))

    expect(yield* mcp.tools()).toEqual({})
    expect(yield* mcp.apps()).toEqual({})
    expect(yield* mcp.appResource("server.one", app.state.resourceUri)).toBeUndefined()
  }),
)

it.instance("strict MCP 2026 ttl 0 refreshes mutable tool and App definitions without reconnecting", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({ toolsTtlMs: 0 })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-mutable", remote(server.url))

    const before = server.state.listToolsRequests
    server.state.toolName = "open_reports"
    server.state.resourceUri = "ui://openchamber/reports-2026"

    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-mutable_open_reports"])
    expect(server.state.listToolsRequests).toBeGreaterThan(before)
    expect((yield* mcp.apps())["modern-mutable_open_reports"]?.meta.resourceUri).toBe(
      "ui://openchamber/reports-2026",
    )
    expect((yield* mcp.status())["modern-mutable"]?.status).toBe("connected")
  }),
)

it.instance("strict MCP 2026 reuses positive tool TTL and refreshes after expiry", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({ toolsTtlMs: 1_000 })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-positive-ttl", remote(server.url))

    const before = server.state.listToolsRequests
    server.state.toolName = "open_reports"
    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-positive-ttl_open_dashboard"])
    expect(server.state.listToolsRequests).toBe(before)

    yield* Effect.sleep("1100 millis")
    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-positive-ttl_open_reports"])
    expect(server.state.listToolsRequests).toBeGreaterThan(before)
  }),
)

it.instance("strict MCP 2026 quarantines stale model tools and Apps when an expired catalog cannot refresh", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({ toolsTtlMs: 0 })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-fail-closed", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-fail-closed_open_dashboard"])
    expect((yield* mcp.apps())["modern-fail-closed_open_dashboard"]).toBeDefined()

    server.state.primaryVisibility = ["app"]
    expect(yield* mcp.tools()).toEqual({})
    expect((yield* mcp.apps())["modern-fail-closed_open_dashboard"]).toBeDefined()

    server.state.includePrimaryTool = false
    expect(yield* mcp.apps()).toEqual({})

    server.state.includePrimaryTool = true
    server.state.primaryVisibility = ["model", "app"]
    server.state.toolName = "restored_dashboard"
    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-fail-closed_restored_dashboard"])
    expect((yield* mcp.apps())["modern-fail-closed_restored_dashboard"]).toBeDefined()

    server.state.listToolsError = "catalog unavailable"
    expect(yield* mcp.tools()).toEqual({})
    expect(yield* mcp.apps()).toEqual({})
    expect((yield* mcp.status())["modern-fail-closed"]?.status).toBe("connected")
    expect(
      yield* mcp.appResource("modern-fail-closed", server.state.resourceUri),
    ).toBeUndefined()

    server.state.listToolsError = undefined
    server.state.toolName = "recovered_dashboard"
    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-fail-closed_recovered_dashboard"])
    expect((yield* mcp.apps())["modern-fail-closed_recovered_dashboard"]).toBeDefined()
  }),
)

it.instance("strict MCP 2026 coalesces concurrent catalog refreshes and keeps the newest generation", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({
      toolsTtlMs: 0,
      instructions: "Open the dashboard before refreshing it.",
    })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-singleflight", remote(server.url))

    const before = server.state.listToolsRequests
    server.state.toolName = "open_reports"
    server.state.listToolsDelayMs = 100
    const [tools, apps, instructions] = yield* Effect.all(
      [mcp.tools(), mcp.apps(), mcp.instructions()],
      { concurrency: "unbounded" },
    )

    expect(server.state.listToolsRequests).toBe(before + 1)
    expect(Object.keys(tools)).toEqual(["modern-singleflight_open_reports"])
    expect(apps["modern-singleflight_open_reports"]?.tool).toBe("open_reports")
    expect(instructions).toEqual([
      {
        name: "modern-singleflight",
        instructions: "Open the dashboard before refreshing it.",
        tools: ["modern-singleflight_open_reports"],
      },
    ])
  }),
)

it.instance("strict MCP 2026 ignores an older in-flight catalog refresh after server replacement", () =>
  Effect.gen(function* () {
    const oldServer = yield* modernAppServer({ toolsTtlMs: 0, toolName: "old_dashboard" })
    const newServer = yield* modernAppServer({ toolsTtlMs: 10_000, toolName: "new_dashboard" })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-generation", remote(oldServer.url))

    const before = oldServer.state.listToolsRequests
    oldServer.state.listToolsDelayMs = 200
    const [tools] = yield* Effect.all(
      [
        mcp.tools(),
        pollWithTimeout(
          Effect.sync(() => (oldServer.state.listToolsRequests > before ? true : undefined)),
          "old catalog refresh did not start",
        ).pipe(Effect.andThen(mcp.add("modern-generation", remote(newServer.url)))),
      ],
      { concurrency: "unbounded" },
    )

    expect(Object.keys(tools)).toEqual(["modern-generation_new_dashboard"])
    expect(Object.keys(yield* mcp.tools())).toEqual(["modern-generation_new_dashboard"])
    expect((yield* mcp.apps())["modern-generation_new_dashboard"]?.tool).toBe("new_dashboard")
  }),
)

it.instance("strict MCP 2026 honors resource read TTL and force refresh", () =>
  Effect.gen(function* () {
    const server = yield* modernAppServer({ toolsTtlMs: 10_000, resourceTtlMs: 500 })
    const mcp = yield* MCP.Service
    yield* mcp.add("modern-resource-ttl", remote(server.url))

    const uri = server.state.resourceUri
    const first = yield* mcp.appResource("modern-resource-ttl", uri)
    expect(first?.html).toContain("remote 2026 app")
    const reads = server.state.readResourceRequests

    server.state.resourceHtml = "<!doctype html><html><body>updated after ttl</body></html>"
    expect((yield* mcp.appResource("modern-resource-ttl", uri))?.html).toContain("remote 2026 app")
    expect(server.state.readResourceRequests).toBe(reads)

    yield* Effect.sleep("600 millis")
    expect((yield* mcp.appResource("modern-resource-ttl", uri))?.html).toContain("updated after ttl")
    expect(server.state.readResourceRequests).toBeGreaterThan(reads)

    server.state.resourceHtml = "<!doctype html><html><body>forced refresh</body></html>"
    expect((yield* mcp.appResource("modern-resource-ttl", uri, true))?.html).toContain("forced refresh")
  }),
)

it.instance("advertises and lists the instance directory as its root", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ requestRoots: true })
    const mcp = yield* MCP.Service
    const test = yield* TestInstance
    yield* mcp.add("roots", remote(server.url))

    const roots = yield* pollWithTimeout(
      Effect.sync(() => server.state.roots),
      "server did not receive roots",
      "10 seconds",
    )
    expect(roots).toEqual([{ uri: pathToFileURL(test.directory).href }])
  }),
)

it.instance(
  "local mcp cwd resolves relative paths against instance directory",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const test = yield* TestInstance
      yield* mcp.add("rel-cwd", {
        type: "local",
        command: [process.execPath, stdioFixture],
        cwd: "plugins/sub",
      })

      expect((yield* mcp.tools())["rel-cwd_current_directory"]?.def.description).toBe(
        path.resolve(test.directory, "plugins/sub"),
      )
    }),
  { init: (directory) => Effect.promise(() => Bun.$`mkdir -p ${path.join(directory, "plugins/sub")}`.quiet()) },
)

it.instance("tools() reuses cached definitions until a protocol notification", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: { listChanged: true } } })
    const mcp = yield* MCP.Service
    yield* mcp.add("cache-server", remote(server.url))
    server.state.tools = [{ name: "next_tool", inputSchema: { type: "object", properties: {} } }]

    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_test_tool"])
    yield* Effect.promise(server.sendToolListChanged)
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const keys = Object.keys(yield* mcp.tools())
        return keys.includes("cache-server_next_tool") ? keys : undefined
      }),
      "tool cache did not refresh",
    )
    expect(Object.keys(yield* mcp.tools())).toEqual(["cache-server_next_tool"])
  }),
)

it.instance("instructions() returns non-empty connected server instructions with tool names", () =>
  Effect.gen(function* () {
    const guide = yield* lifecycleServer({ instructions: "Use lookup before mutate." })
    const blank = yield* lifecycleServer({ instructions: "   " })
    const mcp = yield* MCP.Service
    yield* mcp.add("guide-server", remote(guide.url))
    yield* mcp.add("blank-server", remote(blank.url))

    expect(yield* mcp.instructions()).toEqual([
      { name: "guide-server", instructions: "Use lookup before mutate.", tools: ["guide-server_test_tool"] },
    ])
    yield* mcp.disconnect("guide-server")
    expect(yield* mcp.instructions()).toEqual([])
  }),
)

it.instance("follows cursors when listing tools, prompts, resources, and templates", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.toolPages = {
      initial: { items: [{ name: "tool-one", inputSchema: { type: "object" } }], nextCursor: "tools-2" },
      "tools-2": { items: [{ name: "tool-two", inputSchema: { type: "object" } }] },
    }
    server.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "prompts-2" },
      "prompts-2": { items: [{ name: "prompt-two" }] },
    }
    server.state.resourcePages = {
      initial: { items: [{ name: "resource-one", uri: "test://one" }], nextCursor: "resources-2" },
      "resources-2": { items: [{ name: "resource-two", uri: "test://two" }] },
    }
    server.state.resourceTemplatePages = {
      initial: { items: [{ name: "template-one", uriTemplate: "test://one/{id}" }], nextCursor: "templates-2" },
      "templates-2": { items: [{ name: "template-two", uriTemplate: "test://two/{id}" }] },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("paged-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["paged-server_tool-one", "paged-server_tool-two"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["paged-server:prompt-one", "paged-server:prompt-two"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["paged-server:test://one", "paged-server:test://two"])
    expect(Object.keys(yield* mcp.resourceTemplates())).toEqual([
      "paged-server:test://one/{id}",
      "paged-server:test://two/{id}",
    ])
  }),
)

it.instance("accepts empty cursors and rejects repeated cursors", () =>
  Effect.gen(function* () {
    const empty = yield* lifecycleServer({ capabilities: { prompts: {} } })
    empty.state.promptPages = {
      initial: { items: [{ name: "prompt-one" }], nextCursor: "" },
      "": { items: [{ name: "prompt-two" }] },
    }
    const looping = yield* lifecycleServer({ capabilities: { tools: {} } })
    looping.state.toolPages = {
      initial: { items: [], nextCursor: "repeat" },
      repeat: { items: [], nextCursor: "repeat" },
    }
    const mcp = yield* MCP.Service
    yield* mcp.add("empty-cursor", remote(empty.url))
    const result = yield* mcp.add("looping-cursor", remote(looping.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["empty-cursor:prompt-one", "empty-cursor:prompt-two"])
    expect(statusName(result.status, "looping-cursor")).toBe("failed")
  }),
)

it.instance("disconnect removes protocol data and reconnect establishes a new session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("reconnect-server", remote(server.url))
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")

    yield* mcp.disconnect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("disabled")
    expect(Object.keys(yield* mcp.tools())).toEqual([])
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted > 0 ? server.state.aborted : undefined)),
      "disconnected HTTP session was not aborted",
    )

    yield* Effect.promise(server.restart)
    yield* mcp.connect("reconnect-server")
    expect((yield* mcp.status())["reconnect-server"]?.status).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["reconnect-server_test_tool"])
  }),
)

it.instance("add() closes the old protocol session when replacing a server", () =>
  Effect.gen(function* () {
    const first = yield* lifecycleServer()
    const second = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("replace-server", remote(first.url))
    yield* mcp.add("replace-server", remote(second.url))

    yield* pollWithTimeout(
      Effect.sync(() => (first.state.aborted > 0 ? first.state.aborted : undefined)),
      "replaced HTTP session was not aborted",
    )
    expect(second.state.aborted).toBe(0)
    expect(Object.keys(yield* mcp.tools())).toEqual(["replace-server_test_tool"])
  }),
)

it.instance("one failed server does not affect another connected server", () =>
  Effect.gen(function* () {
    const good = yield* lifecycleServer()
    good.state.tools = [{ name: "good_tool", inputSchema: { type: "object" } }]
    const bad = yield* lifecycleServer()
    bad.state.listToolsError = "listTools failed"
    const mcp = yield* MCP.Service
    yield* mcp.add("good-server", remote(good.url))
    yield* mcp.add("bad-server", remote(bad.url))

    expect((yield* mcp.status())["good-server"]?.status).toBe("connected")
    expect((yield* mcp.status())["bad-server"]?.status).toBe("failed")
    expect(Object.keys(yield* mcp.tools())).toEqual(["good-server_good_tool"])
  }),
)

it.instance("falls back when output schema refs fail SDK tool discovery", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      {
        name: "render_screen",
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
        outputSchema: { type: "object", properties: { screen: { $ref: "#/$defs/ScreenInstance" } } },
      },
    ]
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("schema-server", remote(server.url))

    expect(statusName(result.status, "schema-server")).toBe("connected")
    expect(Object.keys(yield* mcp.tools())).toEqual(["schema-server_render_screen"])
  }),
)

it.instance("does not fall back for protocol tool discovery errors", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.listToolsError = "transport closed"
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("broken-server", remote(server.url))

    expect(statusName(result.status, "broken-server")).toBe("failed")
  }),
)

it.instance("disabled server is marked disabled without opening a protocol session", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    const mcp = yield* MCP.Service
    yield* mcp.add("disabled-server", { ...remote(server.url), enabled: false })

    expect((yield* mcp.status())["disabled-server"]?.status).toBe("disabled")
    expect(server.state.requests).toEqual([])
  }),
)

it.instance("returns prompts and URI-keyed resources from connected servers", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.prompts = [{ name: "my-prompt", description: "A test prompt" }]
    server.state.resources = [
      { name: "same-name", uri: "file:///test.txt" },
      { name: "same-name", uri: "ui://component-state" },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("content-server", remote(server.url))

    expect(Object.keys(yield* mcp.prompts())).toEqual(["content-server:my-prompt"])
    expect(Object.keys(yield* mcp.resources())).toEqual([
      "content-server:file:///test.txt",
      "content-server:ui://component-state",
    ])
    yield* mcp.disconnect("content-server")
    expect(yield* mcp.prompts()).toEqual({})
  }),
)

it.instance("uses per-server timeouts for prompt and resource requests", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.requestDelay = 200
    const mcp = yield* MCP.Service
    yield* mcp.add("timeout-server", remote(server.url, 50))

    expect(yield* mcp.getPrompt("timeout-server", "test")).toBeUndefined()
    expect(yield* mcp.readResource("timeout-server", "test://resource")).toBeUndefined()
    yield* mcp.disconnect("timeout-server")
    yield* pollWithTimeout(
      Effect.sync(() => (server.state.aborted >= 2 ? server.state.aborted : undefined)),
      "timed-out MCP requests were not aborted",
    )
  }),
  // The assertions prove the 50 ms per-request timeout itself. Leave enough
  // wall-clock budget for Bun/Effect fixture teardown on swap-heavy CI hosts.
  { timeout: 20_000 },
)

it.instance("connects resource-only, prompt-only, and tools-only servers", () =>
  Effect.gen(function* () {
    const resources = yield* lifecycleServer({ capabilities: { resources: {} } })
    resources.state.resources = [{ name: "docs", uri: "docs://readme" }]
    const prompts = yield* lifecycleServer({ capabilities: { prompts: {} } })
    prompts.state.prompts = [{ name: "review" }]
    const tools = yield* lifecycleServer({ capabilities: { tools: {} } })
    const mcp = yield* MCP.Service
    yield* mcp.add("resource-only", remote(resources.url))
    yield* mcp.add("prompt-only", remote(prompts.url))
    yield* mcp.add("tools-only", remote(tools.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["tools-only_test_tool"])
    expect(Object.keys(yield* mcp.prompts())).toEqual(["prompt-only:review"])
    expect(Object.keys(yield* mcp.resources())).toEqual(["resource-only:docs://readme"])
  }),
)

it.instance("connect and disconnect fail for unknown servers", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    for (const operation of [mcp.connect("missing"), mcp.disconnect("missing")]) {
      const exit = yield* operation.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "MCP.NotFoundError", name: "missing" })
      }
    }
    expect(yield* mcp.status()).toEqual({})
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("unavailable remote server is marked failed without tools", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ port: 0, fetch: () => new Response("unavailable", { status: 503 }) })),
      (http) => Effect.promise(() => http.stop(true)),
    )
    const mcp = yield* MCP.Service
    yield* mcp.add("unavailable", remote(server.url.toString(), 500))

    expect((yield* mcp.status()).unavailable?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})
  }),
)

it.instance("reconnects an enabled remote server after a transient startup failure", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.unavailable = true
    const mcp = yield* MCP.Service
    yield* mcp.add("startup-retry", remote(server.url, 1_000))

    expect((yield* mcp.status())["startup-retry"]?.status).toBe("failed")
    expect(yield* mcp.tools()).toEqual({})

    server.state.unavailable = false
    yield* pollWithTimeout(
      Effect.gen(function* () {
        const status = (yield* mcp.status())["startup-retry"]
        return status?.status === "connected" ? true : undefined
      }),
      "remote MCP did not reconnect after the endpoint recovered",
      "8 seconds",
    )

    expect(Object.keys(yield* mcp.tools())).toEqual(["startup-retry_test_tool"])
  }),
)

it.instance("manual disconnect cancels a pending remote reconnect", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer()
    server.state.unavailable = true
    const mcp = yield* MCP.Service
    yield* mcp.add("manual-stop", remote(server.url, 200))
    expect((yield* mcp.status())["manual-stop"]?.status).toBe("failed")

    yield* mcp.disconnect("manual-stop")
    const requestsAfterDisconnect = server.state.requests.length
    server.state.unavailable = false
    yield* Effect.sleep("2 seconds")

    expect((yield* mcp.status())["manual-stop"]?.status).toBe("disabled")
    expect(yield* mcp.tools()).toEqual({})
    expect(server.state.requests).toHaveLength(requestsAfterDisconnect)
  }),
)

it.instance("tools() prefixes sanitized server and tool names", () =>
  Effect.gen(function* () {
    const server = yield* lifecycleServer({ capabilities: { tools: {} } })
    server.state.tools = [
      { name: "tool-a", inputSchema: { type: "object" } },
      { name: "tool.b", inputSchema: { type: "object" } },
    ]
    const mcp = yield* MCP.Service
    yield* mcp.add("my.special-server", remote(server.url))

    expect(Object.keys(yield* mcp.tools())).toEqual(["my_special-server_tool-a", "my_special-server_tool_b"])
  }),
)

it.instance("local stdio timeout terminates the real server process", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "mcp.pid")
    const mcp = yield* MCP.Service
    const result = yield* mcp.add("hanging-stdio", {
      type: "local",
      command: [process.execPath, stdioFixture, "--hang"],
      environment: { MCP_LIFECYCLE_PID_FILE: pidFile },
      timeout: 100,
    })

    expect(statusName(result.status, "hanging-stdio")).toBe("failed")
    const pid = yield* pollWithTimeout(
      Effect.promise(async () => {
        const file = Bun.file(pidFile)
        return (await file.exists()) ? Number(await file.text()) : undefined
      }),
      "stdio fixture did not publish its pid",
    )
    yield* pollWithTimeout(
      Effect.sync(() => {
        try {
          process.kill(pid, 0)
          return undefined
        } catch {
          return true
        }
      }),
      "stdio fixture process was not terminated",
    )
  }),
)

it.instance("remote timeout aborts both real HTTP transport attempts", () =>
  Effect.gen(function* () {
    const server = yield* hangingLifecycleServer()
    const mcp = yield* MCP.Service
    // Keep the deadline short enough to exercise cancellation while allowing
    // Bun's EventSource-backed SSE transport to actually dispatch its GET on
    // a loaded full-file run. A 100 ms deadline can expire in the scheduler
    // before the request reaches the in-process server, which tests startup
    // latency rather than transport cancellation.
    const result = yield* mcp.add("hanging-remote", remote(server.url, 300))

    expect(statusName(result.status, "hanging-remote")).toBe("failed")
    yield* pollWithTimeout(
      Effect.sync(() => (server.aborted() >= 3 ? server.aborted() : undefined)),
      "remote transport requests were not aborted",
    )
    // The 2026 adapter probes server/discover before the legacy
    // Streamable HTTP + SSE fallback pair.
    expect(server.requests).toEqual(["POST", "POST", "GET"])
  }),
  { timeout: 10_000 },
)

it.live("McpOAuthCallback.cancelPending rejects the pending callback", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => McpOAuthCallback.waitForCallback("abc123hexstate", "my-mcp-server")),
    (callback) =>
      Effect.gen(function* () {
        McpOAuthCallback.cancelPending("my-mcp-server")
        const exit = yield* Effect.tryPromise({
          try: () => callback,
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    () => Effect.promise(() => McpOAuthCallback.stop()).pipe(Effect.ignore),
  ),
)
