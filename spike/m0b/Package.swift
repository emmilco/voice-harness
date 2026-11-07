// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "VoiceCheck",
    platforms: [.macOS("26.0")],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.2", traits: ["TTS"]),
    ],
    targets: [
        .executableTarget(
            name: "VoiceCheck",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        ),
    ]
)
