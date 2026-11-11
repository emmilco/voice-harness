import Foundation

/// Text to audio through `/usr/bin/say`, in the voice chosen in System Settings →
/// Accessibility → Read & Speak.
///
/// The speech framework hides Siri voices from processes Apple did not sign, so
/// this process cannot synthesize them itself; `say` can. Each utterance is one
/// `say` run rendering to a temporary WAV file. No voice is ever named to `say`:
/// given a name it does not know, it speaks in a default voice instead of failing.
///
/// One utterance is synthesized at a time: starting another ends the one in flight.
final class SystemSpeech: @unchecked Sendable {
    private let sampleRate: Int
    private let lock = NSLock()
    private var current: (process: Process, continuation: AsyncStream<[Float]>.Continuation)?

    init(sampleRate: Double) {
        self.sampleRate = Int(sampleRate)
    }

    /// Synthesizes `text`, yielding its mono samples at `sampleRate`. The stream ends
    /// when the utterance is complete, fails, or a later call supersedes it; one that
    /// yields nothing produced no audio.
    func stream(_ text: String) -> AsyncStream<[Float]> {
        let (stream, continuation) = AsyncStream<[Float]>.makeStream()
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("voice-harness-\(UUID().uuidString).wav")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        // The text goes in on stdin, so that nothing in it is read as an option.
        process.arguments = ["-o", file.path, "--data-format=LEI16@\(sampleRate)", "-f", "-"]
        let input = Pipe()
        process.standardInput = input
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [self] finished in
            defer { try? FileManager.default.removeItem(at: file) }
            let superseded: Bool = lock.withLock {
                guard current?.process === finished else { return true }
                current = nil
                return false
            }
            if !superseded, finished.terminationStatus == 0,
               let samples = SystemSpeech.samples(inWav: file), !samples.isEmpty {
                continuation.yield(samples)
            }
            continuation.finish()
        }
        let previous = lock.withLock { () -> Process? in
            defer { current = (process, continuation) }
            return current?.process
        }
        previous?.terminate()
        do {
            try process.run()
            input.fileHandleForWriting.write(Data(text.utf8))
            try? input.fileHandleForWriting.close()
        } catch {
            lock.withLock { if current?.process === process { current = nil } }
            continuation.finish()
        }
        return stream
    }

    /// Synthesizes all of `text` at once; empty when it produced no audio.
    func render(_ text: String) async -> [Float] {
        var samples: [Float] = []
        for await chunk in stream(text) { samples += chunk }
        return samples
    }

    /// The samples of a mono 16-bit PCM WAV file.
    private static func samples(inWav url: URL) -> [Float]? {
        guard let data = try? Data(contentsOf: url), let tag = data.range(of: Data("data".utf8)) else { return nil }
        let start = tag.upperBound + 4
        guard start <= data.count else { return nil }
        return data[start...].withUnsafeBytes { raw in
            (0..<raw.count / 2).map { Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self))) / 32768 }
        }
    }
}
