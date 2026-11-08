/** Messages between the extension host and the chat webview. */

export type SessionState = "starting" | "ready" | "busy" | "error" | "stopped";

export type VoiceUiState = "loading" | "idle" | "warming" | "listening" | "speaking" | "interrupted" | "unavailable";

export type ToWebview =
  | { type: "state"; state: SessionState; detail?: string }
  | { type: "voice"; state: VoiceUiState; speak: boolean; microphone: boolean; detail?: string }
  | { type: "partial"; text: string; source: "user" | "interruption" | null }
  | { type: "level"; db: number }
  | { type: "user"; text: string; spoken: boolean }
  | { type: "agentText"; chunk: string }
  | { type: "turnEnd"; stopReason: string }
  | { type: "tool"; id: string; title?: string; kind?: string; status?: string; isUpdate: boolean }
  | { type: "permission"; requestId: string; title: string; kind?: string; options: { optionId: string; name: string; kind: string }[] }
  | { type: "permissionDone"; requestId: string }
  | { type: "step"; file: string; startLine: number; endLine: number; text: string }
  | { type: "figure"; id: string; kind: "vega-lite" | "mermaid" | "svg" | "image"; content: string; caption?: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string };

export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "talk" }
  | { type: "toggleSpeak" }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "figureResult"; id: string; ok: boolean; error?: string };
