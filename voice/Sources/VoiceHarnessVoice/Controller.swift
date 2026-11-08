import AVFAudio
import FluidAudio
import Foundation

/// The listen / speak / interrupt state machine.
///
/// - User turn (`listenStart` … `listenStop`): microphone audio goes to a live
///   transcription; `partial` events carry the running text, `transcript` the result.
///   Voice activity detection reports `speechStart` / `speechEnd` during the turn, so the
///   harness can end it on a pause.
/// - While speech plays and no user turn is open, voice activity detection watches
///   the microphone. On detected speech, playback pauses at once (`bargeIn`) and the
///   interruption is transcribed until the speaker falls silent (`interruption`).
///   The harness then decides: `resumeSpeaking` or `stopSpeaking`.
actor Controller {
    private enum Mode { case idle, listening, interrupting }

    private static let prerollSeconds = 0.8
    private static let maxInterruptionSeconds = 20.0

    private let audio: AudioIO
    private let speaker: Speaker
    private let vad: VadManager?
    private let locale: Locale
    private let defaultVoice: String
    private let interruptions: Bool
    private var segmentation: VadSegmentationConfig

    private var mode = Mode.idle
    private var transcription: LiveTranscription?
    private var vadState = VadStreamState.initial()
    private var vadSamples: [Float] = []
    private var vadRunning = false
    private var preroll: [AVAudioPCMBuffer] = []
    private var prerollFrames = 0
    private var interruptionStarted = Date.distantPast
    private var lastMicAt = Date.distantPast
    private var levelPeak: Float = 0
    private var lastLevelEmit = Date.distantPast

    init(audio: AudioIO, speaker: Speaker, vad: VadManager?, locale: Locale, defaultVoice: String, interruptions: Bool) {
        self.defaultVoice = defaultVoice
        self.interruptions = interruptions
        self.audio = audio
        self.speaker = speaker
        self.vad = vad
        self.locale = locale
        var config = VadSegmentationConfig.default
        config.minSilenceDuration = 0.7
        segmentation = config
    }

    // MARK: Commands

    func handle(_ command: Command) async {
        switch command.cmd {
        case "speak":
            if let id = command.id, let text = command.text { await speaker.enqueue(id: id, text: text) }
        case "mark":
            if let id = command.id { await speaker.enqueueMark(id: id) }
        case "render":
            guard let id = command.id, let text = command.text, let path = command.path else { return }
            let voice = command.voice ?? defaultVoice
            let speaker = self.speaker
            Task {
                do {
                    let (samples, ms) = try await speaker.render(text: text, voice: voice)
                    try WavFile.write(samples: samples, sampleRate: Int(AudioIO.speechRate), to: URL(fileURLWithPath: path))
                    Events.emit("rendered", ["id": id, "path": path, "voice": voice, "ms": ms,
                                             "audioMs": Int(Double(samples.count) / AudioIO.speechRate * 1000)])
                } catch {
                    Events.emit("error", ["id": id, "message": "render failed for \(voice): \(error.localizedDescription)"])
                }
            }
        case "listVoices":
            Events.emit("voices", ["voices": KokoroAneVariant.english.knownVoices])
        case "stopSpeaking":
            if mode == .interrupting { await dropTranscription() }
            await speaker.stop()
        case "pauseSpeaking":
            await speaker.pause()
        case "resumeSpeaking":
            await speaker.resume()
        case "listenStart":
            await startListening()
        case "listenStop":
            await stopListening()
        case "listenCancel":
            if mode == .listening { await dropTranscription() }
            Events.emit("listenCancelled")
        case "shutdown":
            exit(0)
        default:
            Events.log("unknown command \(command.cmd)")
        }
    }

    private func startListening() async {
        if mode != .idle { await dropTranscription() }
        await speaker.stop()
        // After a device change (e.g. AirPods entering headset mode) the microphone can take a
        // few seconds to deliver audio; don't signal "listening" until it does.
        if Date().timeIntervalSince(lastMicAt) > 0.3 {
            Events.emit("micWarming")
            let deadline = Date().addingTimeInterval(3)
            while Date().timeIntervalSince(lastMicAt) > 0.3 && Date() < deadline {
                try? await Task.sleep(for: .milliseconds(50))
            }
            if Date().timeIntervalSince(lastMicAt) > 0.3 {
                Events.emit("error", ["message": "the microphone (\(audio.deviceNames.input)) is not delivering audio"])
                return
            }
        }
        audio.playStartTone()
        try? await Task.sleep(for: .seconds(AudioIO.toneDuration + 0.05))
        mode = .listening
        resetVad()
        _ = audio.takeStats()
        transcription = beginTranscription(source: "user", preroll: false)
        Events.emit("listening")
    }

    private func stopListening() async {
        let stats = audio.takeStats()
        Events.emit("micStats", [
            "callbacks": stats.callbacks, "delivered": stats.delivered, "formatMismatch": stats.formatMismatch,
            "conversionErrors": stats.conversionErrors, "format": stats.lastFormat,
            "tapFormat": "\(audio.engine.inputNode.outputFormat(forBus: 0))",
        ])
        guard mode == .listening, let session = transcription else { return }
        mode = .idle
        transcription = nil
        let text = await session.finish()
        Events.emit("transcript", ["text": text])
    }

    private func dropTranscription() async {
        let session = transcription
        transcription = nil
        mode = .idle
        resetVad()
        await session?.cancel()
    }

    private func beginTranscription(source: String, preroll includePreroll: Bool) -> LiveTranscription {
        let session = LiveTranscription(locale: locale) { text in
            Events.emit("partial", ["text": text, "source": source])
        }
        if includePreroll { preroll.forEach(session.feed) }
        session.begin()
        return session
    }

    // MARK: Microphone

    /// The audio engine restarted on new devices; any speech in flight was lost.
    func deviceChanged(input: String, output: String) async {
        await speaker.reset()
        if mode == .interrupting { await dropTranscription() }
        resetVad()
        preroll.removeAll()
        prerollFrames = 0
        Events.emit("deviceChanged", ["input": input, "output": output])
    }

    func onMic(_ buffer: AVAudioPCMBuffer) async {
        lastMicAt = Date()
        remember(buffer)
        if mode != .idle { reportLevel(buffer) }
        switch mode {
        case .listening:
            transcription?.feed(buffer)
            await runVad(buffer)
        case .interrupting:
            transcription?.feed(buffer)
            await runVad(buffer)
            if Date().timeIntervalSince(interruptionStarted) > Self.maxInterruptionSeconds { await endInterruption() }
        case .idle:
            let speaking = await speaker.isActive
            let paused = await speaker.paused
            if interruptions && speaking && !paused {
                await runVad(buffer)
            } else if vadRunning {
                resetVad()
            }
        }
    }

    /// Emits the peak level (dBFS) about five times a second while a turn or interruption is open.
    private func reportLevel(_ buffer: AVAudioPCMBuffer) {
        let samples = UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength))
        levelPeak = max(levelPeak, samples.reduce(0) { max($0, abs($1)) })
        let now = Date()
        guard now.timeIntervalSince(lastLevelEmit) >= 0.2 else { return }
        lastLevelEmit = now
        let db = levelPeak > 0 ? 20 * log10(levelPeak) : -120
        Events.emit("level", ["db": Int(db.rounded())])
        levelPeak = 0
    }

    private func remember(_ buffer: AVAudioPCMBuffer) {
        preroll.append(buffer)
        prerollFrames += Int(buffer.frameLength)
        let limit = Int(Self.prerollSeconds * AudioIO.micRate)
        while prerollFrames - Int(preroll[0].frameLength) >= limit {
            prerollFrames -= Int(preroll.removeFirst().frameLength)
        }
    }

    private func runVad(_ buffer: AVAudioPCMBuffer) async {
        guard let vad else { return }
        vadRunning = true
        vadSamples.append(contentsOf: UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        while vadSamples.count >= VadManager.chunkSize {
            let chunk = Array(vadSamples.prefix(VadManager.chunkSize))
            vadSamples.removeFirst(VadManager.chunkSize)
            guard let result = try? await vad.processStreamingChunk(chunk, state: vadState, config: segmentation) else { continue }
            vadState = result.state
            guard let event = result.event else { continue }
            switch mode {
            case .listening:
                Events.emit(event.isStart ? "speechStart" : "speechEnd")
            case .idle where event.isStart:
                await beginInterruption()
            case .interrupting where event.isEnd:
                await endInterruption()
                return
            default:
                break
            }
        }
    }

    private func resetVad() {
        vadState = .initial()
        vadSamples.removeAll()
        vadRunning = false
    }

    private func beginInterruption() async {
        await speaker.pause()
        mode = .interrupting
        interruptionStarted = Date()
        Events.emit("bargeIn")
        transcription = beginTranscription(source: "interruption", preroll: true)
    }

    private func endInterruption() async {
        guard mode == .interrupting, let session = transcription else { return }
        mode = .idle
        transcription = nil
        resetVad()
        let text = await session.finish()
        Events.emit("interruption", ["text": text])
    }
}
