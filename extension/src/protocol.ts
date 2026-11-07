/** Messages between the extension host and the chat webview. */

export type SessionState = "starting" | "ready" | "busy" | "error" | "stopped";

export type ToWebview =
  | { type: "state"; state: SessionState; detail?: string }
  | { type: "user"; text: string }
  | { type: "agentText"; chunk: string }
  | { type: "turnEnd"; stopReason: string }
  | { type: "tool"; id: string; title?: string; kind?: string; status?: string; isUpdate: boolean }
  | { type: "permission"; requestId: string; title: string; kind?: string; options: { optionId: string; name: string; kind: string }[] }
  | { type: "permissionDone"; requestId: string }
  | { type: "error"; text: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "permission"; requestId: string; optionId: string | null };
