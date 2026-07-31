import { describe, expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { connectModernLocal } from "../../src/mcp/connection-adapter"

const directory = fileURLToPath(new URL("../..", import.meta.url))
const fixture = fileURLToPath(new URL("./fixtures/mcp-2026-server.ts", import.meta.url))

describe("MCP 2026 connection adapter", () => {
  test("negotiates the 2026 era and preserves MCP App metadata", async () => {
    const connection = await connectModernLocal({
      directory,
      command: process.execPath,
      args: [fixture],
      cwd: path.dirname(fixture),
      env: process.env,
      timeout: 10_000,
    })

    try {
      expect(connection.adapter).toBe("2026-sdk")
      expect(connection.era).toBe("2026-07-28")
      expect(connection.protocolVersion).toBe("2026-07-28")
      expect(connection.apps).toEqual({
        client: true,
        server: true,
        negotiated: true,
      })

      const listed = await connection.client.listTools()
      const open = listed.tools.find((tool) => tool.name === "open_dashboard")
      const refresh = listed.tools.find((tool) => tool.name === "refresh_dashboard")

      expect(open?._meta).toMatchObject({
        ui: {
          resourceUri: "ui://openchamber/test-dashboard",
          visibility: ["model", "app"],
        },
      })
      expect(refresh?._meta).toMatchObject({
        ui: {
          visibility: ["app"],
        },
      })

      const result = await connection.client.callTool({
        name: "open_dashboard",
        arguments: { region: "apac" },
      })
      expect(result.structuredContent).toEqual({ region: "apac", total: 42 })

      const resource = await connection.client.readResource({
        uri: "ui://openchamber/test-dashboard",
      })
      expect(resource.contents[0]).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        text: expect.stringContaining("MCP 2026 dashboard"),
        _meta: {
          ui: {
            prefersBorder: true,
          },
        },
      })
    } finally {
      await connection.client.close()
    }
  })
})
