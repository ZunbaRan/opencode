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
        maxHeight: 720,
      },
    })

    expect(McpApp.extract(definition)).toEqual({
      resourceUri: "ui://acme/dashboard",
      visibility: ["app"],
      maxHeight: 720,
    })
    expect(McpApp.visibleToModel(definition)).toBe(false)
    expect(McpApp.visibleToApp(definition)).toBe(true)
  })

  test("supports the legacy ui/resourceUri key without trusting invalid URIs", () => {
    expect(McpApp.extract(tool({ "ui/resourceUri": "ui://acme/legacy" }))).toEqual({
      resourceUri: "ui://acme/legacy",
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

    expect(McpApp.extract(definition)).toEqual({ resourceUri: "ui://acme/dashboard" })
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
})
