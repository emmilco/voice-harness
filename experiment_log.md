
## Attempt 1 — 2026-11-06 23:58:00
Hypothesis: SpeechAnalyzer transcribes Elliot's live mic speech as accurately as it did synthetic files.
Tried: `VoiceCheck listen 10` (AVAudioEngine input tap → .caf in the input node's native format, then SpeechAnalyzer whole-file transcription), run by Elliot via `!` in Claude Code.
Outcome: 10.60 s recorded, transcription took 139 ms, transcript empty ("").
Learning: pending — candidates are H1 silent capture (TCC/device) vs H2 format the analyzer does not read (32-bit float .caf vs earlier 16-bit .wav).

## Attempt 2 — 2026-11-07 00:05:00
Hypothesis: Attempt 1's empty transcript came from the recording, not the transcriber (H1), rather than from the 32-bit float .caf format (H2).
Tried: (a) per-0.5 s RMS envelope of attempt 1's recording; (b) re-transcribing it converted to 16-bit 16 kHz WAV; (c) Elliot re-ran `VoiceCheck listen 10` unchanged.
Outcome: (a) flat -43 to -47 dBFS for all 10.6 s, no speech bursts; (b) still empty; (c) correct transcript of Elliot's live speech ("Let's try this again. I'm talking, I'm talking, I'm making conversation because I just want to make sure that I'm.") — 10.2 s in 194 ms, cut off only by the 10 s limit.
Learning: H2 ruled out (same .caf path works; WAV conversion did not help). Attempt 1 captured no speech; why is unknown (candidates: Elliot not speaking yet, macOS mic-permission grant during the first run). Live-mic transcription works (n=1 success).

## Attempt 3 — 2026-11-07 00:52:00
Hypothesis: Speech starts within ~0.3 s of the first sentence being queued (M0b warm synthesis 38-108 ms).
Tried: `node core/scripts/.smoke.mjs --speak` — real Claude turn → SpeechChunker → VoiceHarnessVoice.
Outcome: six sentences queued at 23.2 s; first finished playing at 30.4 s; inferred playback start ≈ 26.9 s, i.e. ~3.7 s after queuing. Later sentences played back to back.
Learning: pending. Candidate H-G2P: first synthesis containing out-of-lexicon words ("tiny_gpt.py", "fn") loads the BART G2P fallback model cold; warm-up sentences were all in-lexicon. Falsified if an all-lexicon sentence is equally slow.

## Attempt 4 — 2026-11-07 00:58:00
Hypothesis: H-G2P (out-of-lexicon words make the first synthesis slow).
Tried: new `synthesized` event (synthesis ms, audio ms); voice process fed the out-of-lexicon sentence twice, then an all-lexicon sentence.
Outcome: 640 ms (OOV, first), 447 ms (same, second), 411 ms (all-lexicon); that sentence is 6025 ms of audio.
Learning: H-G2P mostly falsified (≤ ~200 ms first-use cost). Attempt 3's "3.7 s" was an analysis error: I assumed sentence #1 was ~3.5 s of audio; it is 6.0 s, so playback actually began ≈ 24.4 s, ~1.2 s after queuing (~0.64 s synthesis + scheduling). Real first-sentence latency ≈ 1.2 s on a long first sentence; acceptable for the MVP, improvable by speaking a shorter first chunk.

## Attempt 5 — 2026-11-07 01:10:00
Hypothesis: After making buffer forwarding order-safe, listenStart → listenStop still yields an (empty) transcript.
Tried: voice process with listenStart at 6 s, listenStop at 9 s, shutdown at 12 s (startup took 18 s, so all three ran back to back after ready).
Outcome: `listening` emitted; no `transcript`; shutdown ignored; process hung (killed).
Learning: candidate H-race: finish() ran before the detached start() had started the analyzer; finish() cancelled it, start() then started a cancelled analyzer, the results stream never ended, and the Controller actor blocked forever awaiting it. Not the lock change (the passing Attempt-2-era test had seconds between start and stop). Falsified if the hang persists once finish() awaits start().

## Attempt 6 — 2026-11-07 01:18:00
Hypothesis: H-race (Attempt 5): making finish() await start() fixes the hang.
Tried: finish()/cancel() await the start task; 5 s timeout on results. Tested rapid (start+stop back to back) and spaced (3 s) listen cycles under a 60 s alarm.
Outcome: both hung (killed by alarm, exit 142) after `listening`.
Learning: H-race insufficient — spaced also hangs once finish() waits on start(). New candidate H-start-blocks: `SpeechAnalyzer.start(inputSequence:)` does not return until the input sequence ends. Implies the original code never set `started` during a turn, so no live audio ever reached the analyzer (Attempt-2-era silent test passed vacuously), and awaiting start() before ending input deadlocks. Falsified if the inputSequence initializer (no start() call) still hangs or still yields nothing for speech.

## Attempt 7 — 2026-11-07 01:26:00
Hypothesis: H-start-blocks (Attempt 6): constructing the analyzer with inputSequence (no start() call) delivers live audio and removes the hang.
Tried: rebuilt; rapid listen cycle, "spaced" cycle (its commands also queued before ready, so effectively rapid), and a positive control (listenStart after ready, `say` clip played through speakers, listenStop ~6 s later).
Outcome: positive control returned a transcript of live room speech (unrelated room speech, not recorded) — not the clip (likely headphones). Rapid and spaced still hung (alarm, exit 142).
Learning: H-start-blocks supported: live audio now reaches the analyzer (first live-path transcript). Remaining hang only when listenStop follows listenStart with ~no audio fed. Candidate H-empty-finalize: finalizeAndFinishThroughEndOfInput() never returns when the analyzer received no input. Falsified if skipping finalize in that case still hangs.

## Attempt 8 — 2026-11-07 01:31:00
Hypothesis: H-empty-finalize — skip finalize (cancel instead) when no audio reached the analyzer; bound finalize with a 5 s timeout.
Tried: rebuilt; rapid listen cycle; then after ready: 3 s listen, an immediate start/stop, shutdown.
Outcome: all cycles emitted `transcript` (empty — quiet room) and the process exited 0; no hang.
Learning: H-empty-finalize supported. Live transcription path now: analyzer constructed with its input stream; finish skips finalize without audio; finalize and results each time-bounded. Closed.

## Attempt 9 — 2026-11-07 09:40:00
Hypothesis: H-device-switch — AirPods connected after "Voice ready" changed the default input/output; AVAudioEngine stops on a configuration change and nothing restarts it, so mic input (and speech) go dead.
Tried: (observation only) Elliot connected AirPods after the panel was ready; pressing Ctrl+Shift+Space produced nothing. system_profiler: AirPods are default input and output at 24 kHz (Bluetooth headset mode).
Outcome: input dead with AirPods.
Learning: consistent with H-device-switch (AirPods arrived after start). Fix: observe AVAudioEngineConfigurationChange, rebuild tap/converter, restart engine and players, reset speaker state; add a mic level meter so input presence is visible. Falsified if input stays dead after recovery, or with AirPods connected before the panel opens (would implicate the 24 kHz headset format instead).

## Attempt 10 — 2026-11-07 09:58:00
Hypothesis: with device-change recovery and level events, mic input works with AirPods (and levels show it).
Tried: voice process started with AirPods already default input+output; listenStart, 2 s, listenStop.
Outcome: ready reports AirPods as input/output (startup 28 s); `listening`, then empty transcript; NO `level` events at all.
Learning: H-device-switch is not the whole story — with AirPods present before start, no mic audio reaches the controller (the stated falsifier). Not yet ruled out: level reporting itself broken (no MacBook-mic control run). Next: instrument the tap (callback count, buffer format, format-guard drops, conversion errors) to locate where audio stops.

## Attempt 11 — 2026-11-07 10:05:00
Hypothesis: instrumentation will show where AirPods audio stops.
Tried: tap counters (callbacks, delivered, format mismatches, conversion errors, buffer format); AirPods default at start; listenStart ~6.5 s after ready; 2 s listen.
Outcome: 17 callbacks, 17 delivered, 0 mismatches, 0 conversion errors; format 24 kHz mono Float32 (AirPods headset mode); levels ≈ -60 dBFS (quiet room).
Learning: AirPods input works once the engine has run a few seconds. Attempt 10's silence most plausibly timing: listen ran immediately after ready (startup 28 s, commands queued) while Bluetooth was switching to headset mode — itself an engine configuration change, which before the recovery fix would have stopped the engine for good. Supports H-device-switch for Elliot's VS Code case; confirmation pending his retest with the recovery build. Instrumentation kept (micStats per turn).

## Attempt 12 — 2026-11-07 10:20:00
Hypothesis: with device-change recovery, AirPods input works in VS Code both when connected before the panel opens and when swapped mid-session.
Tried: Elliot retested in the Extension Development Host: (1) AirPods in before opening the panel, talk after ready; (2) AirPods removed and reinserted during the session, then talk.
Outcome: both worked (Elliot's report).
Learning: H-device-switch confirmed for the reported failure: AVAudioEngine stops on device/route changes (including AirPods entering headset mode) and must be restarted with a rebuilt tap. Closed.

## Attempt 13 — 2026-11-07 13:05:00
Hypothesis: with highlights timed to speech by markers and a speech-layer instruction to walk in small steps, a spoken walkthrough moves the highlight in step with the explanation.
Tried: `smoke --speak "Walk me through TinyGPT's forward method in tiny_gpt.py."` (markers applied as in the panel), then the same prompt without speech to read Claude's full text.
Outcome: first step correct (highlight 14-15, then four sentences about it). Then three show_code calls (16, 17-18, 19) back to back with no text between; all three markers fired together when the first step's speech ended; the explanation of lines 16-18 was never written (the reply only summarizes them).
Learning: marker timing works; the failure is model behaviour — consecutive (possibly parallel) highlight calls with no speech between. Candidate H-prompt: the instruction was too soft (no rule against consecutive/parallel show_code). Falsified if an explicit rule still yields batched calls. Fallback design if so: a single `walkthrough(steps: [{path, lines, say}])` tool that pairs each highlight with its words structurally.

## Attempt 14 — 2026-11-07 13:20:00
Hypothesis: H-prompt — an explicit numbered rule (highlight, then sentences, then next; never consecutive or parallel show_code) makes Claude interleave words and highlights.
Tried: rewrote the speech-layer walkthrough instruction; ran the walkthrough prompt twice (no speech) and inspected the full text.
Outcome: both runs: 5 show_code calls but only 3 text segments (intro, first line, "Finally…" about the last line); the middle steps got highlights with no words, summarized only at the end.
Learning: H-prompt falsified (2/2). Instruction wording does not overcome the model's habit of issuing several highlight calls before writing. Convergence check: ruled out marker timing (works) and prompt wording; remaining approach is structural — make each highlight carry its own words, e.g. a tool explain_code(path, start, end, say) that highlights and speaks together.

## Attempt 15 — 2026-11-07 13:50:00
Hypothesis: a structural tool, explain_code(path, start, end, say, step), pairs every highlight with its words regardless of how the model batches calls.
Tried: added explain_code (MCP tool, StepSequencer ordering, panel step bubble, marker-timed highlight then spoken words); two text-only walkthrough runs; one spoken run logging marker and playback times.
Outcome: both text runs: 5 numbered explain_code steps (lines 14-15, 16, 17, 18, 19), each with its own sentences. Calls were issued in parallel, so all five executed together once generation finished (~12-15 s). Spoken run: each highlight applied exactly when the previous step's last sentence finished (26.9 s, 42.4 s, 52.5 s, 65.5 s), immediately before that step's words.
Learning: attention now moves with the explanation. Remaining cost: a walkthrough's first step waits for the whole batch to be generated (a lead-in sentence, then ~4 s of silence here). Possible later improvement: present steps from the streamed tool-call announcement instead of waiting for execution. Closed.

## Attempt 16 — 2026-11-08 01:40:00
Hypothesis: ACP tool-call announcements carry explain_code inputs, so a walkthrough step can be presented when announced instead of when the batch executes.
Tried: passed rawInput through ToolCallInfo; logged announcements and updates for explain_code in a walkthrough run.
Outcome: four announcements at 8.5, 9.9, 11.6, 13.2 s, each with rawInput {}; no update carried input before all four executed together at 14.7 s.
Learning: premise false — the adapter does not stream tool inputs; presenting from announcements is impossible. The 1.5 s spacing shows the calls are generated sequentially within one message and run only when the message completes. Next candidate H-serial: instructing one explain_code call per message (wait for each result) makes each step execute as soon as it is written. Falsified if steps still execute together.

## Attempt 17 — 2026-11-08 01:55:00
Hypothesis: H-serial — one explain_code call per message makes each step execute as soon as it is written.
Tried: speech-layer instruction to make walkthrough calls one at a time; two walkthrough runs logging announcement and execution times.
Outcome: both runs: each step executed ~1.2-1.5 s after its announcement (steps at 9.7, 12.0, 14.2, 17.2, 19.6 s; and 9.8, 12.4, 14.7, 17.0, 19.2 s). First step 9.7-9.8 s vs 14.7-15.1 s when batched.
Learning: H-serial supported (2/2): walkthroughs start ~5 s sooner; later steps arrive every ~2.3 s, faster than each step's speech, so playback is continuous. Closed.

## Attempt 18 — 2026-11-08 03:30:00
Hypothesis: asking Claude to use TaskCreate/TaskUpdate produces ACP plan updates (the adapter maps TaskCreate/TaskUpdate/TaskList and TodoWrite to `plan`, acp-agent.js:2623, 10767-10772).
Tried: smoke prompt asking for TaskCreate with three tasks then TaskUpdate; logged plan updates, tool calls and the reply.
Outcome: no plan update. Claude ran ToolSearch ("No matching deferred tools found") and replied that the session has no TaskCreate or TaskUpdate tool.
Learning: the task tools are not available in harness sessions (this Claude Code build/config, via the Agent SDK). Next candidate H-todowrite: the older TodoWrite tool is available. Falsified if it is missing too.

## Attempt 19 — 2026-11-08 03:35:00
Hypothesis: H-todowrite — the older TodoWrite tool is available and produces plan updates.
Tried: smoke prompt asking for TodoWrite with three items, the first completed.
Outcome: ToolSearch "No matching deferred tools found"; Claude wrote the list as text ("Proposed todos (not created)"); no plan update.
Learning: H-todowrite falsified. Neither task-list tool exists in harness sessions. Convergence check: look for what disables them (user settings, adapter options) before deciding.

## Attempt 20 — 2026-11-08 03:40:00 (convergence check)
Hypothesis: something in user settings or the adapter disables the task-list tools.
Tried: read ~/.claude/settings.json deny rules, env and keys; searched the adapter for disallowedTools and TodoWrite.
Outcome: no task-related deny rule or env var; the adapter only disallows AskUserQuestion (because the client does not declare elicitation support) and renders TodoWrite/Task* as plans.
Learning: ruled out our wiring, user settings and the adapter. Remaining (inferred): this Claude Code build does not offer TodoWrite/Task* in Agent SDK sessions. Paused; options put to Elliot: a harness update_checklist tool plus the plan UI (recommended), plan UI only, or drop. Side finding: AskUserQuestion is unavailable in harness sessions until the client supports elicitation.

## Attempt 21 — 2026-11-10 19:05:00
Hypothesis: answers look loosely letter-spaced because the panel forced -webkit-font-smoothing: antialiased (thinner strokes) and a fractional size (1.07em); VS Code's own UI uses system rendering.
Tried: removed the smoothing override; answer size set to the interface size + 1px (whole pixel); font unchanged (ui-serif / New York, Iowan Old Style fallback).
Outcome: Elliot reports the spacing is still not right.
Learning: rendering hypothesis not supported (n=1 visual judgement). Remaining candidate: the serif faces themselves at ~14px (Charter, then New York/Iowan; New York's small optical size is deliberately looser). Next: Georgia first, as Elliot asked.

## Attempt 22 — 2026-11-10 19:20:00
Hypothesis: a different serif face (Georgia) would fix the loose look of the answer text.
Tried: Georgia first, Iowan Old Style fallback; rendering and size unchanged from attempt 21.
Outcome: Elliot: "still doesn't feel right" and doubts serif is right at all.
Learning: four serifs (Charter, New York, Iowan, Georgia) plus the rendering fix all failed the same way. Serif at ~14 px in a narrow panel is the problem, not any one face. Closed: default back to the interface sans (the layout changes stay); serif remains available via voiceHarness.readingFont for a later look at larger sizes.

## Attempt 23 — 2026-11-10 20:10:00
Hypothesis: the harness look was rendering in Inter, the face named in look-harness.css.
Tried: a font comparison page (Inter, IBM Plex Sans, Seravek at 15 and 16 px) rendered in headless Chrome.
Outcome: the "Inter" samples rendered in Chrome's default serif: the one Inter file on this Mac does not resolve by that family name, so the fallback chain fell through to serif. IBM Plex Sans (full family installed) and Seravek rendered as named.
Learning: the panel's prose has been in a fallback serif through attempts 21-22 and the harness look; "the letterspacing looks good now" was about that serif rendered with system smoothing, not Inter. Corrective: Plex Sans at 16 px (Butterick's range; 15 looked like UI text next to it), Seravek then system fallbacks. Closed. Lesson: a font stack is a hypothesis until a render confirms the family actually loaded.

## Attempt 24 — 2026-11-10 21:00:00
Hypothesis: "drab" was a palette problem; two stronger palettes (teal lamplight, navy/amber ink) would fix it.
Tried: both rendered from the mock; shown to Elliot.
Outcome: "neither!" Elliot's references, asked for afterwards: FT, claude.ai, Bluesky, Claude Code in iTerm, Tschichold/Garamond. Dark theme wanted.
Learning: the references share restraint and typographic character, not colour; both palettes cured the wrong thing. Earlier serif failures (attempts 21-22) were size and rendering (14 px, forced-thin), not serifs as such: four book faces at 17 px with system rendering all read well (out/serifs.png). The harness look is now a dark page: Hoefler Text 17 px (Athelas fallback), Plex Sans chrome, one terracotta accent for the voice, rules instead of glows. Rendered and reviewed before showing. Pending Elliot's verdict.

## Attempt 25 — 2026-11-10 21:40:00
Hypothesis: "too heavy" (Hoefler on the dark page) is the face's stroke weight; dimmer text, more leading, or a lighter face would fix it.
Tried: six variants rendered side by side (out/weight.png); Athelas with dimmer text and 155% leading shown to Elliot in dark and light.
Outcome: Elliot: light page is better, and Hoefler was better than Athelas.
Learning: the heaviness was dark-mode bloom (light strokes bleeding on ink), not the face. On a cream page Hoefler keeps its substance without turning heavy. The harness look now defaults to a light page whatever the editor theme (voiceHarness.page: light | dark | editor), Hoefler Text 17 px, 150% leading. Closed; rendered and reviewed.
