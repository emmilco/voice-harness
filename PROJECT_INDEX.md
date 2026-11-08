# voice-harness — PROJECT_INDEX

VS Code–based voice + code learning environment: talk aloud with a coding agent (via the Agent Client Protocol) while it steers the editor and shows figures inline. See `docs/MVP_SPEC.md`.

## Folder Structure

```
voice-harness/
├── PROJECT_INDEX.md   # this file
├── README.md          # user-facing overview, requirements, install, settings
├── scripts/
│   └── install-extension.sh # build, package (.vsix into build/, gitignored) and install/update; safe to re-run
├── package.json       # npm workspace root (core, extension); scripts: build, check, smoke
├── experiment_log.md  # append-only log of failed/diagnosed attempts (QMS §7.3)
├── .vscode/           # launch.json (F5 → Extension Development Host on spike/m0/fixture), tasks.json (build)
├── core/              # editor-independent harness core (TypeScript, no VS Code imports)
│   ├── src/
│   │   ├── agentSession.ts  # ACP session with claude-agent-acp: start, prompt, cancel, handlers
│   │   ├── billingGuard.ts  # refuses per-token billing configurations
│   │   ├── relay.ts         # Unix-socket relay from the MCP server to the front end
│   │   ├── mcpServer.ts     # stdio MCP server: show_code, explain_code, clear_highlight, show_figure (bundled to extension/dist)
│   │   ├── stepSequencer.ts # delivers numbered explain_code steps in order
│   │   ├── editorContext.ts # <editor-context> block sent with each turn
│   │   ├── dataFile.ts      # parses .jsonl/.csv metrics files for live charts
│   │   ├── speechLayer.ts   # system-prompt text appended to Claude Code's standard prompt
│   │   ├── speechText.ts    # SpeechChunker: streamed markdown → speakable sentences (skips fences, tables)
│   │   ├── turnPolicy.ts    # classifyInterruption: resume vs new turn
│   │   ├── voiceClient.ts   # spawns the voice process; JSON-lines protocol
│   │   └── index.ts         # public exports
│   └── scripts/
│       ├── smoke.ts         # headless one-turn agent test (`npm run smoke`; `--speak` speaks the reply; Vega-Lite figures validated headlessly)
│       └── unit.ts          # unit tests for chunker and policy (`npm run unit`)
├── extension/         # VS Code extension (thin presentation layer)
│   ├── package.json   # extension manifest: commands, settings
│   ├── esbuild.mjs    # bundles extension.js, mcpServer.mjs, webview.js into dist/ (gitignored)
│   ├── src/
│   │   ├── extension.ts     # activation, commands
│   │   ├── panel.ts         # chat panel: owns the session, permissions, webview HTML/CSP
│   │   ├── editorControl.ts # show_code highlight and follow-along reveal
│   │   ├── editorTracker.ts # remembers the user's last file editor for editor context
│   │   ├── protocol.ts      # extension ↔ webview message types
│   │   └── toolchain.ts     # resolves node / claude via settings or a login shell
│   └── webview/       # main.ts (chat UI, markdown-it, `onscreen` blocks), figures.ts (Vega-Lite, Mermaid, SVG, images), style.css
├── voice/             # Swift voice process (SwiftPM; FluidAudio pinned exactly)
│   └── Sources/VoiceHarnessVoice/
│       ├── main.swift          # startup: mic permission, Kokoro warm-up, VAD, speech assets, command loop
│       ├── Protocol.swift      # stdin commands / stdout events (JSON lines)
│       ├── AudioIO.swift       # one AVAudioEngine: speech + tone players, 16 kHz mic tap
│       ├── Speaker.swift       # sentence queue → Kokoro → playback; pause/resume/stop
│       ├── LiveTranscription.swift # one live SpeechAnalyzer utterance
│       └── Controller.swift    # listen / speak / interrupt state machine
├── tools/
│   ├── fake-training.mjs # appends a falling loss to a .jsonl file, for trying live charts
│   └── voice-sampler/ # local page for hearing every English Kokoro voice: `node tools/voice-sampler/server.mjs` → http://127.0.0.1:4317
├── docs/              # specs and design documents
│   └── MVP_SPEC.md    # MVP scope, architecture, build order, open questions
└── spike/             # throwaway milestone spikes (not product code)
    ├── m0/            # ACP client ↔ claude-agent-acp + stdio MCP display tool; fixture/ is the demo workspace
    └── m0b/           # Swift voice check: Kokoro TTS (FluidAudio) + Apple SpeechAnalyzer STT; RESULTS.md
```

Setup: `npm install --ignore-scripts && npm run build` (builds the TypeScript bundles and the Swift voice process).

Packaged install (any Mac, including work): `scripts/install-extension.sh`. The `.vsix` carries the bundles, the agent adapter (without the SDK's bundled Claude CLI; the user's `claude` is used) and the voice binary in `bin/`; the extension finds these inside itself first, then falls back to the repo layout. Speech models default to `~/Library/Application Support/voice-harness/models`; on this Mac that path is a link to the MLP store `/Users/Shared/ai/models/fluidaudio`.

Everyday use on this Mac (development install): `~/.vscode/extensions/emmilco.voice-harness-0.1.0` is a symlink to `extension/`, so the extension loads in every VS Code window and uses this repo's `node_modules/` and `voice/.build/`. Open any folder, then run **Voice Harness: Open Panel**. After changing code: `npm run build`, then **Developer: Reload Window** in open windows. A broken build here breaks the panel everywhere; a packaged `.vsix` install is the planned replacement once the harness is stable.

Development: open this folder in VS Code and press F5 (Extension Development Host on `spike/m0/fixture`; the development copy takes precedence over the installed link).

Run the M0 spike: `cd spike/m0 && npm ci --ignore-scripts && node client.mjs ["optional prompt"]`.

## Naming Conventions

- Directories: lowercase, kebab-case.
- Docs: `UPPER_SNAKE.md` for standing project documents in `docs/`.
- TypeScript: camelCase files; Swift: UpperCamelCase type-named files.

Model weights for the voice process live in the MLP-governed store `/Users/Shared/ai/models/fluidaudio` (never in this repo). Apple's speech-recognition assets are OS-managed.
