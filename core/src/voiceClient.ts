import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Events emitted by the voice process (voice/Sources/VoiceHarnessVoice). */
export type VoiceEvent =
  | { event: "loading" }
  | {
      event: "ready";
      voice: string;
      microphone: boolean;
      interruptions: boolean;
      voiceProcessing: boolean;
      inputDevice: string;
      outputDevice: string;
      startupMs: number;
    }
  | { event: "deviceChanged"; input: string; output: string }
  | { event: "level"; db: number }
  | { event: "micStats"; callbacks: number; delivered: number; formatMismatch: number; conversionErrors: number; format: string; tapFormat: string }
  | { event: "synthesized"; id: number; ms: number; audioMs: number }
  | { event: "speechActive" }
  | { event: "speechIdle" }
  | { event: "spoke"; id: number }
  | { event: "marked"; id: number }
  | { event: "rendered"; id: number; path: string; voice: string; ms: number; audioMs: number }
  | { event: "voices"; voices: string[] }
  | { event: "micWarming" }
  | { event: "listening" }
  | { event: "speechStart" }
  | { event: "speechEnd" }
  | { event: "partial"; text: string; source: "user" | "interruption" }
  | { event: "transcript"; text: string }
  | { event: "bargeIn" }
  | { event: "interruption"; text: string }
  | { event: "listenCancelled" }
  | { event: "micUnavailable"; reason: string }
  | { event: "error"; message: string }
  | { event: "fatal"; message: string }
  | { event: "log"; message: string };

export interface VoiceClientOptions {
  /** Absolute path of the VoiceHarnessVoice binary. */
  binary: string;
  /** Folder holding the FluidAudio models (downloaded on first use). */
  modelsDirectory: string;
  voice: string;
  /** macOS voice processing (echo cancellation) for use without headphones. */
  voiceProcessing: boolean;
  /** Pause speech automatically when the user starts talking over it. */
  interruptions: boolean;
  onEvent(e: VoiceEvent): void;
  onExit(reason: string): void;
}

/** Spawns the voice process and speaks its JSON-lines protocol. */
export class VoiceClient {
  private nextId = 1;
  private disposed = false;

  private constructor(private readonly child: ChildProcess) {}

  static start(opts: VoiceClientOptions): VoiceClient {
    const args = ["--models", opts.modelsDirectory, "--voice", opts.voice];
    if (opts.voiceProcessing) args.push("--voice-processing");
    if (opts.interruptions) args.push("--interruptions");
    const child = spawn(opts.binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    const client = new VoiceClient(child);
    child.stdin?.on("error", () => {});
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith('{"event"')) {
        if (line.trim()) opts.onEvent({ event: "log", message: line });
        return;
      }
      try {
        opts.onEvent(JSON.parse(line) as VoiceEvent);
      } catch {
        opts.onEvent({ event: "log", message: line });
      }
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      if (line.trim()) opts.onEvent({ event: "log", message: line });
    });
    child.on("error", (err) => opts.onExit(`voice process failed to start: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (!client.disposed) opts.onExit(`voice process exited (code ${code}, signal ${signal})`);
    });
    return client;
  }

  speak(text: string): number {
    const id = this.nextId++;
    this.send({ cmd: "speak", id, text });
    return id;
  }

  /** Queues a marker behind the speech already queued; the voice process emits `marked` with this id when playback reaches it. */
  mark(): number {
    const id = this.nextId++;
    this.send({ cmd: "mark", id });
    return id;
  }

  stopSpeaking(): void {
    this.send({ cmd: "stopSpeaking" });
  }

  pauseSpeaking(): void {
    this.send({ cmd: "pauseSpeaking" });
  }

  resumeSpeaking(): void {
    this.send({ cmd: "resumeSpeaking" });
  }

  listenStart(): void {
    this.send({ cmd: "listenStart" });
  }

  listenStop(): void {
    this.send({ cmd: "listenStop" });
  }

  listenCancel(): void {
    this.send({ cmd: "listenCancel" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.send({ cmd: "shutdown" });
    this.child.stdin?.end();
    setTimeout(() => this.child.kill("SIGTERM"), 1000).unref();
  }

  private send(command: Record<string, unknown>): void {
    if (this.disposed && command.cmd !== "shutdown") return;
    this.child.stdin?.write(JSON.stringify(command) + "\n");
  }
}
