import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"

export const Meta = Schema.Struct({
  resourceUri: Schema.String,
  visibility: Schema.optional(Schema.Array(Schema.Union([Schema.Literal("model"), Schema.Literal("app")]))),
  maxHeight: Schema.optional(Schema.Finite),
  prefersBorder: Schema.optional(Schema.Boolean),
  domain: Schema.optional(Schema.String),
  csp: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  permissions: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
  if (!metadata) return
  const ui = asRecord(metadata.ui)
  const resourceUri = string(ui?.resourceUri) ?? string(metadata["ui/resourceUri"])
  if (!resourceUri?.startsWith("ui://")) return

  const visibility = toolVisibility(def)
  // maxHeight is an OpenChamber compatibility hint. Security metadata such as
  // CSP and permissions belongs to the resources/read content item and is
  // deliberately ignored on tools/list.
  const maxHeight = finite(ui?.maxHeight)

  return {
    resourceUri,
    ...(visibility?.length ? { visibility } : {}),
    ...(maxHeight === undefined ? {} : { maxHeight }),
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

export function toolVisibility(def: MCPToolDef) {
  const metadata = asRecord(def._meta)
  const ui = asRecord(metadata?.ui)
  if (!ui || !Array.isArray(ui.visibility)) return
  const visibility = ui.visibility.filter(
    (item): item is "model" | "app" => item === "model" || item === "app",
  )
  return visibility.length ? visibility : undefined
}

export function visibleToModel(def: MCPToolDef) {
  const visibility = toolVisibility(def)
  if (!visibility) return true
  return visibility.includes("model")
}

export function visibleToApp(def: MCPToolDef) {
  const visibility = toolVisibility(def)
  if (!visibility) return true
  return visibility.includes("app")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function string(value: unknown) {
  if (typeof value !== "string") return
  const trimmed = value.trim()
  return trimmed || undefined
}

function finite(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

export * as McpApp from "./app"
