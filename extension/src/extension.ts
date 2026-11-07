import * as vscode from "vscode";
import { HarnessPanel } from "./panel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Voice Harness");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("voiceHarness.openPanel", () => HarnessPanel.show(context, output)),
    vscode.commands.registerCommand("voiceHarness.restartSession", () => HarnessPanel.restart()),
  );
}

export function deactivate(): void {
  HarnessPanel.disposeCurrent();
}
