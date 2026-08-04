import { describe, expect, test } from "bun:test"
import { McpApp } from "../../src/mcp/app"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"

const tool = (meta: Record<string, unknown>): Tool => ({
  name: "dashboard",
  inputSchema: { type: "object" },
  _meta: meta,
})

describe("MCP App metadata", () => {
  test("extracts a namespaced UI binding and visibility", () => {
    const definition = tool({
      ui: {
        resourceUri: "ui://acme/dashboard",
        visibility: ["app"],
        preferred: { maxHeight: 720 },
      },
    })

    expect(McpApp.extract(definition)).toEqual({
      resourceUri: "ui://acme/dashboard",
      visibility: ["app"],
      preferred: { maxHeight: 720 },
    })
    expect(McpApp.visibleToModel(definition)).toBe(false)
    expect(McpApp.visibleToApp(definition)).toBe(true)
  })

  test("supports the legacy ui/resourceUri key without trusting invalid URIs", () => {
    expect(McpApp.extract(tool({ "ui/resourceUri": "ui://acme/legacy" }))).toEqual({
      resourceUri: "ui://acme/legacy",
      visibility: ["model", "app"],
    })
    expect(McpApp.extract(tool({ "ui/resourceUri": "https://example.com/app" }))).toBeUndefined()
  })

  test("keeps resource security metadata on the resource rather than the tool", () => {
    const definition = tool({
      ui: {
        resourceUri: "ui://acme/dashboard",
        csp: { connectDomains: ["https://api.example.com"] },
        permissions: { clipboard: true },
      },
    })

    expect(McpApp.extract(definition)).toEqual({
      resourceUri: "ui://acme/dashboard",
      visibility: ["model", "app"],
    })
    expect(
      McpApp.resourceMeta({
        ui: {
          csp: { connectDomains: ["https://api.example.com"] },
          permissions: { clipboard: true },
          domain: "dashboard.example.com",
          prefersBorder: true,
        },
      }),
    ).toEqual({
      csp: { connectDomains: ["https://api.example.com"] },
      permissions: { clipboard: true },
      domain: "dashboard.example.com",
      prefersBorder: true,
    })
  })

  test("normalizes preferred maxHeight and keeps the legacy compatibility hint", () => {
    expect(
      McpApp.extract(
        tool({
          ui: {
            resourceUri: "ui://acme/preferred",
            preferred: { maxHeight: 640 },
            maxHeight: 480,
          },
        }),
      ),
    ).toEqual({
      resourceUri: "ui://acme/preferred",
      visibility: ["model", "app"],
      preferred: { maxHeight: 640 },
    })

    expect(
      McpApp.extract(
        tool({
          ui: {
            resourceUri: "ui://acme/legacy-height",
            maxHeight: 480,
          },
        }),
      ),
    ).toEqual({
      resourceUri: "ui://acme/legacy-height",
      visibility: ["model", "app"],
      preferred: { maxHeight: 480 },
    })
  })

  test("allows explicit unbound app-only tools without exposing ordinary tools", () => {
    const appOnly = tool({
      ui: {
        visibility: ["app"],
      },
    })
    const ordinary = tool({})
    const modelAndApp = tool({
      ui: {
        visibility: ["model", "app"],
      },
    })
    const boundElsewhere = tool({
      ui: {
        resourceUri: "ui://acme/other",
        visibility: ["app"],
      },
    })

    expect(McpApp.extract(appOnly)).toBeUndefined()
    expect(McpApp.callableFromResource(appOnly, "ui://acme/dashboard")).toBe(false)
    expect(
      McpApp.callableFromResource(appOnly, "ui://acme/dashboard", {
        allowUnboundAppOnly: true,
      }),
    ).toBe(true)
    expect(McpApp.callableFromResource(ordinary, "ui://acme/dashboard")).toBe(false)
    expect(
      McpApp.callableFromResource(ordinary, "ui://acme/dashboard", {
        allowUnboundAppOnly: true,
      }),
    ).toBe(false)
    expect(
      McpApp.callableFromResource(modelAndApp, "ui://acme/dashboard", {
        allowUnboundAppOnly: true,
      }),
    ).toBe(false)
    expect(McpApp.callableFromResource(boundElsewhere, "ui://acme/dashboard")).toBe(false)
  })

  test("fails closed for explicit empty or malformed visibility", () => {
    for (const visibility of [[], ["admin"], ["model", "admin"], null, "app"]) {
      const definition = tool({
        ui: {
          resourceUri: "ui://acme/dashboard",
          visibility,
        },
      })
      expect(McpApp.toolVisibility(definition)).toEqual([])
      expect(McpApp.visibleToModel(definition)).toBe(false)
      expect(McpApp.visibleToApp(definition)).toBe(false)
      expect(McpApp.extract(definition)).toBeUndefined()
    }

    const malformedUnbound = tool({ ui: { visibility: ["app", "admin"] } })
    expect(
      McpApp.callableFromResource(malformedUnbound, "ui://acme/dashboard", {
        allowUnboundAppOnly: true,
      }),
    ).toBe(false)
  })

  test("defaults omitted visibility to model and app", () => {
    const definition = tool({ ui: { resourceUri: "ui://acme/dashboard" } })
    expect(McpApp.toolVisibility(definition)).toEqual(["model", "app"])
    expect(McpApp.extract(definition)?.visibility).toEqual(["model", "app"])
  })

  test("accepts self-contained App resources up to eight MiB", () => {
    const tldrawBundleBytes = 4_372_695
    const tldrawBundle = McpApp.resourceBytes("a".repeat(tldrawBundleBytes))
    expect(tldrawBundle?.byteLength).toBe(tldrawBundleBytes)
    expect(McpApp.resourceBytes("a".repeat(McpApp.MAX_RESOURCE_BYTES))?.byteLength).toBe(
      McpApp.MAX_RESOURCE_BYTES,
    )
    expect(McpApp.resourceBytes("a".repeat(McpApp.MAX_RESOURCE_BYTES + 1))).toBeUndefined()
  })

  test("accepts exactly one text or strict base64 blob representation", () => {
    const html = "<!doctype html><p>你好</p>"
    const text = McpApp.resourceContent({ text: html })
    expect(text?.html).toBe(html)
    expect(text?.bytes.byteLength).toBe(Buffer.byteLength(html))

    const blob = Buffer.from(html).toString("base64")
    const decoded = McpApp.resourceContent({ blob })
    expect(decoded?.html).toBe(html)
    expect(Buffer.from(decoded?.bytes ?? []).toString("base64")).toBe(blob)

    expect(McpApp.resourceContent({ text: html, blob })).toBeUndefined()
    expect(McpApp.resourceContent({})).toBeUndefined()
    expect(McpApp.resourceContent({ text: 1 })).toBeUndefined()
  })

  test("rejects malformed base64, invalid UTF-8, and blobs over the decoded limit", () => {
    for (const blob of ["SGVsbG8", "SGVsbG8===", "SGVs bG8=", "SGVsbG8_", "===="]) {
      expect(McpApp.resourceContent({ blob })).toBeUndefined()
    }
    expect(McpApp.resourceContent({ blob: Buffer.from([0xff]).toString("base64") })).toBeUndefined()

    const atLimit = Buffer.alloc(McpApp.MAX_RESOURCE_BYTES, 0x61).toString("base64")
    expect(McpApp.resourceContent({ blob: atLimit })?.bytes.byteLength).toBe(McpApp.MAX_RESOURCE_BYTES)
    const overLimit = Buffer.alloc(McpApp.MAX_RESOURCE_BYTES + 1, 0x61).toString("base64")
    expect(McpApp.resourceContent({ blob: overLimit })).toBeUndefined()
  })
})
