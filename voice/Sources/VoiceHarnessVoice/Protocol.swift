import Foundation

/// A command from the harness, one JSON object per stdin line.
///
/// - `speak` {id, text}: queue one sentence for speech.
/// - `mark` {id}: queue a marker; `marked` {id} is emitted when playback reaches it.
/// - `render` {id, text, path}: synthesize to a 48 kHz 16-bit WAV file; emits `rendered`.
/// - `cue`: plays the attention chime.
/// - `stopSpeaking`: drop queued and playing speech.
/// - `pauseSpeaking` / `resumeSpeaking`: pause or continue playback.
/// - `listenStart`: stop any speech, play the start tone, begin a user turn.
/// - `listenStop`: end the user turn and emit its transcript.
/// - `listenCancel`: end the user turn without a transcript.
/// - `shutdown`: exit.
struct Command: Decodable {
    let cmd: String
    let id: Int?
    let text: String?
    let path: String?
}

/// Writes one JSON event per stdout line. Other stdout output (library logging)
/// does not start with `{"event"` and is ignored by the harness.
enum Events {
    private static let lock = NSLock()

    /// `event` names are fixed ASCII identifiers, so they need no JSON escaping.
    static func emit(_ event: String, _ fields: [String: Any] = [:]) {
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let body = String(data: data, encoding: .utf8)
        else { return }
        let line = body == "{}" ? "{\"event\":\"\(event)\"}" : "{\"event\":\"\(event)\"," + body.dropFirst()
        lock.lock()
        FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
        lock.unlock()
    }

    static func log(_ message: String) {
        emit("log", ["message": message])
    }
}
