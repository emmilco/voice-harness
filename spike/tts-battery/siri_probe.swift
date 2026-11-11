// Probes whether AVSpeechSynthesizer hands this process samples for the Siri
// voice, and how quickly: lists Siri voices the API reports, then renders each
// line of sentences.txt with write(_:toBufferCallback:), timing the first
// buffer and the whole utterance.
//   swift siri_probe.swift [voice identifier]
import AVFoundation

let wanted = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.apple.siri.natural.Aaron"
let all = AVSpeechSynthesisVoice.speechVoices()
let siri = all.filter { $0.identifier.lowercased().contains("siri") }
print("voices reported: \(all.count); Siri voices among them: \(siri.map(\.identifier))")
let voice = AVSpeechSynthesisVoice(identifier: wanted)
print("lookup \(wanted): \(voice.map { "\($0.name) quality=\($0.quality.rawValue)" } ?? "nil")")
let system = AVSpeechSynthesisVoice(language: nil)
print("default voice (language nil): \(system?.identifier ?? "nil")")

let synthesizer = AVSpeechSynthesizer()
let lines = ((try? String(contentsOfFile: "sentences.txt", encoding: .utf8)) ?? "Hello there.")
    .split(separator: "\n").map(String.init)

func render(_ text: String, voice: AVSpeechSynthesisVoice?) async -> (firstMs: Int, totalMs: Int, audioMs: Int, format: String) {
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    let started = Date()
    var first: Date?
    var frames = 0
    var rate = 0.0
    var format = ""
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        var finished = false
        synthesizer.write(utterance) { buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            if pcm.frameLength == 0 {
                if !finished { finished = true; done.resume() }
                return
            }
            if first == nil { first = Date() }
            frames += Int(pcm.frameLength)
            rate = pcm.format.sampleRate
            format = "\(Int(rate)) Hz, \(pcm.format.channelCount) ch, \(pcm.format.commonFormat.rawValue)"
        }
    }
    let now = Date()
    return (Int((first ?? now).timeIntervalSince(started) * 1000), Int(now.timeIntervalSince(started) * 1000),
            rate > 0 ? Int(Double(frames) / rate * 1000) : 0, format)
}

Task {
    _ = await render("Initialization warm-up.", voice: voice)
    for (i, line) in lines.enumerated() {
        let r = await render(line, voice: voice)
        print("\(i + 1): first buffer \(r.firstMs) ms, done \(r.totalMs) ms, audio \(r.audioMs) ms [\(r.format)]")
    }
    exit(0)
}
RunLoop.main.run()
