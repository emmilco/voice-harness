import AVFAudio
import Foundation

/// Speaks queued sentences in order: synthesizes each with the system voice,
/// schedules the audio on the speech player as it arrives, and reports `spoke`
/// as each sentence finishes playing.
/// Markers queued between sentences report `marked` when playback reaches them.
/// `speechActive` / `speechIdle` events bracket any stretch of speech.
actor Speaker {
    private enum Item {
        case speech(id: Int, text: String)
        case mark(id: Int)
    }

    private let speech: SystemSpeech
    private let audio: AudioIO
    private var queue: [Item] = []
    private var generation = 0
    private var synthesizing = false
    private var outstanding = 0
    private var wasActive = false
    private(set) var paused = false

    init(speech: SystemSpeech, audio: AudioIO) {
        self.speech = speech
        self.audio = audio
    }

    var isActive: Bool { !queue.isEmpty || synthesizing || outstanding > 0 }

    func enqueue(id: Int, text: String) {
        queue.append(.speech(id: id, text: text))
        pump()
        reportActivity()
    }

    func enqueueMark(id: Int) {
        queue.append(.mark(id: id))
        pump()
        reportActivity()
    }

    func stop() {
        generation += 1
        queue.removeAll()
        outstanding = 0
        synthesizing = false
        audio.speechPlayer.stop()
        audio.speechPlayer.play()
        paused = false
        reportActivity()
    }

    /// After an engine restart: scheduled audio is gone, so drop all speech state.
    func reset() {
        stop()
    }

    func pause() {
        guard !paused else { return }
        audio.speechPlayer.pause()
        paused = true
    }

    func resume() {
        guard paused else { return }
        audio.speechPlayer.play()
        paused = false
    }

    private func pump() {
        while !synthesizing, !queue.isEmpty {
            switch queue.removeFirst() {
            case .mark(let id):
                placeMark(id: id)
            case .speech(let id, let text):
                synthesizing = true
                let gen = generation
                Task { await self.synthesize((id, text), generation: gen) }
            }
        }
    }

    /// Reports the marker now if nothing is waiting to play; otherwise after the audio already scheduled.
    private func placeMark(id: Int) {
        guard outstanding > 0, let silence = audio.makeSpeechBuffer([0]) else {
            Events.emit("marked", ["id": id])
            return
        }
        let gen = generation
        outstanding += 1
        audio.speechPlayer.scheduleBuffer(silence, completionCallbackType: .dataPlayedBack) { _ in
            Task { await self.markReached(id: id, generation: gen) }
        }
    }

    private func markReached(id: Int, generation gen: Int) {
        guard gen == generation else { return }
        outstanding -= 1
        Events.emit("marked", ["id": id])
        reportActivity()
    }

    /// Audio is scheduled in pieces of about this length while a sentence is still being synthesized.
    private static let pieceLength = Int(AudioIO.speechRate * 0.2)

    private func synthesize(_ item: (id: Int, text: String), generation gen: Int) async {
        let started = Date()
        var firstMs: Int?
        var total = 0
        var pending: [Float] = []
        for await samples in speech.stream(item.text) {
            guard gen == generation else { break }
            if firstMs == nil { firstMs = Int(Date().timeIntervalSince(started) * 1000) }
            total += samples.count
            pending += samples
            if pending.count >= Speaker.pieceLength {
                schedule(pending)
                pending = []
            }
        }
        if gen == generation {
            Events.emit("synthesized", [
                "id": item.id,
                "ms": Int(Date().timeIntervalSince(started) * 1000),
                "firstMs": firstMs ?? 0,
                "audioMs": Int(Double(total) / AudioIO.speechRate * 1000),
            ])
            // The last piece (or a moment of silence, when none is left) carries the end-of-sentence callback.
            if let buffer = audio.makeSpeechBuffer(pending.isEmpty ? [0] : pending) {
                outstanding += 1
                audio.speechPlayer.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
                    Task { await self.played(id: item.id, generation: gen) }
                }
            }
            synthesizing = false
            pump()
        }
        reportActivity()
    }

    private func schedule(_ samples: [Float]) {
        guard let buffer = audio.makeSpeechBuffer(samples) else { return }
        audio.speechPlayer.scheduleBuffer(buffer, completionHandler: nil)
    }

    private func played(id: Int, generation gen: Int) {
        guard gen == generation else { return }
        outstanding -= 1
        Events.emit("spoke", ["id": id])
        reportActivity()
    }

    private func reportActivity() {
        let active = isActive
        guard active != wasActive else { return }
        wasActive = active
        Events.emit(active ? "speechActive" : "speechIdle")
    }
}
