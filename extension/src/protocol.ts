/** Messages between the extension host and the chat webview. */

/** Tool content as shown in the chat (mirrors ToolContent in core). */
export type ToolContentView =
  | { kind: "text"; text: string }
  | { kind: "diff"; path: string; oldText: string | null; newText: string };

export type SessionState = "starting" | "ready" | "busy" | "error" | "stopped";

export type VoiceUiState = "loading" | "idle" | "warming" | "listening" | "speaking" | "interrupted" | "unavailable";

export interface ConfigOptionView {
  id: string;
  name: string;
  current: string;
  choices: { value: string; name: string; description?: string }[];
}

export interface TabSummary {
  id: string;
  label: string;
  busy: boolean;
  /** Output arrived while the tab was in the background. */
  unread: boolean;
  /** A permission request is waiting in this tab. */
  needsApproval: boolean;
}

/** About one conversation; carries the id of the tab it belongs to. */
export type TabMessage = { tabId: string } & (
  | { type: "state"; state: SessionState; detail?: string }
  | { type: "user"; text: string; spoken: boolean; context?: string; attachments?: string[]; turn?: number }
  /** `segment` groups text into one bubble; a new segment starts a new bubble. */
  | { type: "agentText"; chunk: string; segment: string }
  /** The bubble or step now being read aloud (null: nothing). */
  | { type: "nowSpeaking"; ref: string | null }
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
  | { type: "step"; ref: string; path: string; file: string; startLine: number; endLine: number; text: string }
  | { type: "figure"; id: string; kind: "vega-lite" | "mermaid" | "svg" | "image"; content: string; caption?: string; live?: boolean }
  | { type: "figureData"; id: string; rows: Record<string, unknown>[] }
  | { type: "options"; options: ConfigOptionView[] }
  | { type: "usage"; used: number; size: number }
  | { type: "title"; title: string }
  | { type: "commands"; commands: { name: string; description: string; hint?: string }[] }
  | { type: "queued"; id: string; text: string; images: number }
  | { type: "dequeued"; id: string }
  | { type: "clear" }
  /** Put text in the message box (after a rewind) when this tab is visible. */
  | { type: "prefill"; text: string }
  | { type: "notice"; text: string }
  | { type: "error"; text: string }
);

/** About the panel as a whole. A notice without a tab goes to the visible tab. */
export type PanelMessage =
  | { type: "voice"; state: VoiceUiState; speak: boolean; microphone: boolean; conversation: boolean; autoListening: boolean; detail?: string }
  | { type: "partial"; text: string; source: "user" | "interruption" | null }
  | { type: "level"; db: number }
  | { type: "tabs"; tabs: TabSummary[]; activeId: string }
  | { type: "files"; query: string; files: string[] }
  | { type: "sessions"; items: { id: string; title: string; updatedAt?: string; openInTab?: string }[] }
  | { type: "notice"; text: string };

export type ToWebview = TabMessage | PanelMessage;

/** Requests about one conversation. */
export type TabRequest = { tabId: string } & (
  | { type: "send"; text: string; images?: { mimeType: string; data: string }[] }
  | { type: "stop" }
  | { type: "restart" }
  | { type: "permission"; requestId: string; optionId: string | null }
  | { type: "figureResult"; id: string; ok: boolean; error?: string }
  | { type: "setOption"; id: string; value: string }
  | { type: "unqueue"; id: string }
  | { type: "sendNow"; id: string }
  /** Roll the conversation back to just before the user's message number `turn`. */
  | { type: "rewind"; turn: number }
  /** Highlight a walkthrough step's lines again. */
  | { type: "showStep"; path: string; startLine: number; endLine: number }
);

export type PanelRequest =
  | { type: "ready" }
  | { type: "talk" }
  | { type: "toggleSpeak" }
  | { type: "toggleConversation" }
  | { type: "listFiles"; query: string }
  | { type: "openDiff"; path: string; oldText: string | null; newText: string }
  | { type: "listSessions" }
  /** Open a past conversation in a new tab (or switch to the tab already showing it). */
  | { type: "openSession"; id: string }
  | { type: "newTab" }
  | { type: "closeTab"; id: string }
  | { type: "switchTab"; id: string };

export type FromWebview = TabRequest | PanelRequest;
