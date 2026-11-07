# voice-harness — PROJECT_INDEX

VS Code–based voice + code learning environment: talk aloud with a coding agent (via the Agent Client Protocol) while it steers the editor and shows figures inline. See `docs/MVP_SPEC.md`.

## Folder Structure

```
voice-harness/
├── PROJECT_INDEX.md   # this file
└── docs/              # specs and design documents
    └── MVP_SPEC.md    # MVP scope, architecture, build order, open questions
```

Planned (per `docs/MVP_SPEC.md` §4; created when the corresponding milestone starts): `extension/` (VS Code extension, TypeScript), `core/` (ACP client + MCP tools, TypeScript, no VS Code imports), `voice/` (Python voice process), `spike/` (M0 throwaway).

## Naming Conventions

- Directories: lowercase, kebab-case.
- Docs: `UPPER_SNAKE.md` for standing project documents in `docs/`.
- TypeScript: camelCase files; Python: snake_case modules.
