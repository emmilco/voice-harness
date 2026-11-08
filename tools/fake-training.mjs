// Appends a noisy, falling loss to a JSON Lines file twice a second, for trying live charts.
//
//   node tools/fake-training.mjs [file] [steps]     default: runs/loss.jsonl, 120 steps
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const file = process.argv[2] ?? "runs/loss.jsonl";
const steps = Number(process.argv[3] ?? 120);
mkdirSync(path.dirname(file), { recursive: true });
let step = 0;
const timer = setInterval(() => {
  step++;
  const loss = 1.4 + 3 * Math.exp(-step / 30) + (Math.random() - 0.5) * 0.15;
  appendFileSync(file, JSON.stringify({ step, loss: Number(loss.toFixed(4)) }) + "\n");
  if (step >= steps) clearInterval(timer);
}, 500);
console.log(`writing ${steps} steps to ${file}`);
