// voice-harness voice process: Kokoro speech out, SpeechAnalyzer speech in,
// Silero voice activity detection for interruptions. Commands arrive as JSON
// lines on stdin; events leave as JSON lines on stdout (see Protocol.swift).
//
//   VoiceHarnessVoice --models <dir> [--voice af_heart] [--voice-processing] [--no-mic] [--interruptions]
//
// --interruptions: while speech plays, detect the user starting to talk and pause (barge-in).
// Without it, speech stops only on an explicit listenStart or stopSpeaking.
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

let modelsDirectory = URL(fileURLWithPath: argument("--models")
    ?? (NSHomeDirectory() + "/Library/Application Support/voice-harness/models"))
let voice = argument("--voice") ?? "af_heart"
let voiceProcessing = CommandLine.arguments.contains("--voice-processing")
let wantMic = !CommandLine.arguments.contains("--no-mic")
let wantInterruptions = CommandLine.arguments.contains("--interruptions")

Events.emit("loading")
let startedAt = Date()
var phaseStart = Date()
/// Logs how long the startup phase that just ended took.
func phase(_ name: String) {
    Events.log("startup: \(name) \(Int(Date().timeIntervalSince(phaseStart) * 1000)) ms")
    phaseStart = Date()
}

// Microphone permission is requested first so the prompt appears early.
var micAvailable = false
if wantMic {
    micAvailable = await AVCaptureDevice.requestAccess(for: .audio)
    if !micAvailable { Events.emit("micUnavailable", ["reason": "microphone access denied"]) }
}
phase("microphone permission")

guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US")) else {
    Events.emit("fatal", ["message": "speech recognition does not support en-US on this system"])
    exit(1)
}
if micAvailable,
   let request = try? await AssetInventory.assetInstallationRequest(supporting: [SpeechTranscriber(locale: locale, preset: .transcription)]) {
    Events.log("installing speech recognition assets for \(locale.identifier)")
    try? await request.downloadAndInstall()
}
phase("speech recognition assets")

let audio: AudioIO
do {
    audio = try AudioIO(voiceProcessing: voiceProcessing)
    try audio.start(withMicrophone: micAvailable)
} catch {
    Events.emit("fatal", ["message": "audio engine failed to start: \(error.localizedDescription)"])
    exit(1)
}
phase("audio engine start")

let kokoro = KokoroAneManager(directory: modelsDirectory, version: .v3)
do {
    try await kokoro.initialize(preloadVoices: [voice])
} catch {
    Events.emit("fatal", ["message": "speech synthesis unavailable: \(error.localizedDescription)"])
    exit(1)
}
phase("kokoro initialize")

var vad: VadManager?
if micAvailable && wantInterruptions {
    do {
        vad = try await VadManager(modelDirectory: modelsDirectory)
    } catch {
        Events.emit("error", ["message": "interruption detection unavailable: \(error.localizedDescription)"])
    }
    phase("voice activity model")
}

let speaker = Speaker(kokoro: kokoro, voice: voice, audio: audio)
let controller = Controller(audio: audio, speaker: speaker, vad: vad, locale: locale, defaultVoice: voice)
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

// The first synthesis of each length is slow. Warm up after `ready`, silently: Kokoro is an
// actor, so a real sentence arriving meanwhile waits for at most one warm-up step.
Task {
    phaseStart = Date()
    for text in ["Ready.", "This warms up the medium length path for speech synthesis.",
                 "And this one is a longer sentence, so that the longer synthesis path is also loaded and compiled before we start talking."] {
        _ = try? await kokoro.synthesizeDetailed(text: text, voice: voice)
    }
    phase("background warm-up")
}

for await line in commandStream {
    guard let data = line.data(using: .utf8), let command = try? JSONDecoder().decode(Command.self, from: data) else {
        Events.log("unreadable command: \(line)")
        continue
    }
    await controller.handle(command)
}
// stdin closed: the harness is gone.
exit(0)
