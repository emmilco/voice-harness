# voice-harness — MVP Spec

Status: **draft for review** — no code is written until this is approved.
Background research: `~/Documents/Writing/Analysis and Reports/2026-11-06_voice_code_learning_harness_research.md`

## 1. Goal

A VS Code–based environment where Elliot and a coding agent talk out loud: the agent explains and builds code while steering the editor to what it is talking about, and shows figures in a chat pane. Learning-first. Its first real use is building a small GPT-style LLM from scratch, with the agent writing and narrating the code.

## 2. The MVP slice (acceptance scenario)

The MVP is done when this works end to end, on this Mac, five times in a row without restarting anything:

1. Elliot opens a workspace in VS Code and opens the voice-harness panel.
2. He presses the talk key, asks aloud "where is the loss computed in this file and why is it shaped that way?", and presses the key again.
3. The transcript of his question appears in the chat pane and is sent to Claude.
4. Claude's answer is **spoken aloud**, sentence by sentence, while also appearing as text.
5. While speaking, Claude **opens the relevant file and highlights the lines** it is discussing.
6. Claude shows **one figure** inline in the chat (e.g. a small plot) via a tool call.
7. Elliot starts talking mid-answer → speech **pauses within ~0.5 s**; saying "go on" resumes it; a short "mm-hmm" does **not** pause it.
8. Any tool permission request from Claude appears as **buttons** in the chat pane and blocks until clicked.

## 3. Non-goals for the MVP

- Agents other than Claude (DeepSeek, local models) — designed for, not built.
- Hands-free end-of-turn detection.
- Rich diff review UI beyond what VS Code shows when files change.
- Zed support, phone access, multi-session management.

## 4. Architecture

Three parts, deliberately separated so the VS Code part stays thin (a later Zed port would replace only that part).

```
 ┌──────────────────────── VS Code ─────────────────────────┐
 │ Extension (TypeScript)                                   │
 │  • webview chat pane: transcript, markdown, figures,     │
 │    permission buttons                                    │
 │  • editor control: open file, highlight range            │
 │  • talk-key command → voice process                      │
 └───────┬───────────────────────────────┬──────────────────┘
         │ local socket                  │ local socket
 ┌───────┴─────────────┐        ┌────────┴──────────────────┐
 │ Core (TypeScript,   │        │ Voice process (Python)    │
 │ Node)               │        │  • mic + VAD (Silero)     │
 │  • ACP client       │        │  • STT (faster-whisper)   │
 │  • spawns           │        │  • TTS (Kokoro), sentence │
 │   claude-agent-acp  │        │    queue, pause/resume    │
 │  • routes agent     │        │  • barge-in + backchannel │
 │    text → speech    │        │    filter                 │
 │  • editor/figure    │        └───────────────────────────┘
 │    MCP tools        │
 └─────────────────────┘
```

**Decision to confirm — where the core lives.** Proposed: the core runs *inside* the extension host process at first (simplest), but is written as a separate module with no VS Code imports, so it can be split out later. Alternative: a standalone daemon from day one (cleaner portability, more moving parts).

### 4.1 Agent connection (ACP)

- The core is an ACP client using `@agentclientprotocol/sdk`, spawning `claude-agent-acp` with `CLAUDE_CODE_EXECUTABLE` pointing at the installed `claude` CLI (so it uses the existing subscription login).
- **Billing guard:** the core refuses to start a Claude session if `ANTHROPIC_API_KEY` is set or an `apiKeyHelper` is configured, since either would bill per-token instead of the subscription.
- Agent edits and file locations arrive through ACP tool-call reports; the extension follows them (opens the file being edited).

### 4.2 Tools the harness gives the agent (MCP)

Passed to the agent at session start. All are **display-only** — they change what Elliot sees, never files on disk.

