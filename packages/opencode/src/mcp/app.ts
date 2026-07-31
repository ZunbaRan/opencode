import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"

export const MAX_RESOURCE_BYTES = 4 * 1024 * 1024

export const Meta = Schema.Struct({
  resourceUri: Schema.String,
  visibility: Schema.Array(Schema.Union([Schema.Literal("model"), Schema.Literal("app")])),
  preferred: Schema.optional(
    Schema.Struct({
      maxHeight: Schema.optional(Schema.Finite),
      border: Schema.optional(Schema.Boolean),
      domain: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "McpAppMeta" })
export type Meta = Schema.Schema.Type<typeof Meta>

export const Definition = Schema.Struct({
  server: Schema.String,
  tool: Schema.String,
  toolKey: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  meta: Meta,
}).annotate({ identifier: "McpAppDefinition" })
export type Definition = Schema.Schema.Type<typeof Definition>

export const Resource = Schema.Struct({
  server: Schema.String,
  resourceUri: Schema.String,
  mimeType: Schema.String,
  html: Schema.String,
  sha256: Schema.String,
  meta: Schema.optional(
    Schema.Struct({
      csp: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      domain: Schema.optional(Schema.String),
      prefersBorder: Schema.optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "McpAppResource" })
export type Resource = Schema.Schema.Type<typeof Resource>

export function extract(def: MCPToolDef): Meta | undefined {
  const metadata = asRecord(def._meta)
  if (!metadata) return undefined
  const ui = asRecord(metadata.ui)
  const resourceUri = string(ui?.resourceUri) ?? string(metadata["ui/resourceUri"])
  if (!resourceUri?.startsWith("ui://")) return undefined

  const visibility = toolVisibility(def)
  // maxHeight is an OpenChamber compatibility hint. Security metadata such as
  // CSP and permissions belongs to the resources/read content item and is
  // deliberately ignored on tools/list.
  const preferred = asRecord(ui?.preferred)
  const maxHeight = finite(preferred?.maxHeight) ?? finite(ui?.maxHeight)

  return {
    resourceUri,
    visibility,
    ...(maxHeight === undefined ? {} : { preferred: { maxHeight } }),
  }
}

export function resourceMeta(value: unknown): Resource["meta"] {
  const root = asRecord(value)
  const ui = asRecord(root?.ui)
  if (!ui) return undefined
  const csp = asRecord(ui.csp)
  const permissions = asRecord(ui.permissions)
  const domain = string(ui.domain)
  const prefersBorder = typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : undefined
  if (!csp && !permissions && !domain && prefersBorder === undefined) return undefined
  return {
    ...(csp ? { csp } : {}),
    ...(permissions ? { permissions } : {}),
    ...(domain ? { domain } : {}),
    ...(prefersBorder === undefined ? {} : { prefersBorder }),
  }
}

export function resourceBytes(html: string) {
  const bytes = new TextEncoder().encode(html)
  if (bytes.byteLength > MAX_RESOURCE_BYTES) return undefined
  return bytes
}

export function toolVisibility(def: MCPToolDef) {
  const metadata = asRecord(def._meta)
  const ui = asRecord(metadata?.ui)
  if (!ui || !Array.isArray(ui.visibility)) return ["model", "app"] as const
  const visibility = ui.visibility.filter((item): item is "model" | "app" => item === "model" || item === "app")
  return visibility.length ? visibility : (["model", "app"] as const)
}

export function visibleToModel(def: MCPToolDef) {
  return toolVisibility(def).includes("model")
}

export function visibleToApp(def: MCPToolDef) {
  return toolVisibility(def).includes("app")
}

/**
 * The official Excalidraw MCP App exposes app-only helper tools with
 * `_meta.ui.visibility: ["app"]` but without repeating its resource URI.
 * Such helpers are scoped by the AppBridge's already verified server/resource
 * binding. Ordinary MCP tools remain ineligible: an unbound tool must
 * explicitly opt into app-only visibility.
 */
export function callableFromResource(
  def: MCPToolDef,
  resourceUri: string,
  options?: { allowUnboundAppOnly?: boolean },
) {
  const binding = extract(def)
  if (binding) return binding.resourceUri === resourceUri && binding.visibility.includes("app")

  if (!options?.allowUnboundAppOnly) return false
  const metadata = asRecord(def._meta)
  const ui = asRecord(metadata?.ui)
  if (!ui || !Array.isArray(ui.visibility)) return false
  const visibility = ui.visibility.filter((item) => item === "model" || item === "app")
  return visibility.includes("app") && !visibility.includes("model")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function finite(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

export * as McpApp from "./app"
