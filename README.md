# Voice Harness

Talk with Claude Code out loud inside VS Code. Claude answers in speech and text, highlights the code it is talking about as it talks, walks through code one small piece at a time, and shows charts and diagrams in the chat.

- **Voice in:** press Talk (`Ctrl+Shift+Space`), speak, press Send. Transcription runs on your Mac (Apple SpeechAnalyzer).
- **Voice out:** replies are spoken with Kokoro on the Neural Engine. Code, tables and status blocks are shown, not read aloud.
- **Code in step with speech:** `show_code` and `explain_code` highlight lines in your editor at the moment the matching words are spoken.
- **Figures:** Vega-Lite charts, Mermaid diagrams, SVG and image files render in the chat.
- **Your Claude Code setup:** the agent is your installed `claude` CLI (through the Agent Client Protocol adapter), with your settings, permissions and `CLAUDE.md` files. Permission requests appear as buttons.

## Requirements

- macOS 26 or later on Apple Silicon
- Xcode (Swift 6) and Node 22 or later, to build
- The Claude Code CLI (`claude`), signed in with a claude.ai account (Pro, Max, Team or Enterprise)
- The `code` command on your PATH (VS Code: *Shell Command: Install 'code' command in PATH*)

## Install and update

```sh
git clone https://github.com/emmilco/voice-harness.git
cd voice-harness
scripts/install-extension.sh
```

Then run **Developer: Reload Window** in open VS Code windows. Re-run the script at any time to rebuild and update.

The first time the panel opens, macOS asks for microphone access for VS Code, and the speech models (about 400 MB) download into `~/Library/Application Support/voice-harness/models`.

## Use

Open a folder, then run **Voice Harness: Open Panel** from the command palette. The agent works in that folder.

| Action | How |
|---|---|
| Reply hands-free | With 💬 Conversation on, the mic opens after Claude finishes speaking; pause to send |
| Talk | `Ctrl+Shift+Space` or 🎙 Talk; press again (■ Send) when done |
| Discard a recording | ✕ Discard |
| Stop Claude | Stop |
| Mute replies | 🔊 Voice on / 🔇 Voice off |

## Settings

| Setting | Default | |
|---|---|---|
| `voiceHarness.voice` | `af_heart` | Kokoro voice. Hear them all with `node tools/voice-sampler/server.mjs`, then open http://127.0.0.1:4317 |
| `voiceHarness.speakReplies` | `true` | Speak replies when the panel opens |
| `voiceHarness.conversationMode` | `true` | After a spoken reply, listen for your answer; a pause (about 1.7 s, longer mid-sentence) ends it |
| `voiceHarness.sendEditorContext` | `true` | Send the open file, cursor and selection with each message |
| `voiceHarness.autoInterrupt` | `false` | Pause speech automatically when you start talking over it |
| `voiceHarness.echoCancellation` | `false` | macOS echo cancellation, for use with speakers instead of headphones |
| `voiceHarness.modelsDirectory` | *(empty)* | Where speech models live; empty means `~/Library/Application Support/voice-harness/models` |
| `voiceHarness.nodePath`, `voiceHarness.claudePath` | *(empty)* | Paths to `node` and `claude`; empty means found through your login shell |

## Billing and data

- The harness refuses to start if Claude Code would bill per token instead of your claude.ai plan: an API key, `apiKeyHelper`, or an alternate provider in the environment or in Claude Code settings.
- Everything in the open folder that Claude reads goes to the Claude account the CLI is signed into, as with any Claude Code session. Use the account your organization sanctions for its code.
- Speech recognition and synthesis run locally; audio never leaves the Mac.

## Development

See `PROJECT_INDEX.md` for the layout. `npm run build`, `npm run unit`, `npm run smoke`; press F5 in VS Code to run the extension in a development host.
