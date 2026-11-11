#!/bin/bash
# Renders sentences.txt through every small TTS backend in the pinned FluidAudio
# checkout, into out/<model>/<n>.wav, for side-by-side listening (play.sh).
# The system voice (out/siri-aaron, named for the voice set when it was made) goes through say.
#
# Needs: ../../voice resolved (npm run build), ffmpeg, and ~/.cache/fluidaudio
# symlinked to the governed model store, because the FluidAudio CLI has no
# models-directory option. First use of a backend downloads its weights.
#
# Reference-clip constraints the backends impose:
#   styletts2  exactly 69000 samples at 24 kHz (its reference encoder is fixed at 231 mel frames)
#   luxtts     at most 5 s, with a transcript that matches the clip exactly
#   pocket     any length
set -u
cd "$(dirname "$0")" || exit 1
B=$PWD; VOICE=$B/../../voice; CLI=$B/.build/release/fluidaudiocli
NARRATOR=${NARRATOR:-$HOME/Documents/GitHub/philosophy-tts/voice_refs/irons_ref_oxford.wav}
mkdir -p logs refs

[ -x "$CLI" ] || swift build -c release --package-path "$VOICE/.build/checkouts/FluidAudio" \
  --scratch-path "$B/.build" --product fluidaudiocli || exit 1

# --- Kokoro baseline, the am_onyx reference clips, and the system (Siri) voice ---
say_to() {  # say_to <wav path> <text>: the Mac's system voice
  say -o "$1" --data-format=LEI16@48000 -f - <<< "$2"
}
kokoro() {  # kokoro <wav path> <text>
  "$CLI" tts "$2" --backend kokoro --voice am_onyx --output "$1" >> logs/kokoro-am_onyx.log 2>&1
}
mkdir -p out/kokoro-am_onyx out/siri-aaron; : > logs/kokoro-am_onyx.log
i=0; while IFS= read -r line; do i=$((i+1))
  kokoro "out/kokoro-am_onyx/$i.wav" "$line"
  say_to "out/siri-aaron/$i.wav" "$line"
done < sentences.txt
kokoro refs/onyx_ref.wav "$(cat refs/onyx_ref.txt)"
kokoro refs/onyx_ref_short.wav "$(cat refs/onyx_ref_short.txt)"

# --- Reference clips cut to each backend's constraint ---
ffmpeg -loglevel error -y -i refs/onyx_ref.wav -ac 1 -af "aresample=24000,atrim=end_sample=69000" refs/onyx_ref_2875ms.wav
ffmpeg -loglevel error -y -i "$NARRATOR" -ac 1 -af "aresample=24000,atrim=end_sample=69000" refs/irons_ref_2875ms.wav
ffmpeg -loglevel error -y -ss 0.38 -t 5.0 -i "$NARRATOR" -ac 1 -af aresample=24000 refs/irons_ref_short.wav

# --- Backends the benchmark command drives: one process, warm timings ---
bench() {  # bench <folder> <cli args...>
  local name=$1; shift; mkdir -p "out/$name"
  "$CLI" tts-benchmark --corpus-path sentences.txt --skip-asr --audio-dir "out/$name" \
    --output-json "out/$name/timings.json" "$@" > "logs/$name.log" 2>&1 || echo "$name FAILED (logs/$name.log)"
  for i in 1 2 3 4 5; do [ -f "out/$name/phrase_00$i.wav" ] && mv "out/$name/phrase_00$i.wav" "out/$name/$i.wav"; done
}
bench paradee-bm_fable --backend paradee --voice bm_fable
bench pocket-alba      --backend pocket
bench chatterbox-nano  --backend chatterbox-nano
bench styletts2-onyx   --backend styletts2 --reference refs/onyx_ref_2875ms.wav
bench styletts2-irons  --backend styletts2 --reference refs/irons_ref_2875ms.wav
for v in M1 M2; do
  [ -s refs/supertonic_$v.json ] || curl -sfL -o refs/supertonic_$v.json \
    "https://huggingface.co/FluidInference/supertonic-3-coreml/resolve/main/voice_styles/$v.json"
  bench supertonic3-$v --backend supertonic3 --voice-style refs/supertonic_$v.json
done

# --- Backends only the single-sentence command drives: one process per sentence ---
each() {  # each <folder> <cli args...>
  local name=$1 i=0 line; shift; mkdir -p "out/$name"; : > "logs/$name.log"
  while IFS= read -r line; do i=$((i+1))
    "$CLI" tts "$line" --output "out/$name/$i.wav" "$@" >> "logs/$name.log" 2>&1 || echo "$name sentence $i FAILED"
  done < sentences.txt
}
each pocket-clone-onyx  --backend pocket --clone-voice refs/onyx_ref.wav
each pocket-clone-irons --backend pocket --clone-voice "$NARRATOR"
each luxtts-onyx  --backend luxtts --prompt-audio refs/onyx_ref_short.wav  --prompt-text "$(cat refs/onyx_ref_short.txt)"
each luxtts-irons --backend luxtts --prompt-audio refs/irons_ref_short.wav --prompt-text "$(cat refs/irons_ref_short.txt)"
