import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Absolute path of a command-line tool: the configured path if set, otherwise
 * whatever a login shell finds. VS Code launched from the Dock does not inherit
 * the user's shell PATH (nvm, ~/.local/bin), so a plain lookup would miss them.
 */
export function resolveTool(name: string, configured: string | undefined): string | undefined {
  if (configured) return existsSync(configured) ? configured : undefined;
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const out = execFileSync(shell, ["-lc", `command -v ${name}`], { encoding: "utf8", timeout: 10_000 });
    const found = out.trim().split("\n").pop();
    return found && existsSync(found) ? found : undefined;
  } catch {
    return undefined;
  }
}
