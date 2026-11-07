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

Not yet tested: a real human voice through the microphone, live streaming input, room noise.

## Model weights (MLP)

FluidAudio downloaded into the declared manifest store `fluidaudio` (`/Users/Shared/ai/models/fluidaudio`, 388 MB): entries `FluidInference/kokoro-82m-coreml` and `fluidaudio/kokoro-g2p`, tier `test`, consumer `voice-harness`, under a user-approved §2.1 exception. `hub-audit`: both KEEP. Apple's speech assets are OS-managed and out of MLP scope (user decision).

## Supply chain

FluidAudio pulls a prebuilt binary, `NemoTextProcessing.xcframework` (87 MB, from FluidInference's GitHub releases), checksum-pinned by SwiftPM.
