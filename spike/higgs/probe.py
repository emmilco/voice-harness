"""Higgs Audio v3 latency probe for the harness: renders harness-style sentences
one at a time with philosophy-tts's production renderer and voice, timing each.

Run under the philosophy-tts Higgs venv, through the gpu-broker:
  gpu-broker submit --name higgs-probe --priority high --cmd "<venv python> probe.py"

Writes out/<n>.wav and out/timings.json. Short and non-resumable (contract: declare
max_runtime_s, pausable false), so a signal just exits.
"""
import json, signal, sys, time
from pathlib import Path

sys.path.insert(0, "/Users/elliotmilco/Documents/GitHub/philosophy-tts")
for sig in (signal.SIGUSR1, signal.SIGTERM):
    signal.signal(sig, lambda *_: sys.exit(42))

OUT = Path(__file__).parent / "out"
OUT.mkdir(exist_ok=True)
REF_WAV = Path("/Users/elliotmilco/Documents/GitHub/philosophy-tts/voice_refs/irons_ref_oxford.wav")
REF_TXT = REF_WAV.with_suffix(".txt").read_text().strip()

SENTENCES = [
    "Here we see the raw attention scores: every query dotted with every key.",
    "This is the division by the square root of d_k, so the softmax doesn't saturate as the model gets wider.",
    "Notice these two lines. They reshape the logits from B by T by V into B times T rows before the cross-entropy.",
    "The function loss_fn in tiny_gpt.py calls F.cross_entropy on logits.view(B * T, V).",
    "Want me to show the plot, or keep going to the mask?",
]

t0 = time.time()
from mlx_audio.tts.utils import load  # noqa: E402  (slow import; counted as load time)
import soundfile as sf  # noqa: E402
from philosophy_tts.higgs_render import CachedHiggsRenderer  # noqa: E402
model = load("bosonai/higgs-audio-v3-tts-4b")
renderer = CachedHiggsRenderer(model, REF_WAV, REF_TXT)
load_s = time.time() - t0

timings = {"load_s": round(load_s, 2), "sentences": []}
for i, text in enumerate(SENTENCES, 1):
    t = time.time()
    audio, sr, steps = renderer.render_sentence(text, seed=1000 + i)
    render_s = time.time() - t
    audio_s = len(audio) / sr
    sf.write(OUT / f"{i}.wav", audio, sr)
    timings["sentences"].append({"n": i, "chars": len(text), "render_s": round(render_s, 2),
                                 "audio_s": round(audio_s, 2), "rtf": round(render_s / audio_s, 2), "steps": steps})
    print(f"{i}: {render_s:5.2f} s to render {audio_s:4.1f} s of audio (RTF {render_s / audio_s:.2f}) — {text[:50]}", flush=True)

(OUT / "timings.json").write_text(json.dumps(timings, indent=2))
print(f"model load {load_s:.1f} s; first sentence {timings['sentences'][0]['render_s']} s")
