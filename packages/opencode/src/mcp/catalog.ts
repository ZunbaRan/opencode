import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolSchema,
  type CallToolResult,
  type Tool as MCPToolDef,
} from "@modelcontextprotocol/sdk/types.js"
import { dynamicTool, jsonSchema, type JSONSchema7, type Tool } from "ai"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = 30_000
const MAX_LIST_PAGES = 1_000

export type CacheScope = "public" | "private"

export interface CacheHints {
  ttlMs?: number
  cacheScope?: CacheScope
}

export interface ToolDefinitions extends CacheHints {
  tools: MCPToolDef[]
}

/**
 * A model-visible MCP refusal that still carries the protocol result for the host.
 *
 * Throwing keeps the provider's tool-failure semantics intact. Retaining the validated
 * result lets session persistence and Code Mode preserve App state instead of collapsing
 * an MCP error into one lossy message string.
 */
export class ToolResultError extends Error {
  constructor(readonly result: CallToolResult) {
    super(toolResultErrorMessage(result))
    this.name = "McpToolResultError"
  }
}

export function toolResultErrorMessage(result: CallToolResult) {
  return (
    result.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .filter((text) => text.trim())
      .join("\n\n") || "MCP tool returned an error"
  )
}

const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})

export async function paginate<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  return (await paginateWithMetadata(list, items)).items
}

export async function paginateWithMetadata<T, R extends { nextCursor?: string }>(
  list: (cursor?: string) => Promise<R>,
  items: (result: R) => T[],
) {
  const result: T[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  let hints: CacheHints | undefined

  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = await list(cursor)
    if (!hints) hints = cacheHints(response)
    result.push(...items(response))
    if (response.nextCursor === undefined) return { items: result, ...hints }
    if (cursors.has(response.nextCursor)) throw new Error(`MCP list returned duplicate cursor: ${response.nextCursor}`)
    cursors.add(response.nextCursor)
    cursor = response.nextCursor
  }

  throw new Error(`MCP list exceeded ${MAX_LIST_PAGES} pages`)
}

export function defs(client: Client, timeout?: number, force = false) {
  return listTools(client, timeout ?? DEFAULT_TIMEOUT, force).pipe(Effect.catch(() => Effect.void))
}

export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {
  const inputSchema: JSONSchema7 = {
    ...(mcpTool.inputSchema as JSONSchema7),
    type: "object",
    properties: (mcpTool.inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(inputSchema),
    execute: async (args: unknown, options) => {
      const result = await client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: options.abortSignal,
          timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (result.isError) throw new ToolResultError(result)
      if (result.content.length > 0 || result.structuredContent === undefined || result.structuredContent === null)
        return result
      return {
        ...result,
        content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
      }
    },
  })
}

export function fetch<T extends { name: string }>(
  clientName: string,
  client: Client,
  list: (client: Client) => Promise<T[]>,
  label: string,
  key?: (item: T) => string,
) {
  return Effect.tryPromise({
    try: () => list(client),
    catch: (error) => error,
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning(`failed to get ${label}`, {
        clientName,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.map((items) => {
      const sanitizedClient = sanitize(clientName)
      // Escape both the separator and escape marker so `server:uri` keys remain unambiguous.
      const resourceClient = clientName.replaceAll("%", "%25").replaceAll(":", "%3A")
      return Object.fromEntries(
        items.map((item) => [
          key ? resourceClient + ":" + key(item) : sanitizedClient + ":" + sanitize(item.name),
          { ...item, client: clientName },
        ]),
      )
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const toolName = (clientName: string, name: string) => sanitize(clientName) + "_" + sanitize(name)

export function prompts(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.prompts) return Promise.resolve([])
  return paginate(
    (cursor) => client.listPrompts(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.prompts,
  )
}

export function resources(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResources(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resources,
  )
}

export function resourceTemplates(client: Client, timeout?: number) {
  if (!client.getServerCapabilities()?.resources) return Promise.resolve([])
  return paginate(
    (cursor) => client.listResourceTemplates(cursor === undefined ? undefined : { cursor }, { timeout }),
    (result) => result.resourceTemplates,
  )
}

function listTools(client: Client, timeout: number, force: boolean) {
  return Effect.tryPromise({
    try: () =>
      paginateWithMetadata(
        async (cursor) => {
          const params = cursor === undefined ? undefined : { cursor }
          const options = { timeout, ...(force ? { cacheMode: "refresh" as const } : {}) }
          try {
            const list = client.listTools as unknown as (
              params?: { cursor?: string },
              options?: { timeout?: number; cacheMode?: "use" | "refresh" | "bypass" },
            ) => Promise<Awaited<ReturnType<Client["listTools"]>>>
            return await list.call(client, params, options)
          } catch (error) {
            if (!(error instanceof Error) || !isOutputSchemaValidationError(error)) throw error
            return client.request({ method: "tools/list", params }, TolerantListToolsResultSchema, options)
          }
        },
        (result) => result.tools,
      ),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(
    Effect.map(
      (result): ToolDefinitions => ({
        tools: result.items,
        ...(result.ttlMs === undefined ? {} : { ttlMs: result.ttlMs }),
        ...(result.cacheScope === undefined ? {} : { cacheScope: result.cacheScope }),
      }),
    ),
  )
}

export function cacheHints(value: unknown): CacheHints {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  const result = value as Record<string, unknown>
  return {
    ...(typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs) ? { ttlMs: result.ttlMs } : {}),
    ...(result.cacheScope === "public" || result.cacheScope === "private"
      ? { cacheScope: result.cacheScope }
      : {}),
  }
}

function isOutputSchemaValidationError(error: Error) {
  return /can't resolve reference|resolves to more than one schema|outputSchema|schema.*reference|reference.*schema/i.test(
    error.message,
  )
}

export * as McpCatalog from "./catalog"
