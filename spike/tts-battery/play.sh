#!/bin/bash
# Plays one battery sentence (1-5) through every model in turn, announcing each
# folder name on the terminal. Optional further arguments restrict the models:
#   ./play.sh 4                       sentence 4, all models
#   ./play.sh 4 kokoro pocket         sentence 4, folders matching either word
cd "$(dirname "$0")" || exit 1
n=${1:?usage: play.sh <sentence 1-5> [model-name-filter ...]}; shift
sed -n "${n}p" sentences.txt
for d in out/*/; do
  name=$(basename "$d")
  if [ $# -gt 0 ]; then keep=; for f in "$@"; do case $name in *$f*) keep=1;; esac; done; [ -n "$keep" ] || continue; fi
  [ -f "$d$n.wav" ] || continue
  echo "-> $name"; afplay "$d$n.wav"; sleep 0.6
done
