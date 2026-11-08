const GROUPS = [
  ["af_", "American · female"],
  ["am_", "American · male"],
  ["bf_", "British · female"],
  ["bm_", "British · male"],
];

const $ = (id) => document.getElementById(id);
const select = $("voice");
const text = $("text");
const audio = $("audio");
const status = $("status");
const cache = new Map();
let stopRequested = false;

function setStatus(message) {
  status.textContent = message;
}

function updateSetting() {
  $("setting").textContent = `"voiceHarness.voice": "${select.value}"`;
}

async function loadVoices() {
  const { voices, current } = await (await fetch("/api/voices")).json();
  for (const [prefix, label] of GROUPS) {
    const names = voices.filter((v) => v.startsWith(prefix));
    if (!names.length) continue;
    const group = document.createElement("optgroup");
    group.label = label;
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name + (name === current ? "  (current)" : "");
      group.appendChild(option);
    }
    select.appendChild(group);
  }
  const others = voices.filter((v) => !GROUPS.some(([p]) => v.startsWith(p)));
  for (const name of others) select.add(new Option(name, name));
  select.value = current;
  updateSetting();
}

async function fetchAudio(voice, words) {
  const key = `${voice}\u0000${words}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice, text: words }),
  });
  if (!res.ok) throw new Error(await res.text());
  const entry = {
    url: URL.createObjectURL(await res.blob()),
    synthMs: Number(res.headers.get("X-Synth-Ms")),
    audioMs: Number(res.headers.get("X-Audio-Ms")),
  };
  cache.set(key, entry);
  return entry;
}

function playUntilEnd(url) {
  return new Promise((resolve) => {
    audio.src = url;
    audio.onended = resolve;
    audio.onpause = () => {
      if (stopRequested) resolve();
    };
    audio.play();
  });
}

async function playOne() {
  const words = text.value.trim();
  if (!words) return;
  setStatus(`Synthesizing ${select.value}…`);
  try {
    const { url, synthMs, audioMs } = await fetchAudio(select.value, words);
    setStatus(`${select.value} — ${(audioMs / 1000).toFixed(1)} s of audio, synthesized in ${synthMs} ms`);
    audio.src = url;
    await audio.play();
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  }
}

async function playAll() {
  const words = text.value.trim();
  if (!words) return;
  stopRequested = false;
  $("stop").disabled = false;
  $("all").disabled = true;
  const names = [...select.options].map((o) => o.value);
  try {
    for (let i = 0; i < names.length && !stopRequested; i++) {
      select.value = names[i];
      updateSetting();
      setStatus(`${i + 1}/${names.length} · ${names[i]}`);
      const nextFetch = i + 1 < names.length ? fetchAudio(names[i + 1], words).catch(() => {}) : null;
      const { url } = await fetchAudio(names[i], words);
      await playUntilEnd(url);
      await nextFetch;
    }
    setStatus(stopRequested ? "Stopped." : "Played every voice.");
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    $("stop").disabled = true;
    $("all").disabled = false;
  }
}

function step(delta) {
  const options = [...select.options];
  const i = options.findIndex((o) => o.value === select.value);
  const next = options[Math.max(0, Math.min(options.length - 1, i + delta))];
  select.value = next.value;
  updateSetting();
  playOne();
}

$("play").addEventListener("click", playOne);
$("all").addEventListener("click", playAll);
$("stop").addEventListener("click", () => {
  stopRequested = true;
  audio.pause();
});
$("prev").addEventListener("click", () => step(-1));
$("next").addEventListener("click", () => step(1));
select.addEventListener("change", () => {
  updateSetting();
  playOne();
});
select.addEventListener("keydown", (e) => {
  if (e.key === "Enter") playOne();
});
text.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) playOne();
});
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("setting").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
});

loadVoices().catch((err) => setStatus(`Could not load voices: ${err.message}`));
