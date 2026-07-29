import { pathToFileURL } from "node:url"
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js"
import type { ClientOptions as LegacyClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernHTTPTransport,
} from "@modelcontextprotocol/client"
import { StdioClientTransport as ModernStdioTransport } from "@modelcontextprotocol/client/stdio"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"

const CLIENT_CAPABILITIES = {
  capabilities: {
    roots: {},
  },
} satisfies LegacyClientOptions

export type McpConnectionEra = "legacy" | "2026-07-28"

export interface McpConnection {
  /**
   * The rest of OpenCode consumes the stable 1.x client surface. The 2.x
   * client is intentionally adapted here so the protocol migration does not
   * leak through every tool, prompt, and resource consumer.
   */
  client: LegacyClient
  era: McpConnectionEra
  protocolVersion?: string
  adapter: "legacy-sdk" | "2026-sdk"
}

function roots(directory: string) {
  return Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] })
}

export function createLegacyClient(directory: string) {
  const client = new LegacyClient({ name: "opencode", version: InstallationVersion }, CLIENT_CAPABILITIES)
  client.setRequestHandler(ListRootsRequestSchema, () => roots(directory))
  return client
}

function createModernClient(directory: string) {
  const client = new ModernClient(
    { name: "opencode", version: InstallationVersion },
    {
      capabilities: { roots: {} },
      versionNegotiation: {
        mode: "auto",
        probe: { timeoutMs: 4_000, maxRetries: 0 },
      },
    },
  )
  client.setRequestHandler("roots/list", () => roots(directory))
  return client
}

function notificationMethod(schema: unknown) {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "shape" in schema &&
    typeof schema.shape === "object" &&
    schema.shape !== null &&
    "method" in schema.shape
  ) {
    const method = schema.shape.method
    if (typeof method === "object" && method !== null && "value" in method && typeof method.value === "string") {
      return method.value
    }
  }
  throw new TypeError("Unsupported legacy MCP notification schema")
}

/**
 * The modern SDK deliberately keeps the familiar high-level client methods,
 * but handler registration and callTool use the 2026 string/option signatures
 * rather than the 1.x Zod-schema signatures. Keep that impedance mismatch in
 * this one proxy instead of leaking protocol-era branches through OpenCode.
 */
function adapt(client: ModernClient, closeTransport: () => Promise<void>): LegacyClient {
  return new Proxy(client, {
    get(target, property) {
      if (property === "close") {
        return async () => {
          await target.close().catch(() => {})
          await closeTransport().catch(() => {})
        }
      }
      if (
        property === "listTools" ||
        property === "listPrompts" ||
        property === "listResources" ||
        property === "listResourceTemplates"
      ) {
        const methods = {
          listTools: "tools/list",
          listPrompts: "prompts/list",
          listResources: "resources/list",
          listResourceTemplates: "resources/templates/list",
        } as const
        return (params?: Record<string, unknown>, options?: Record<string, unknown>) => {
          if (target.getProtocolEra() !== "legacy") {
            const list = Reflect.get(target, property, target) as (
              input?: Record<string, unknown>,
              requestOptions?: Record<string, unknown>,
            ) => Promise<unknown>
            return list.call(target, params, options)
          }
          // The 2.x convenience methods aggregate a missing-cursor request.
          // OpenCode's legacy catalog owns pagination (including duplicate
          // cursor rejection), so issue one typed protocol page at a time.
          const request = target.request.bind(target) as unknown as (
            input: { method: string; params: Record<string, unknown> },
            requestOptions?: Record<string, unknown>,
          ) => Promise<unknown>
          return request({ method: methods[property], params: params ?? {} }, options)
        }
      }
      if (property === "setNotificationHandler") {
        return (schema: unknown, handler: (notification: unknown) => void | Promise<void>) => {
          const register = target.setNotificationHandler.bind(target) as unknown as (
            method: string,
            callback: (notification: unknown) => void | Promise<void>,
          ) => void
          register(notificationMethod(schema), handler)
        }
      }
      if (property === "removeNotificationHandler") {
        return (schema: unknown) =>
          target.removeNotificationHandler(
            (typeof schema === "string" ? schema : notificationMethod(schema)) as Parameters<
              ModernClient["removeNotificationHandler"]
            >[0],
          )
      }
      if (property === "callTool") {
        return (
          params: Parameters<ModernClient["callTool"]>[0],
          _legacyResultSchema?: unknown,
          options?: Parameters<ModernClient["callTool"]>[1],
        ) => target.callTool(params, options)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target)
    },
  }) as unknown as LegacyClient
}

function result(client: ModernClient, closeTransport: () => Promise<void>): McpConnection {
  const protocolVersion = client.getNegotiatedProtocolVersion()
  return {
    client: adapt(client, closeTransport),
    era: client.getProtocolEra() === "modern" ? "2026-07-28" : "legacy",
    protocolVersion,
    adapter: "2026-sdk",
  }
}

export async function connectModernRemote(input: {
  directory: string
  url: URL
  headers?: Record<string, string>
  timeout: number
}) {
  const client = createModernClient(input.directory)
  const transport = new ModernHTTPTransport(input.url, {
    requestInit: input.headers ? { headers: input.headers } : undefined,
  })
  try {
    await withTimeout(client.connect(transport), input.timeout)
    return result(client, () => transport.close())
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

export async function connectModernLocal(input: {
  directory: string
  command: string
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  timeout: number
}) {
  const client = createModernClient(input.directory)
  const transport = new ModernStdioTransport({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => !!entry[1])),
    stderr: "pipe",
  })
  try {
    await withTimeout(client.connect(transport), input.timeout)
    return result(client, () => transport.close())
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}
