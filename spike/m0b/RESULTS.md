# M0b — voice check results

Machine: M5 Pro, macOS 27.2 (26B123), Xcode 27.2, Swift 6.4.2. FluidAudio 0.18.2 (exact pin, `TTS` trait). Run on 2026-11-06.

Run: `swift build -c release && .build/release/VoiceCheck tts` then `.build/release/VoiceCheck stt <wav...>`.

## TTS — Kokoro ANE-v3 via FluidAudio, voice `af_heart`

On macOS 27 FluidAudio defaults Kokoro v3 to the `.aneTailCpu` route (Neural Engine + CPU, no Metal), per its docs.

| Sentence | Audio | Cold | Warm |
|---|---|---|---|
| short | 2.17 s | 2691 ms | 38 ms |
| medium | 6.30 s | 2517 ms | 302 ms |
| long | 13.43 s | 671 ms | 659 ms |
| question | 4.50 s | 275 ms | 108 ms |

First `initialize()` (download + on-device compile into the store): 28.9 s, once. Cold cost is per-size first use; the harness should warm up at launch.

Hardware placement is FluidAudio's documented routing, not measured here.

## STT — Apple SpeechAnalyzer (`SpeechTranscriber`, preset `.transcription`, en_US)

OS speech assets were already installed. Whole-file analysis (not live streaming):

| Input | Audio | Time | Transcript |
|---|---|---|---|
| Kokoro question | 4.50 s | 181 ms | exact |
| Kokoro long | 13.43 s | 176 ms | exact apart from punctuation |
| macOS `say` (Samantha) | 4.98 s | 94 ms | exact apart from punctuation |

### Live microphone (`VoiceCheck listen 10`, run by Elliot)

- Run 1: empty transcript. The recording held no speech (flat −43 to −47 dBFS envelope): Elliot didn't know recording had started, because `!` output only appears after the command ends. Not a transcriber or format fault (16-bit WAV conversion also empty; see `experiment_log.md`).
- Run 2: Elliot's live speech transcribed correctly — 10.2 s in 194 ms ("Let's try this again. I'm talking, I'm talking, I'm making conversation because I just want to make sure that I'm." — cut only by the 10 s limit).
- Lesson for M3: listening needs an audible start cue and a visible indicator.

Not yet tested: pauses and fillers, room noise, streaming (incremental) transcription.

## Voice choice

Seven alternatives rendered (`VoiceCheck voices …`): af_bella, af_sarah, am_michael, am_eric, bf_emma, bm_george, bm_fable. Elliot chose **`af_heart`**.

## Verdict

**M0b passed** (Elliot, 2026-11-06): no crashes on macOS 27.2, latency acceptable. The Neural Engine route stands; the CPU/Python fallback is not needed.

## Model weights (MLP)

FluidAudio downloaded into the declared manifest store `fluidaudio` (`/Users/Shared/ai/models/fluidaudio`, 388 MB): entries `FluidInference/kokoro-82m-coreml` and `fluidaudio/kokoro-g2p`, tier `test`, consumer `voice-harness`, under a user-approved §2.1 exception. `hub-audit`: both KEEP. Apple's speech assets are OS-managed and out of MLP scope (user decision).

## Supply chain

FluidAudio pulls a prebuilt binary, `NemoTextProcessing.xcframework` (87 MB, from FluidInference's GitHub releases), checksum-pinned by SwiftPM.
