import { rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** A display request from the MCP server, one JSON object per connection. */
export type RelayRequest =
  | { tool: "show_code"; path: string; start_line: number; end_line: number }
  | { tool: "clear_highlight" };

export interface RelayReply {
  ok: boolean;
  error?: string;
}

export interface Relay {
  socketPath: string;
  close(): void;
}

/**
 * Listens on a private Unix socket for display requests relayed by the MCP
 * server process and answers each with the handler's reply.
 */
export function startRelay(handle: (req: RelayRequest) => Promise<RelayReply>): Promise<Relay> {
  const socketPath = path.join(os.tmpdir(), `voice-harness-${process.pid}-${Date.now()}.sock`);
  rmSync(socketPath, { force: true });

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", async (data) => {
      buf += data;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let reply: RelayReply;
      try {
        reply = await handle(JSON.parse(buf.slice(0, nl)) as RelayRequest);
      } catch (err) {
        reply = { ok: false, error: (err as Error).message };
      }
      conn.end(JSON.stringify(reply) + "\n");
    });
    conn.on("error", () => {});
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close() {
          server.close();
          rmSync(socketPath, { force: true });
        },
      });
    });
  });
}
