import AVFAudio
import Foundation
import Speech

/// One utterance transcribed live with SpeechAnalyzer: feed 16 kHz mono buffers
/// as they arrive, receive running text, then `finish()` for the final transcript.
final class LiveTranscription {
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var analyzerFormat: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var resultsTask: Task<String, Error>?
    private var formatTask: Task<Void, Never>?
    private var formatKnown = false
    private var fedAnyAudio = false
    private var pending: [AVAudioPCMBuffer] = []
    private let lock = NSLock()

    /// Analysis starts at construction, consuming the input stream as buffers are fed.
    init(locale: Locale, onPartial: @escaping (String) -> Void) {
        transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults], attributeOptions: [])
        let (input, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.continuation = continuation
        analyzer = SpeechAnalyzer(inputSequence: input, modules: [transcriber])
        let transcriber = self.transcriber
        resultsTask = Task {
            var finalized = ""
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal {
                    finalized += text
                    onPartial(finalized)
                } else {
                    onPartial(finalized + text)
                }
            }
            return finalized
        }
    }

    /// Looks up the analyzer's preferred audio format; buffers fed before it is known are queued.
    func begin() {
        let transcriber = self.transcriber
        formatTask = Task {
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
            // Forwarding happens under the lock so queued audio stays ahead of newer buffers.
            self.lock.withLock {
                self.analyzerFormat = format
                self.formatKnown = true
                for buffer in self.pending { self.yieldConverted(buffer) }
                self.pending = []
            }
        }
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            if formatKnown {
                yieldConverted(buffer)
            } else {
                pending.append(buffer)
            }
        }
    }

    /// Call with `lock` held.
    private func yieldConverted(_ buffer: AVAudioPCMBuffer) {
        guard let target = analyzerFormat, target != buffer.format else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            fedAnyAudio = true
            return
        }
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: target) }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * target.sampleRate / buffer.format.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error == nil, out.frameLength > 0 {
            continuation.yield(AnalyzerInput(buffer: out))
            fedAnyAudio = true
        }
    }

    /// Ends input and returns the final transcript ("" if no final result arrives within `timeout`).
    func finish(timeout: Duration = .seconds(5)) async -> String {
        await formatTask?.value
        continuation.finish()
        // Finalizing an analyzer that never received audio does not return.
        guard lock.withLock({ fedAnyAudio }) else {
            await analyzer.cancelAndFinishNow()
            resultsTask?.cancel()
            return ""
        }
        let analyzer = self.analyzer
        let finalized = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                try? await analyzer.finalizeAndFinishThroughEndOfInput()
                return true
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
        if !finalized {
            Events.log("transcription finalize timed out")
            await analyzer.cancelAndFinishNow()
        }
        guard let results = resultsTask else { return "" }
        let text = await withTaskGroup(of: String?.self) { group in
            group.addTask { try? await results.value }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
        if text == nil {
            Events.log("transcription result timed out")
            results.cancel()
        }
        return (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func cancel() async {
        continuation.finish()
        await analyzer.cancelAndFinishNow()
        resultsTask?.cancel()
    }
}
