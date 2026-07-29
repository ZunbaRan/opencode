import { MCP } from "@/mcp"
import { Effect, Schema } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { McpServerNotFoundError } from "../errors"
import { AddPayload, AuthCallbackPayload, StatusMap, UnsupportedOAuthError } from "../groups/mcp"
import {
  AppResourceQuery,
  AppToolCallPayload,
  McpAppBindingError,
  McpAppNotFoundError,
} from "../groups/mcp"
import { Session } from "@/session/session"

export const mcpHandlers = HttpApiBuilder.group(InstanceHttpApi, "mcp", (handlers) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const session = yield* Session.Service

    const status = Effect.fn("McpHttpApi.status")(function* () {
      return yield* mcp.status()
    })

    const add = Effect.fn("McpHttpApi.add")(function* (ctx: { payload: typeof AddPayload.Type }) {
      const result = (yield* mcp.add(ctx.payload.name, ctx.payload.config)).status
      return yield* Schema.decodeUnknownEffect(StatusMap)(
        "status" in result ? { [ctx.payload.name]: result } : result,
      ).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    })

    const authStart = Effect.fn("McpHttpApi.authStart")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.startAuth(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authCallback = Effect.fn("McpHttpApi.authCallback")(function* (ctx: {
      params: { name: string }
      payload: typeof AuthCallbackPayload.Type
    }) {
      return yield* mcp
        .finishAuth(ctx.params.name, ctx.payload.code)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
    })

    const authAuthenticate = Effect.fn("McpHttpApi.authAuthenticate")(function* (ctx: { params: { name: string } }) {
      return yield* Effect.gen(function* () {
        if (!(yield* mcp.supportsOAuth(ctx.params.name))) {
          return yield* new UnsupportedOAuthError({ error: `MCP server ${ctx.params.name} does not support OAuth` })
        }
        return yield* mcp.authenticate(ctx.params.name)
      }).pipe(
        Effect.catchTag("MCP.NotFoundError", (error) =>
          Effect.fail(new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` })),
        ),
      )
    })

    const authRemove = Effect.fn("McpHttpApi.authRemove")(function* (ctx: { params: { name: string } }) {
      const status = yield* mcp.status()
      if (!(ctx.params.name in status))
        return yield* new McpServerNotFoundError({
          name: ctx.params.name,
          message: `MCP server not found: ${ctx.params.name}`,
        })
      yield* mcp.removeAuth(ctx.params.name)
      return { success: true as const }
    })

    const connect = Effect.fn("McpHttpApi.connect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .connect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const disconnect = Effect.fn("McpHttpApi.disconnect")(function* (ctx: { params: { name: string } }) {
      yield* mcp
        .disconnect(ctx.params.name)
        .pipe(
          Effect.catchTag("MCP.NotFoundError", (error) =>
            Effect.fail(
              new McpServerNotFoundError({ name: error.name, message: `MCP server not found: ${error.name}` }),
            ),
          ),
        )
      return true
    })

    const appList = Effect.fn("McpHttpApi.appList")(function* () {
      return yield* mcp.apps()
    })

    const appResource = Effect.fn("McpHttpApi.appResource")(function* (ctx: {
      query: typeof AppResourceQuery.Type
    }) {
      if (!(yield* hasBinding(session, ctx.query))) {
        return yield* new McpAppBindingError({ error: "MCP App resource is not bound to this session message" })
      }
      const resource = yield* mcp.appResource(ctx.query.server, ctx.query.resourceUri, ctx.query.force)
      if (!resource) return yield* new McpAppNotFoundError({ error: "MCP App resource was not found" })
      return resource
    })

    const appToolCall = Effect.fn("McpHttpApi.appToolCall")(function* (ctx: {
      payload: typeof AppToolCallPayload.Type
    }) {
      if (!(yield* hasBinding(session, ctx.payload))) {
        return yield* new McpAppBindingError({ error: "MCP App tool call is not bound to this session message" })
      }
      const result = yield* mcp.appToolCall(
        ctx.payload.server,
        ctx.payload.resourceUri,
        ctx.payload.name,
        ctx.payload.arguments ?? {},
      )
      if (!result) return yield* new McpAppNotFoundError({ error: "MCP App tool was not found or is not app-visible" })
      return result
    })

    return handlers
      .handle("status", status)
      .handle("add", add)
      .handle("authStart", authStart)
      .handle("authCallback", authCallback)
      .handle("authAuthenticate", authAuthenticate)
      .handle("authRemove", authRemove)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
      .handle("appList", appList)
      .handle("appResource", appResource)
      .handle("appToolCall", appToolCall)
  }),
)

function hasBinding(
  session: Session.Interface,
  input: Pick<typeof AppToolCallPayload.Type, "sessionID" | "messageID" | "server" | "resourceUri">,
) {
  return session
    .findMessage(input.sessionID, (message) => {
      if (message.info.id !== input.messageID) return false
      return message.parts.some((part) => {
        if (part.type !== "tool" || part.state.status !== "completed") return false
        const metadata = record(part.state.metadata)
        const app = record(metadata?.mcpApp)
        return app?.server === input.server && app?.resourceUri === input.resourceUri
      })
    })
    .pipe(
      Effect.map((message) => message._tag === "Some"),
      Effect.orElseSucceed(() => false),
    )
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}
