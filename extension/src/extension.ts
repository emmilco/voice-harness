import * as vscode from "vscode";
import { HarnessPanel } from "./panel";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Voice Harness");
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("voiceHarness.openPanel", () => HarnessPanel.show(context, output)),
    vscode.window.registerWebviewViewProvider(
      HarnessPanel.VIEW_ID,
      { resolveWebviewView: (view) => HarnessPanel.attachView(view, context, output) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("voiceHarness.restartSession", () => HarnessPanel.restart()),
    vscode.commands.registerCommand("voiceHarness.toggleListening", () => HarnessPanel.toggleListening()),
    vscode.commands.registerCommand("voiceHarness.restartVoice", () => HarnessPanel.restartVoice()),
    vscode.commands.registerCommand("voiceHarness.focusInput", () => HarnessPanel.focusInput(context, output)),
    vscode.commands.registerCommand("voiceHarness.stop", () => HarnessPanel.stop()),
    vscode.commands.registerCommand("voiceHarness.nextConversation", () => HarnessPanel.cycleTab(1)),
    vscode.commands.registerCommand("voiceHarness.previousConversation", () => HarnessPanel.cycleTab(-1)),
  );
}

export function deactivate(): void {
  HarnessPanel.disposeCurrent();
}
