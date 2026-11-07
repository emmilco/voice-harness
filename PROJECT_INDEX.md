# voice-harness — PROJECT_INDEX

VS Code–based voice + code learning environment: talk aloud with a coding agent (via the Agent Client Protocol) while it steers the editor and shows figures inline. See `docs/MVP_SPEC.md`.

## Folder Structure

```
voice-harness/
├── PROJECT_INDEX.md   # this file
├── docs/              # specs and design documents
│   └── MVP_SPEC.md    # MVP scope, architecture, build order, open questions
└── spike/             # throwaway milestone spikes (not product code)
    └── m0/            # ACP client ↔ claude-agent-acp + stdio MCP display tool
        ├── client.mjs     # billing guard, ACP client, permission policy, socket relay
        ├── mcp-tool.mjs   # stdio MCP server exposing show_code, relays to client
        ├── fixture/       # tiny_gpt.py — workspace the agent is pointed at
        └── package.json   # exact-pinned deps (node_modules/ gitignored)
```

Planned (per `docs/MVP_SPEC.md` §4; created when the corresponding milestone starts): `extension/` (VS Code extension, TypeScript), `core/` (ACP client + MCP tools, TypeScript, no VS Code imports), `voice/` (Swift voice process, Swift Package Manager), `spike/m0b/` (voice check).

Run the M0 spike: `cd spike/m0 && npm ci --ignore-scripts && node client.mjs ["optional prompt"]`.

## Naming Conventions

- Directories: lowercase, kebab-case.
- Docs: `UPPER_SNAKE.md` for standing project documents in `docs/`.
- TypeScript: camelCase files; Swift: UpperCamelCase type-named files.
