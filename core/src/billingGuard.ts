import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Environment variables that would route Claude Code away from the claude.ai subscription. */
const BILLING_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

export interface BillingCheck {
  ok: boolean;
  problems: string[];
  /** One line describing the login that will be used, when it could be read. */
  summary: string;
}

/**
 * Refuses any configuration that would bill per token instead of the claude.ai
 * subscription: an API key or alternate provider in the environment or in a
 * settings file's `env`, an `apiKeyHelper`, or a CLI login other than claude.ai.
 */
export function checkBilling(claudePath: string, workspace: string, env: NodeJS.ProcessEnv = process.env): BillingCheck {
  const problems: string[] = [];

  for (const name of BILLING_ENV_VARS) {
    if (env[name]) problems.push(`${name} is set in the environment`);
  }

  const settingsFiles = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".claude", "settings.local.json"),
    path.join(workspace, ".claude", "settings.json"),
    path.join(workspace, ".claude", "settings.local.json"),
  ];
  for (const file of settingsFiles) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    let parsed: { apiKeyHelper?: unknown; env?: Record<string, unknown> } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (text.includes("apiKeyHelper")) problems.push(`${file} mentions apiKeyHelper (file is not valid JSON)`);
      continue;
    }
    if (parsed?.apiKeyHelper) problems.push(`apiKeyHelper is configured in ${file}`);
    for (const name of BILLING_ENV_VARS) {
      if (parsed?.env?.[name]) problems.push(`${name} is set in the env block of ${file}`);
    }
  }

  let summary = "login unknown";
  try {
    const status = JSON.parse(execFileSync(claudePath, ["auth", "status", "--json"], { encoding: "utf8", timeout: 15_000 }));
    summary = `authMethod=${status.authMethod}, plan=${status.subscriptionType ?? "?"}`;
    if (status.authMethod !== "claude.ai") problems.push(`Claude CLI login is ${status.authMethod}, not claude.ai`);
  } catch (err) {
    problems.push(`could not read Claude CLI login status: ${(err as Error).message}`);
  }

  return { ok: problems.length === 0, problems, summary };
}
