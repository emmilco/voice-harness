#!/bin/bash
# Builds voice-harness, packages it as a .vsix, and installs it into VS Code.
# Safe to re-run: each run rebuilds and reinstalls (updates) the extension.
#
#   scripts/install-extension.sh                 build, package, install
#   scripts/install-extension.sh --package-only  build and package; skip installing
#   scripts/install-extension.sh --replace-link  replace a development install (a link to this repo)
#
# Requires: macOS 26+ on Apple Silicon, Xcode (Swift 6), Node 22+, and the `code` command.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/build/vsix-stage"
INSTALL=1
REPLACE_LINK=0
for arg in "$@"; do
  case "$arg" in
    --package-only) INSTALL=0 ;;
    --replace-link) REPLACE_LINK=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$1"; }

step "Checking tools"
command -v node >/dev/null || { echo "node not found (Node 22+ required)" >&2; exit 1; }
command -v swift >/dev/null || { echo "swift not found (install Xcode)" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node 22+ required (found $(node --version))" >&2; exit 1; }
if [ "$INSTALL" -eq 1 ]; then
  command -v code >/dev/null || { echo "the 'code' command is not on PATH (VS Code: Shell Command: Install 'code' command in PATH)" >&2; exit 1; }
fi

step "Installing build dependencies"
cd "$ROOT"
npm install --ignore-scripts --no-audit --no-fund

step "Building (TypeScript bundles and Swift voice process)"
npm run build

step "Staging the extension"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin"
cp -R "$ROOT/extension/dist" "$STAGE/dist"
cp -R "$ROOT/extension/media" "$STAGE/media"
rm -f "$STAGE"/dist/*.map
cp "$ROOT/README.md" "$STAGE/README.md"
cp "$ROOT/voice/.build/release/VoiceHarnessVoice" "$STAGE/bin/"
for bundle in "$ROOT"/voice/.build/release/*.bundle; do
  [ -e "$bundle" ] && cp -R "$bundle" "$STAGE/bin/"
done
# The packaged manifest: the extension's own manifest, with the agent adapter (spawned at runtime,
# not bundled) as its only dependency, pinned to the version the core uses.
node - "$ROOT" "$STAGE" <<'EOF'
const fs = require("fs");
const path = require("path");
const [root, stage] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "package.json"), "utf8"));
const core = JSON.parse(fs.readFileSync(path.join(root, "core", "package.json"), "utf8"));
const adapter = "@agentclientprotocol/claude-agent-acp";
manifest.dependencies = { [adapter]: core.dependencies[adapter] };
delete manifest.devDependencies;
delete manifest.scripts;
delete manifest.private;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
EOF

step "Installing the agent adapter into the package"
# --omit=optional leaves out the SDK's bundled Claude CLI binary (~320 MB): the harness always
# runs the user's installed `claude` through CLAUDE_CODE_EXECUTABLE.
(cd "$STAGE" && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-package-lock)

step "Packaging"
VERSION="$(node -p "require('$STAGE/package.json').version")"
VSIX="$ROOT/build/voice-harness-$VERSION.vsix"
rm -f "$VSIX"
(cd "$STAGE" && "$ROOT/node_modules/.bin/vsce" package --skip-license --out "$VSIX")
echo "packaged: $VSIX"

if [ "$INSTALL" -eq 0 ]; then exit 0; fi

step "Installing into VS Code"
for existing in "$HOME"/.vscode/extensions/emmilco.voice-harness-*; do
  [ -L "$existing" ] || continue
  if [ "$REPLACE_LINK" -eq 1 ]; then
    echo "removing development install: $existing -> $(readlink "$existing")"
    rm "$existing"
  else
    echo "A development install (a link to a voice-harness checkout) is present:" >&2
    echo "  $existing -> $(readlink "$existing")" >&2
    echo "Re-run with --replace-link to replace it with the packaged extension." >&2
    exit 1
  fi
done
code --install-extension "$VSIX" --force
echo
echo "Installed voice-harness $VERSION. Run 'Developer: Reload Window' in open VS Code windows."
