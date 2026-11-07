// voice-harness voice process: Kokoro speech out, SpeechAnalyzer speech in,
// Silero voice activity detection for interruptions. Commands arrive as JSON
// lines on stdin; events leave as JSON lines on stdout (see Protocol.swift).
//
//   VoiceHarnessVoice --models <dir> [--voice af_heart] [--voice-processing] [--no-mic]
import AVFAudio
import AVFoundation
import FluidAudio
import Foundation
import Speech

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let modelsDirectory = URL(fileURLWithPath: argument("--models") ?? "/Users/Shared/ai/models/fluidaudio")
let voice = argument("--voice") ?? "af_heart"
let voiceProcessing = CommandLine.arguments.contains("--voice-processing")
let wantMic = !CommandLine.arguments.contains("--no-mic")

Events.emit("loading")
let startedAt = Date()

// Microphone permission is requested first so the prompt appears early.
var micAvailable = false
if wantMic {
    micAvailable = await AVCaptureDevice.requestAccess(for: .audio)
    if !micAvailable { Events.emit("micUnavailable", ["reason": "microphone access denied"]) }
}

let kokoro = KokoroAneManager(directory: modelsDirectory, version: .v3)
do {
    try await kokoro.initialize(preloadVoices: [voice])
    // First use of each length bucket is slow; pay it now rather than mid-conversation.
    for text in ["Ready.", "This warms up the medium length path for speech synthesis.",
                 "And this one is a longer sentence, so that the longer synthesis path is also loaded and compiled before we start talking."] {
        _ = try await kokoro.synthesizeDetailed(text: text, voice: voice)
    }
} catch {
    Events.emit("fatal", ["message": "speech synthesis unavailable: \(error.localizedDescription)"])
    exit(1)
}

var vad: VadManager?
if micAvailable {
    do {
        vad = try await VadManager(modelDirectory: modelsDirectory)
    } catch {
        Events.emit("error", ["message": "interruption detection unavailable: \(error.localizedDescription)"])
    }
}

guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
    Events.emit("fatal", ["message": "speech recognition does not support en-US on this system"])
    exit(1)
}
if micAvailable,
   let request = try? await AssetInventory.assetInstallationRequest(supporting: [SpeechTranscriber(locale: locale, preset: .transcription)]) {
    Events.log("installing speech recognition assets for \(locale.identifier)")
    try? await request.downloadAndInstall()
}

let audio: AudioIO
do {
    audio = try AudioIO(voiceProcessing: voiceProcessing)
    try audio.start(withMicrophone: micAvailable)
} catch {
    Events.emit("fatal", ["message": "audio engine failed to start: \(error.localizedDescription)"])
    exit(1)
}

let speaker = Speaker(kokoro: kokoro, voice: voice, audio: audio)
let controller = Controller(audio: audio, speaker: speaker, vad: vad, locale: locale)
audio.onDeviceChange = { result in
    switch result {
    case .success(let (input, output)):
        Task { await controller.deviceChanged(input: input, output: output) }
    case .failure(let error):
        Events.emit("error", ["message": "audio restart after device change failed: \(error.localizedDescription)"])
    }
}

let (micStream, micContinuation) = AsyncStream<AVAudioPCMBuffer>.makeStream(bufferingPolicy: .bufferingNewest(200))
audio.onMic = { micContinuation.yield($0) }
Task {
    for await buffer in micStream { await controller.onMic(buffer) }
}

let (commandStream, commandContinuation) = AsyncStream<String>.makeStream()
let stdinReader = Thread {
    while let line = readLine() { commandContinuation.yield(line) }
    commandContinuation.finish()
}
stdinReader.start()

Events.emit("ready", [
    "voice": voice,
    "microphone": micAvailable,
    "interruptions": vad != nil,
    "voiceProcessing": voiceProcessing,
    "inputDevice": audio.deviceNames.input,
    "outputDevice": audio.deviceNames.output,
    "startupMs": Int(Date().timeIntervalSince(startedAt) * 1000),
])

for await line in commandStream {
    guard let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(Command.self, from: data) else {
        Events.log("unreadable command: \(line)")
        continue
    }
    await controller.handle(command)
}
// stdin closed: the harness is gone.
exit(0)
