/** Messages between the extension host and the chat webview. */

/** Tool content as shown in the chat (mirrors ToolContent in core). */
export type ToolContentView =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; oldText: string | null; newText: string };

export type SessionState = "starting" | "ready" | "busy" | "error" | "stopped";

export type VoiceUiState = "loading" | "idle" | "warming" | "listening" | "speaking" | "interrupted" | "unavailable";

export type ToWebview =
  | { type: "state"; state: SessionState; detail?: string }
  | { type: "voice"; state: VoiceUiState; speak: boolean; microphone: boolean; conversation: boolean; autoListening: boolean; detail?: string }
  | { type: "partial"; text: string; source: "user" | "interruption" | null }
  | { type: "level"; db: number }
  | { type: "user"; text: string; spoken: boolean; context?: string }
  | { type: "agentText"; chunk: string }
  | { type: "turnEnd"; stopReason: string }
  | {
      type: "tool";
      id: string;
      title?: string;
      kind?: string;
      status?: string;
      name?: string;
      content?: ToolContentView[];
      /** The harness's own display tools: kept out of the transcript. */
      hidden?: boolean;
      isUpdate: boolean;
    }
  | {
      type: "permission";
      requestId: string;
      title: string;
      kind?: string;
      content?: ToolContentView[];
      options: { optionId: string; name: string; kind: string }[];
    }
  | { type: "permissionDone"; requestId: string }
  | { type: "step"; file: string; startLine: number; endLine: number; text: string }
  | { type: "figure"; id: string; kind: "vega-lite" | "mermaid" | "svg" | "image"; content: string; caption?: string; live?: boolean }
  | { type: "figureData"; id: string; rows: Record<string, unknown>[] }
  | { type: "sessions"; items: { id: string; title: string; updatedAt?: string }[]; currentId?: string }
  | { type: "clear" }
  | { type: "options"; options: { id: string; name: string; current: string; choices: { value: string; name: string; description?: string }[] }[] }
  | { type: "usage"; used: number; size: number }
  | { type: "title"; title: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "talk" }
  | { type: "toggleSpeak" }
  | { type: "toggleConversation" }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "figureResult"; id: string; ok: boolean; error?: string }
  | { type: "openDiff"; path: string; oldText: string | null; newText: string }
  | { type: "listSessions" }
  | { type: "loadSession"; id: string }
  | { type: "newSession" }
  | { type: "setOption"; id: string; value: string };
