// Stdio MCP server launched by the agent. Exposes display-only tools and relays
// each call to the harness over the Unix socket named in VH_SOCKET. Paths are
// confined to VH_WORKSPACE.
import net from "node:net";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { RelayReply, RelayRequest } from "./relay";

const SOCKET = process.env.VH_SOCKET;
const WORKSPACE = process.env.VH_WORKSPACE;
if (!SOCKET || !WORKSPACE) {
  process.stderr.write("voice-harness mcp: VH_SOCKET and VH_WORKSPACE are required\n");
  process.exit(1);
}

function relay(message: RelayRequest): Promise<RelayReply> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCKET!, () => conn.write(JSON.stringify(message) + "\n"));
    let buf = "";
    conn.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        conn.end();
        resolve(JSON.parse(buf.slice(0, nl)) as RelayReply);
      }
    });
    conn.on("error", reject);
  });
}

const result = (reply: RelayReply, done: string) =>
  reply.ok
    ? { content: [{ type: "text" as const, text: done }] }
    : { isError: true, content: [{ type: "text" as const, text: `Not shown: ${reply.error}` }] };

const server = new McpServer({ name: "voice-harness", version: "0.1.0" });

server.registerTool(
  "show_code",
  {
    description:
      "Show the user a range of lines in a file: opens it in his editor and highlights the range. " +
      "Call this whenever you talk about specific code, before or while you discuss it. " +
      "Display-only; it never changes files.",
    inputSchema: {
      path: z.string().describe("File path, absolute or relative to the workspace root"),
      start_line: z.number().int().min(1).describe("First line to highlight (1-based)"),
      end_line: z.number().int().min(1).describe("Last line to highlight (1-based, inclusive)"),
    },
  },
  async ({ path: p, start_line, end_line }) => {
    const resolved = path.resolve(WORKSPACE, p);
    if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
      return { isError: true, content: [{ type: "text" as const, text: "Path is outside the workspace." }] };
    }
    if (end_line < start_line) {
      return { isError: true, content: [{ type: "text" as const, text: "end_line is before start_line." }] };
    }
    return result(await relay({ tool: "show_code", path: resolved, start_line, end_line }), "Shown to the user.");
  },
);

server.registerTool(
  "explain_code",
  {
    description:
      "One step of a code walkthrough: highlights a small range in the user's editor and says the words that go with it. " +
      "The words appear in the chat and are spoken; the highlight lands as they begin. Walk through code as a sequence " +
      "of these calls, one small piece each (usually one to six lines), numbering them with `step` from 1. Put the " +
      "explanation in `say`, not in your reply text. Display-only; never changes files.",
    inputSchema: {
      path: z.string().describe("File path, absolute or relative to the workspace root"),
      start_line: z.number().int().min(1).describe("First line to highlight (1-based)"),
      end_line: z.number().int().min(1).describe("Last line to highlight (1-based, inclusive)"),
      say: z.string().min(1).describe('One or two spoken sentences about exactly these lines ("Here we see…", "Notice these two lines…")'),
      step: z.number().int().min(1).optional().describe("Position of this step in the walkthrough, starting at 1"),
    },
  },
  async ({ path: p, start_line, end_line, say, step }) => {
    const resolved = path.resolve(WORKSPACE, p);
    if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
      return { isError: true, content: [{ type: "text" as const, text: "Path is outside the workspace." }] };
    }
    if (end_line < start_line) {
      return { isError: true, content: [{ type: "text" as const, text: "end_line is before start_line." }] };
    }
    return result(await relay({ tool: "explain_code", path: resolved, start_line, end_line, say, step }), "Queued for the user.");
  },
);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

server.registerTool(
  "show_figure",
  {
    description:
      "Show the user a figure in the chat panel, beside the conversation. Use it whenever a picture explains better than words: " +
      "charts of numbers (loss curves, distributions, comparisons), diagrams of structure or flow (architectures, data paths), " +
      "or images your code produced. Kinds: " +
      "'vega-lite' — content is a Vega-Lite JSON spec with data inlined under data.values (no URLs; the panel has no network); " +
      "'mermaid' — content is Mermaid diagram source (flowchart, sequenceDiagram, classDiagram, …); " +
      "'svg' — content is a complete <svg> document; " +
      "'image' — content is the path of a PNG, JPEG, GIF, WebP or SVG file in the workspace (for example a matplotlib savefig output). " +
      "If rendering fails the error comes back as this tool's result; fix the figure and call again. Display-only; never changes files.",
    inputSchema: {
      kind: z.enum(["vega-lite", "mermaid", "svg", "image"]),
      content: z.string().describe("The spec, diagram source, SVG markup, or image file path, according to kind"),
      caption: z.string().optional().describe("One short line shown under the figure"),
    },
  },
  async ({ kind, content, caption }) => {
    let payload = content;
    if (kind === "image") {
      const resolved = path.resolve(WORKSPACE, content);
      if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
        return { isError: true, content: [{ type: "text" as const, text: "Image path is outside the workspace." }] };
      }
      if (!IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
        return { isError: true, content: [{ type: "text" as const, text: "Image must be .png, .jpg, .jpeg, .gif, .webp or .svg." }] };
      }
      payload = resolved;
    }
    return result(await relay({ tool: "show_figure", kind, content: payload, caption }), "Shown to the user.");
  },
);

server.registerTool(
  "show_live_chart",
  {
    description:
      "Show a chart that keeps updating as a data file grows, e.g. a training loss curve while a run is in progress. " +
      "spec is a Vega-Lite JSON spec whose top-level data is exactly {\"name\": \"live\"}; data_file is a workspace file the run " +
      "appends to: JSON Lines (.jsonl, one object per line) or CSV with a header row. The file may not exist yet. " +
      "The panel re-reads it about once a second (last 5000 rows) and updates the chart in place. Display-only.",
    inputSchema: {
      spec: z.string().describe('Vega-Lite JSON spec with "data": {"name": "live"}'),
      data_file: z.string().describe("Path of the .jsonl/.ndjson or .csv file, absolute or relative to the workspace root"),
      caption: z.string().optional().describe("One short line shown under the chart"),
    },
  },
  async ({ spec, data_file, caption }) => {
    const resolved = path.resolve(WORKSPACE, data_file);
    if (!resolved.startsWith(WORKSPACE + path.sep)) {
      return { isError: true, content: [{ type: "text" as const, text: "data_file is outside the workspace." }] };
    }
    if (!/\.(jsonl|ndjson|csv)$/i.test(resolved)) {
      return { isError: true, content: [{ type: "text" as const, text: "data_file must end in .jsonl, .ndjson or .csv." }] };
    }
    let parsed: { data?: { name?: string } };
    try {
      parsed = JSON.parse(spec);
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: `spec is not valid JSON: ${(err as Error).message}` }] };
    }
    if (parsed?.data?.name !== "live") {
      return { isError: true, content: [{ type: "text" as const, text: 'spec must have top-level "data": {"name": "live"}.' }] };
    }
    return result(await relay({ tool: "show_live_chart", spec, data_file: resolved, caption }), "Shown to the user; it updates as the file grows.");
  },
);

server.registerTool(
  "clear_highlight",
  {
    description: "Remove the highlight placed by show_code, when it is no longer what you are talking about.",
    inputSchema: {},
  },
  async () => result(await relay({ tool: "clear_highlight" }), "Highlight cleared."),
);

await server.connect(new StdioServerTransport());
