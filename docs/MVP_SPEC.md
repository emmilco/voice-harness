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
 │ Core (TypeScript,   │        │ Voice process (Swift CLI) │
 │ Node)               │        │  Neural Engine, no GPU:   │
 │  • ACP client       │        │  • mic + VAD (Silero,     │
 │  • spawns           │        │    via FluidAudio)        │
 │   claude-agent-acp  │        │  • STT (Apple             │
 │  • routes agent     │        │    SpeechAnalyzer)        │
 │    text → speech    │        │  • TTS (Kokoro via        │
 │  • editor/figure    │        │    FluidAudio), sentence  │
 │    MCP tools        │        │    queue, pause/resume    │
 └─────────────────────┘        │  • barge-in + backchannel │
                                │    filter                 │
                                └───────────────────────────┘
```

**Decided — where the core lives.** The core runs *inside* the extension host process (fewest moving parts), written as a module with no VS Code imports so it can be split into a daemon later.

**Decided — voice process transport (as built in M2/M3).** The extension launches the voice process as a child and speaks JSON lines over its stdin/stdout (`voice/Sources/VoiceHarnessVoice/Protocol.swift`, `core/src/voiceClient.ts`), instead of the separate local socket in the diagram: same separation, fewer moving parts.

**Decided — voice on the Neural Engine.** STT, TTS and VAD run on the Apple Neural Engine, never the GPU, so the voice loop does not contend with LLM training and stays outside gpu-broker's scope. Gated by the M0b check (§6); fallback if M0b fails: a Python voice process running faster-whisper and Kokoro on CPU.

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

**As built — walkthroughs.** `explain_code(path, start_line, end_line, say, step?)` is one walkthrough step: a small range plus the one or two sentences about it. The panel shows the words as a step bubble, speaks them, and applies the highlight through a speech marker, so it lands exactly as those words begin. Steps are re-ordered by `step` if parallel calls arrive out of order (`StepSequencer`). Plain `show_code` and `clear_highlight` are also marker-timed when speech is on. Added because prompting alone did not stop the model from issuing several highlights before writing any words (experiment_log attempts 13-15). The speech layer asks for one `explain_code` call per message: calls batched in one message only execute once the last is written (tool inputs are not streamed by the adapter), which delayed the first step by ~5 s (experiment_log attempts 16-17).

**As built (M4) — figures.** `show_figure(kind, content, caption?)`: `vega-lite` (JSON spec, data inlined), `mermaid` (diagram source), `svg` (markup), `image` (workspace path; the extension sends it to the webview as a data: URI, max 15 MB). The webview renders and reports success or the error, which returns to the agent as the tool result (10 s timeout) so it can fix and retry. Vega runs with the `vega-interpreter` AST evaluator (no `eval`); Mermaid at `securityLevel: "strict"`; agent SVG is displayed as an `<img>`, where scripts cannot run.

**Decided — panel content security policy (M4, Elliot).** Scripts: nonce only. Styles: `'unsafe-inline'` allowed, because Mermaid emits `<style>` elements; images and fonts only from the extension or `data:`, and no network access, so injected styles can neither run code nor send data anywhere.

**Decided — other agents run in the main account with the normal allow-list (Elliot, 2026-11-08).** Local and cloud models driven through other ACP agents (e.g. opencode) run in Elliot's main account in the attended panel, under his usual Claude Code-style permissions. Elliot's view: an attended interactive session does not need an AISP amendment. Noted for future sessions: AISP Part III's text places agentic local models in the `aiuser` sandbox "always", and allow-listed commands run without a prompt, so the attendance gate is partial; Elliot has decided the matter.

**Decided — transitive `@anthropic-ai/sdk` accepted (Elliot, policy exception).** Elliot's QMS §11.1 says the `anthropic` SDK shall not be installed. `@anthropic-ai/sdk` arrives as a dependency of `@anthropic-ai/claude-agent-sdk`, on which `claude-agent-acp` is built; it is in `node_modules/` and in the packaged `.vsix`. No harness code imports it or calls the API. The rule's purpose (no per-token billing) is enforced by the billing guard (`core/src/billingGuard.ts`), which requires a claude.ai login and refuses API keys, `apiKeyHelper` and alternate providers. Do not add direct uses of the SDK.

**Decided — MCP transport.** A tiny stdio MCP server the agent launches, relaying calls to the extension over a local socket. (ACP agents must support stdio MCP servers; HTTP support is optional.)

### 4.3 Speech vs screen

- **Instruction layering (decided).** Harness sessions load Elliot's normal Claude Code setup, including the global `CLAUDE.md` (QMS), *plus* a harness speech layer appended to the session prompt. The speech layer tells the agent: talk in prose; keep spoken replies short; use `show_code` / `show_figure` to point at things; put QMS ritual output (status lines, provenance lines, question blocks) on screen in a marked block that is shown but not spoken. How the adapter accepts an appended prompt (likely `_meta.claudeCode.options`) is verified in M1.
- The agent is told (session prompt) to talk in prose and put code, numbers-heavy content and diagrams on screen via tools or code blocks.
- The voice process speaks only prose: code blocks, tables and figure content are shown, not read. (Carried over from yahp's `<<show>>` idea.)
- Speech is sentence-streamed: TTS starts on the first complete sentence, not the whole reply.

### 4.4 Turn-taking

- **Start cue:** listening starts with an audible tone and a visible "listening" indicator in the panel (M0b showed that without a cue, speech is lost before the user knows recording began).
- **Your turn:** a VS Code keybinding toggles listening on/off (tap to start, tap to stop). VS Code keybindings fire on key *press* only, so true hold-to-talk isn't available inside VS Code; a global hold-to-talk hotkey in the voice process is a possible later upgrade.
- **Automatic interruption is off by default (Elliot, after M4).** With key-ended turns, pressing Talk already stops speech; automatic pausing mostly added false pauses (coughs, room speech). It remains available as the setting `voiceHarness.autoInterrupt`, which loads the voice-activity model only when on.
- **Barge-in while the agent speaks (as built, when enabled):** Silero VAD (FluidAudio, 256 ms chunks) runs only while speech is playing. On detected speech, playback **pauses at once** (no minimum-duration guard); the interruption, with 0.8 s of pre-roll, is transcribed until 0.7 s of silence (cap 20 s). `core/src/turnPolicy.ts` then decides: empty, backchannel ("mm-hmm", "yeah", "okay") or continuation ("go on") → resume; anything else → stop speech, cancel the agent's turn, and send the interruption as the new turn.
- Talk key: `Ctrl+Shift+Space` (command `voiceHarness.toggleListening`) or the 🎙 Talk button. Speaking while the agent is mid-turn replaces that turn; speech from the replaced turn is suppressed.
- Echo: the agent's own speech must not trigger barge-in. Default assumes headphones; the setting `voiceHarness.echoCancellation` enables macOS voice processing (echo cancellation) for use with speakers.

### 4.5 Permissions

Harness sessions use Elliot's normal Claude Code allow-list (decided): anything it pre-approves runs without a prompt, exactly as in a terminal session (observed in M0). Everything else arrives as an ACP permission request, shown as buttons in the chat pane, blocking until clicked. **They are not approvable by voice** in the MVP — a misheard "yes" should never grant a tool call (AISP: the human gate must be real).

## 5. Isolation classification (AISP)

- Claude via ACP: attended, acting (shell/writes), main account; permission prompts always surfaced; no bypass modes. Compliant.
- STT/TTS/VAD models: fixed-prompt (audio → text, text → audio; no actions) → main account, on the Neural Engine.
- Future local open-weight agents: agentic → must run in the `aiuser` sandbox. Out of MVP scope; the core's agent-launch code should allow a launch-as-different-user command when that arrives.

## 6. Build order

| Step | What | Done when |
|---|---|---|
| M0 — spike | Plain Node script: ACP client ↔ `claude-agent-acp`; one prompt; one MCP tool round-trip; billing guard | Claude answers on subscription login and successfully calls a dummy `show_code` tool |
| M0b — voice check | Minimal Swift CLI: Kokoro via FluidAudio speaks a sentence; SpeechAnalyzer transcribes a recorded question; report time-to-first-audio, transcription latency, and stability on this machine's macOS 27 | Both run without crashes and latency is acceptable to Elliot; otherwise switch to the CPU/Python fallback |
| M1 — panel | Extension with webview chat (typed input), editor tools, permission buttons | Scenario steps 3, 5, 8 work with typed input |
| M2 — speaking | Voice process TTS of agent prose, sentence-streamed | Step 4 works |
| M3 — listening | STT, talk key, barge-in, backchannel filter | Steps 2, 7 work |
| M4 — figures | `show_figure` rendering (vega-lite, svg, mermaid, image) under strict CSP | Step 6 works; full scenario passes 5× |

Each step ends with a short demo to Elliot before the next starts.

## 7. Open questions

1. Anthropic terms on subscription use through a self-built client for personal use — not yet checked.

Resolved by M0b (passed 2026-11-06; see `spike/m0b/RESULTS.md`): FluidAudio is Apache-2.0 and runs Kokoro without crashes on macOS 27.2; voice is `af_heart`; weights live in the MLP store `fluidaudio`.
