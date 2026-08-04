import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Schema } from "effect"

// Self-contained MCP Apps must carry every runtime asset inside the verified
// HTML resource. The official tldraw v5.0.2 bundle is about 4.2 MiB, so keep a
// bounded ceiling that admits real offline editors without allowing unbounded
// resource allocation.
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024
const MAX_BASE64_RESOURCE_LENGTH = Math.ceil(MAX_RESOURCE_BYTES / 3) * 4

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
  if (visibility.length === 0) return undefined
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

export function resourceContent(value: unknown): { html: string; bytes: Uint8Array } | undefined {
  const content = asRecord(value)
  if (!content) return undefined
  const hasText = Object.prototype.hasOwnProperty.call(content, "text")
  const hasBlob = Object.prototype.hasOwnProperty.call(content, "blob")
  if (hasText === hasBlob) return undefined

  if (hasText) {
    if (typeof content.text !== "string") return undefined
    const bytes = resourceBytes(content.text)
    if (!bytes) return undefined
    return { html: content.text, bytes }
  }

  if (typeof content.blob !== "string") return undefined
  if (content.blob.length > MAX_BASE64_RESOURCE_LENGTH || !isBase64(content.blob)) return undefined
  const bytes = Buffer.from(content.blob, "base64")
  if (bytes.byteLength > MAX_RESOURCE_BYTES || bytes.toString("base64") !== content.blob) return undefined
  try {
    return {
      html: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      bytes,
    }
  } catch {
    return undefined
  }
}

export function toolVisibility(def: MCPToolDef): Array<"model" | "app"> {
  const metadata = asRecord(def._meta)
  const ui = asRecord(metadata?.ui)
  if (!ui || !("visibility" in ui)) return ["model", "app"]
  if (!Array.isArray(ui.visibility) || ui.visibility.length === 0) return []
  const visibility: Array<"model" | "app"> = []
  for (const item of ui.visibility) {
    if (item !== "model" && item !== "app") return []
    if (!visibility.includes(item)) visibility.push(item)
  }
  return visibility
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
  if (!ui || !("visibility" in ui)) return false
  const visibility = toolVisibility(def)
  return visibility.length === 1 && visibility[0] === "app"
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function isBase64(value: string) {
  if (value.length % 4 !== 0) return false
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  const contentLength = value.length - padding
  for (let index = 0; index < contentLength; index++) {
    const code = value.charCodeAt(index)
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47
    if (!valid) return false
  }
  for (let index = contentLength; index < value.length; index++) {
    if (value.charCodeAt(index) !== 61) return false
  }
  return true
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
