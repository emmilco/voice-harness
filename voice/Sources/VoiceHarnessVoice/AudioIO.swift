import AVFAudio
import CoreAudio
import Foundation

/// One AVAudioEngine for both directions: a player for speech, a player for the
/// start tone, and a microphone tap delivering 16 kHz mono Float32 buffers.
/// Sharing the engine lets macOS voice processing cancel the speech echo when
/// enabled.
///
/// When the default devices change (AirPods connecting, a headset unplugged),
/// the engine stops itself; this class rebuilds the tap for the new input
/// format, restarts, and calls `onDeviceChange`. Speech scheduled on the player
/// before the change is lost.
final class AudioIO {
    static let micRate: Double = 16_000
    static let speechRate: Double = 48_000

    let engine = AVAudioEngine()
    let speechPlayer = AVAudioPlayerNode()
    private let tonePlayer = AVAudioPlayerNode()
    let speechFormat = AVAudioFormat(standardFormatWithSampleRate: speechRate, channels: 1)!
    let micFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: micRate, channels: 1, interleaved: false)!

    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var stats = MicStats()

    /// Counters describing what the microphone tap has done since the last `takeStats()`.
    struct MicStats {
        var callbacks = 0
        var delivered = 0
        var formatMismatch = 0
        var conversionErrors = 0
        var lastFormat = "none"
    }

    func takeStats() -> MicStats {
        lock.withLock {
            defer { stats = MicStats() }
            return stats
        }
    }
    private var withMicrophone = false
    private var configObserver: NSObjectProtocol?
    private let reconfigureQueue = DispatchQueue(label: "voice-harness.audio-reconfigure")

    /// Receives each microphone buffer, already at 16 kHz mono Float32.
    var onMic: ((AVAudioPCMBuffer) -> Void)?
    /// Called after the engine restarts on new devices: (input name, output name) or an error.
    var onDeviceChange: ((Result<(String, String), Error>) -> Void)?

    init(voiceProcessing: Bool) throws {
        if voiceProcessing {
            try engine.inputNode.setVoiceProcessingEnabled(true)
        }
        engine.attach(speechPlayer)
        engine.attach(tonePlayer)
        engine.connect(speechPlayer, to: engine.mainMixerNode, format: speechFormat)
        engine.connect(tonePlayer, to: engine.mainMixerNode, format: speechFormat)
    }

    /// Starts output, and microphone capture when `withMicrophone` is true.
    func start(withMicrophone: Bool) throws {
        self.withMicrophone = withMicrophone
        if withMicrophone { installTap() }
        engine.prepare()
        try engine.start()
        speechPlayer.play()
        tonePlayer.play()
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.reconfigureQueue.async { self?.restartAfterDeviceChange() }
        }
    }

    var deviceNames: (input: String, output: String) {
        (Self.defaultDeviceName(input: true), Self.defaultDeviceName(input: false))
    }

    private func installTap() {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        lock.withLock { converter = AVAudioConverter(from: inputFormat, to: micFormat) }
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            self?.deliver(buffer)
        }
    }

    private func restartAfterDeviceChange() {
        if withMicrophone { engine.inputNode.removeTap(onBus: 0) }
        engine.stop()
        do {
            if withMicrophone { installTap() }
            engine.prepare()
            try engine.start()
            speechPlayer.play()
            tonePlayer.play()
            let names = deviceNames
            onDeviceChange?(.success((names.input, names.output)))
        } catch {
            onDeviceChange?(.failure(error))
        }
    }

    private func deliver(_ buffer: AVAudioPCMBuffer) {
        guard let onMic else { return }
        lock.lock()
        defer { lock.unlock() }
        stats.callbacks += 1
        stats.lastFormat = "\(buffer.format.sampleRate) Hz, \(buffer.format.channelCount) ch, \(buffer.format.commonFormat.rawValue), interleaved=\(buffer.format.isInterleaved)"
        guard let converter, converter.inputFormat == buffer.format else {
            stats.formatMismatch += 1
            return
        }
        let ratio = micFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }
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
            stats.delivered += 1
            onMic(out)
        } else {
            stats.conversionErrors += 1
        }
    }

    func makeSpeechBuffer(_ samples: [Float]) -> AVAudioPCMBuffer? {
        guard !samples.isEmpty,
              let buffer = AVAudioPCMBuffer(pcmFormat: speechFormat, frameCapacity: AVAudioFrameCount(samples.count))
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
        }
        return buffer
    }

    /// A short rising two-note chime marking the start of listening.
    func playStartTone() {
        playNotes([660.0, 990.0])
    }

    /// A short falling two-note chime: something needs the user's attention.
    func playAttentionTone() {
        playNotes([880.0, 587.0])
    }

    private func playNotes(_ frequencies: [Double]) {
        let rate = AudioIO.speechRate
        let noteLength = Int(rate * 0.09)
        var samples: [Float] = []
        for frequency in frequencies {
            for i in 0..<noteLength {
                let t = Double(i) / rate
                let envelope = min(1.0, Double(i) / (rate * 0.01)) * min(1.0, Double(noteLength - i) / (rate * 0.025))
                samples.append(Float(sin(2 * .pi * frequency * t) * envelope * 0.25))
            }
        }
        if let buffer = makeSpeechBuffer(samples) {
            tonePlayer.scheduleBuffer(buffer, completionHandler: nil)
        }
    }

    static var toneDuration: TimeInterval { 0.18 }

    /// The name of the system default input or output device, or "unknown".
    static func defaultDeviceName(input: Bool) -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else {
            return "unknown"
        }
        address.mSelector = kAudioObjectPropertyName
        var name: Unmanaged<CFString>?
        size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &name) == noErr, let name else {
            return "unknown"
        }
        return name.takeRetainedValue() as String
    }
}
