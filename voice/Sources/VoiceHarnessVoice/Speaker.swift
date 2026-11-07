import AVFAudio
import FluidAudio
import Foundation

/// Speaks queued sentences in order: synthesizes each with Kokoro, schedules it
/// on the speech player, and reports `spoke` as each finishes playing.
/// `speechActive` / `speechIdle` events bracket any stretch of speech.
actor Speaker {
    private let kokoro: KokoroAneManager
    private let voice: String
    private let audio: AudioIO
    private var queue: [(id: Int, text: String)] = []
    private var generation = 0
    private var synthesizing = false
    private var outstanding = 0
    private var wasActive = false
    private(set) var paused = false

    init(kokoro: KokoroAneManager, voice: String, audio: AudioIO) {
        self.kokoro = kokoro
        self.voice = voice
        self.audio = audio
    }

    var isActive: Bool { !queue.isEmpty || synthesizing || outstanding > 0 }

    func enqueue(id: Int, text: String) {
        queue.append((id, text))
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
        guard !synthesizing, !queue.isEmpty else { return }
        synthesizing = true
        let item = queue.removeFirst()
        let gen = generation
        Task { await self.synthesize(item, generation: gen) }
    }

    private func synthesize(_ item: (id: Int, text: String), generation gen: Int) async {
        do {
            let started = Date()
            let result = try await kokoro.synthesizeDetailed(text: item.text, voice: voice)
            Events.emit("synthesized", [
                "id": item.id,
                "ms": Int(Date().timeIntervalSince(started) * 1000),
                "audioMs": Int(Double(result.samples.count) / AudioIO.speechRate * 1000),
            ])
            if gen == generation, let buffer = audio.makeSpeechBuffer(result.samples) {
                outstanding += 1
                audio.speechPlayer.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
                    Task { await self.played(id: item.id, generation: gen) }
                }
            }
        } catch {
            Events.emit("error", ["message": "speech synthesis failed: \(error.localizedDescription)", "id": item.id])
        }
        if gen == generation {
            synthesizing = false
            pump()
        }
        reportActivity()
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
