// voice-harness voice process: system-voice speech out, SpeechAnalyzer speech in,
// Silero voice activity detection for interruptions. Commands arrive as JSON
// lines on stdin; events leave as JSON lines on stdout (see Protocol.swift).
//
//   VoiceHarnessVoice --models <dir> [--voice-processing] [--no-mic] [--interruptions]
//
// Speech uses the voice chosen in System Settings → Accessibility → Read & Speak.
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

let speech = SystemSpeech(sampleRate: AudioIO.speechRate)
// The first synthesis after launch is the slow one.
guard await !speech.render("Ready.").isEmpty else {
    Events.emit("fatal", ["message": "speech synthesis unavailable: /usr/bin/say produced no audio"])
    exit(1)
}
phase("speech voice")

var vad: VadManager?
if micAvailable {
    do {
        vad = try await VadManager(modelDirectory: modelsDirectory)
    } catch {
        Events.emit("error", ["message": "interruption detection unavailable: \(error.localizedDescription)"])
    }
    phase("voice activity model")
}

let speaker = Speaker(speech: speech, audio: audio)
let controller = Controller(audio: audio, speaker: speaker, vad: vad, locale: locale,
                            interruptions: wantInterruptions)
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
    "microphone": micAvailable,
    "interruptions": vad != nil && wantInterruptions,
    "speechDetection": vad != nil,
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
