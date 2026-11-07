// Stdio MCP server launched by the agent. Exposes a display-only `show_code`
// tool and relays each call to the harness client over a local Unix socket.
import net from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SOCKET = process.env.VH_SOCKET;
const WORKSPACE = process.env.VH_WORKSPACE;
if (!SOCKET || !WORKSPACE) {
  process.stderr.write("mcp-tool: VH_SOCKET and VH_WORKSPACE are required\n");
  process.exit(1);
}

function relay(message) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET, () => conn.write(JSON.stringify(message) + "\n"));
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    conn.on("error", reject);
  });
}

const server = new McpServer({ name: "voice-harness", version: "0.0.0-m0" });

server.registerTool(
  "show_code",
  {
    description:
      "Show the user a range of lines in a file: opens it in their editor and highlights the range. " +
      "Use this whenever you talk about specific code. Display-only; it does not change files.",
    inputSchema: {
      path: z.string().describe("File path, absolute or relative to the workspace"),
      start_line: z.number().int().min(1),
      end_line: z.number().int().min(1),
    },
  },
  async ({ path: p, start_line, end_line }) => {
    const resolved = path.resolve(WORKSPACE, p);
    if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
      return { isError: true, content: [{ type: "text", text: "Path is outside the workspace." }] };
    }
    if (end_line < start_line) {
      return { isError: true, content: [{ type: "text", text: "end_line is before start_line." }] };
    }
    const ack = await relay({ tool: "show_code", path: resolved, start_line, end_line });
    return { content: [{ type: "text", text: ack.ok ? "Shown to the user." : `Not shown: ${ack.error}` }] };
  },
);

await server.connect(new StdioServerTransport());
