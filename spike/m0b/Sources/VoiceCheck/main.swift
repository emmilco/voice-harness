// M0b voice check: Kokoro TTS via FluidAudio (Neural Engine) and Apple
// SpeechAnalyzer STT, timed on this machine.
//
//   VoiceCheck tts            synthesize test sentences, report timings, write WAVs
//   VoiceCheck stt <wav...>   transcribe WAV files, report timings
import AVFAudio
import FluidAudio
import Foundation
import Speech

let modelsRoot = URL(fileURLWithPath: "/Users/Shared/ai/models/fluidaudio")
let outDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

func ms(_ start: ContinuousClock.Instant) -> String {
    let d = ContinuousClock.now - start
    let total = Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
    return String(format: "%.0f ms", total)
}

func wavSeconds(_ data: Data) -> Double {
    Double(max(data.count - 44, 0)) / 2.0 / 24_000.0
}

func runTTS() async throws {
    let sentences = [
        ("short", "Let's look at the loss function."),
        ("medium", "The logits come out shaped batch by time by vocabulary, so we flatten them before cross entropy."),
        ("long", "Each position in each sequence becomes its own little classification problem: given everything before it, which token comes next? Flattening just lets one call to cross entropy average over all of them at once."),
        ("question", "Why do we divide the attention scores by the square root of the head dimension?"),
    ]
    print("[tts] macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
    let manager = KokoroAneManager(directory: modelsRoot, version: .v3)
    let tInit = ContinuousClock.now
    try await manager.initialize()
    print("[tts] initialize (download/compile on first run): \(ms(tInit))")

    for pass in ["cold", "warm"] {
        for (name, text) in sentences {
            let t = ContinuousClock.now
            let wav = try await manager.synthesize(text: text, voice: "af_heart")
            let elapsed = ms(t)
            print(String(format: "[tts] %@ %-8@ %5.2f s audio in %@", pass, name, wavSeconds(wav), elapsed))
            if pass == "warm" {
                try wav.write(to: outDir.appendingPathComponent("tts_\(name).wav"))
            }
        }
    }
    print("[tts] wrote tts_*.wav to \(outDir.path)")
}

func transcribe(_ path: String, locale: Locale) async throws {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let seconds = Double(file.length) / file.processingFormat.sampleRate
    let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
    let t = ContinuousClock.now
    async let collected: String = transcriber.results.reduce(into: "") { acc, r in
        if r.isFinal { acc += String(r.text.characters) }
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if let last = try await analyzer.analyzeSequence(from: file) {
        try await analyzer.finalizeAndFinish(through: last)
    } else {
        await analyzer.cancelAndFinishNow()
    }
    let text = try await collected
    print(String(format: "[stt] %@: %.2f s audio in %@", (path as NSString).lastPathComponent, seconds, ms(t)))
    print("[stt]   \"\(text.trimmingCharacters(in: .whitespaces))\"")
}

func runSTT(_ paths: [String]) async throws {
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
        print("[stt] en-US not supported")
        return
    }
    let probe = SpeechTranscriber(locale: locale, preset: .transcription)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        let t = ContinuousClock.now
        print("[stt] installing OS speech assets for \(locale.identifier)…")
        try await request.downloadAndInstall()
        print("[stt] assets installed in \(ms(t))")
    } else {
        print("[stt] OS speech assets for \(locale.identifier) already installed")
    }
    for path in paths {
        try await transcribe(path, locale: locale)
    }
}

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "tts":
    try await runTTS()
case "stt":
    try await runSTT(Array(args.dropFirst()))
default:
    print("usage: VoiceCheck tts | VoiceCheck stt <wav...>")
}