| Tool | Effect |
|---|---|
| `show_code(path, start_line, end_line)` | Open the file in the editor, scroll to and highlight the range. Paths restricted to the workspace. |
| `clear_highlight()` | Remove highlights. |
| `show_figure(kind, content, caption)` | Render a figure in the chat pane. `kind` ∈ `vega-lite` (charts), `svg`, `mermaid` (diagrams), `image` (a PNG/SVG file path in the workspace, e.g. a matplotlib output). |

**Decision to confirm — MCP transport.** ACP agents must support local stdio MCP servers; HTTP is optional. Proposed: a tiny stdio MCP server the agent launches, which relays calls to the extension over a local socket. Alternative: an HTTP MCP server inside the extension (one fewer process, but relies on optional support).

### 4.3 Speech vs screen

- The agent is told (session prompt) to talk in prose and put code, numbers-heavy content and diagrams on screen via tools or code blocks.
- The voice process speaks only prose: code blocks, tables and figure content are shown, not read. (Carried over from yahp's `<<show>>` idea.)
- Speech is sentence-streamed: TTS starts on the first complete sentence, not the whole reply.

### 4.4 Turn-taking

- **Your turn:** a VS Code keybinding toggles listening on/off (tap to start, tap to stop). VS Code keybindings fire on key *press* only, so true hold-to-talk isn't available inside VS Code; a global hold-to-talk hotkey in the voice process is a possible later upgrade.
- **Barge-in while the agent speaks:** Silero VAD with a minimum speech duration (start ~400 ms, tune by test) → pause TTS. If the transcript of the interruption is a backchannel ("mm-hmm", "yeah", "ok", "right"), resume automatically. "Go on" / "continue" resumes; anything else becomes a new turn and the remaining speech is dropped.
- Echo: the agent's own speech must not trigger barge-in. MVP assumes headphones; speaker + echo cancellation is a later item.

### 4.5 Permissions

ACP permission requests appear as buttons in the chat pane and block until clicked. **They are not approvable by voice** in the MVP — a misheard "yes" should never grant a tool call (AISP: the human gate must be real).

## 5. Isolation classification (AISP)

- Claude via ACP: attended, acting (shell/writes), main account; permission prompts always surfaced; no bypass modes. Compliant.
- STT/TTS models: fixed-prompt (audio → text, text → audio; no actions) → main account.
- Future local open-weight agents: agentic → must run in the `aiuser` sandbox. Out of MVP scope; the core's agent-launch code should allow a launch-as-different-user command when that arrives.

## 6. Build order

| Step | What | Done when |
|---|---|---|
| M0 — spike | Plain Node script: ACP client ↔ `claude-agent-acp`; one prompt; one MCP tool round-trip; billing guard | Claude answers on subscription login and successfully calls a dummy `show_code` tool |
| M1 — panel | Extension with webview chat (typed input), editor tools, permission buttons | Scenario steps 3, 5, 8 work with typed input |
| M2 — speaking | Voice process TTS of agent prose, sentence-streamed | Step 4 works |
| M3 — listening | STT, talk key, barge-in, backchannel filter | Steps 2, 7 work |
| M4 — figures | `show_figure` rendering (vega-lite, svg, mermaid, image) under strict CSP | Step 6 works; full scenario passes 5× |

Each step ends with a short demo to Elliot before the next starts.

## 7. Open questions

1. **GPU broker:** QMS §9.3 routes GPU-intensive work (incl. TTS) through gpu-broker, which is a batch queue — wrong shape for real-time speech. Proposed: run Kokoro and faster-whisper on **CPU** (both are small; faster-whisper has no Metal backend anyway), keeping them outside the broker's scope. Needs Elliot's decision if CPU latency turns out too high.
2. Core in extension host vs separate daemon (§4).
3. MCP transport: stdio relay vs HTTP (§4.2).
4. Anthropic terms on subscription use through a self-built client for personal use — not yet checked.
5. TTS voice choice — reuse yahp's audition script.
