# voice-harness — PROJECT_INDEX

VS Code–based voice + code learning environment: talk aloud with a coding agent (via the Agent Client Protocol) while it steers the editor and shows figures inline. See `docs/MVP_SPEC.md`.

## Folder Structure

```
voice-harness/
├── PROJECT_INDEX.md   # this file
├── docs/              # specs and design documents
│   └── MVP_SPEC.md    # MVP scope, architecture, build order, open questions
└── spike/             # throwaway milestone spikes (not product code)
    ├── m0/            # ACP client ↔ claude-agent-acp + stdio MCP display tool
    │   ├── client.mjs     # billing guard, ACP client, permission policy, socket relay
    │   ├── mcp-tool.mjs   # stdio MCP server exposing show_code, relays to client
    │   ├── fixture/       # tiny_gpt.py — workspace the agent is pointed at
    │   └── package.json   # exact-pinned deps (node_modules/ gitignored)
    └── m0b/           # Swift voice check: Kokoro TTS (FluidAudio) + Apple SpeechAnalyzer STT
        ├── Package.swift          # FluidAudio pinned exactly, TTS trait
        ├── Sources/VoiceCheck/    # main.swift — `tts` and `stt` subcommands
        └── RESULTS.md             # measured timings and findings
```

Planned (per `docs/MVP_SPEC.md` §4; created when the corresponding milestone starts): `extension/` (VS Code extension, TypeScript), `core/` (ACP client + MCP tools, TypeScript, no VS Code imports), `voice/` (Swift voice process, Swift Package Manager).

Run the M0 spike: `cd spike/m0 && npm ci --ignore-scripts && node client.mjs ["optional prompt"]`.

## Naming Conventions

- Directories: lowercase, kebab-case.
- Docs: `UPPER_SNAKE.md` for standing project documents in `docs/`.
- TypeScript: camelCase files; Swift: UpperCamelCase type-named files.

Model weights for the voice process live in the MLP-governed store `/Users/Shared/ai/models/fluidaudio` (never in this repo). Apple's speech-recognition assets are OS-managed.
