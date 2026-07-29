import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod"

const resourceUri = "ui://openchamber/test-dashboard"

serveStdio(
  () => {
    const server = new McpServer(
      { name: "openchamber-mcp-2026-test", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {} } },
    )
    // The fixture and the server SDK resolve different patch releases of Zod.
    // The wire-level Standard Schema contract is compatible, but the private
    // Zod generic identities are not. Keep that test-only impedance mismatch
    // at registration rather than weakening the production adapter types.
    const registerTool = server.registerTool.bind(server) as unknown as (
      name: string,
      config: Record<string, unknown>,
      callback: (input: unknown) => unknown | Promise<unknown>,
    ) => unknown

    registerTool(
      "open_dashboard",
      {
        title: "Open dashboard",
        description: "Returns structured dashboard data for an MCP App.",
        inputSchema: z.object({ region: z.string() }),
        outputSchema: z.object({ region: z.string(), total: z.number() }),
        _meta: {
          ui: {
            resourceUri,
            visibility: ["model", "app"],
          },
        },
      },
      async (input) => {
        const { region } = z.object({ region: z.string() }).parse(input)
        const structuredContent = { region, total: 42 }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        }
      },
    )

    registerTool(
      "refresh_dashboard",
      {
        title: "Refresh dashboard",
        inputSchema: z.object({}),
        _meta: {
          ui: {
            resourceUri,
            visibility: ["app"],
          },
        },
      },
      async () => ({ content: [{ type: "text" as const, text: "refreshed" }] }),
    )

    server.registerResource(
      "dashboard",
      resourceUri,
      { title: "Dashboard", mimeType: "text/html;profile=mcp-app" },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/html;profile=mcp-app",
            text: "<!doctype html><html><body><main>MCP 2026 dashboard</main></body></html>",
            _meta: {
              ui: {
                prefersBorder: true,
                permissions: { clipboard: false },
              },
            },
          },
        ],
      }),
    )

    return server
  },
  { legacy: "reject" },
)
