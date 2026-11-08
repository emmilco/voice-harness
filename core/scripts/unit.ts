// Unit tests for the pure speech logic: `npm run unit -w core`.
import assert from "node:assert/strict";
import { SpeechChunker, StepSequencer, classifyInterruption } from "../src/index";

function speakAll(chunks: string[]): string[] {
  const c = new SpeechChunker();
  const out: string[] = [];
  for (const ch of chunks) out.push(...c.push(ch));
  out.push(...c.flush());
  return out;
}

const cases: [string, () => void][] = [
  ["sentence released before the line ends", () => {
    const c = new SpeechChunker();
    assert.deepEqual(c.push("The loss is computed here. Then"), ["The loss is computed here."]);
    assert.deepEqual(c.push(" we average it."), []);
    assert.deepEqual(c.flush(), ["Then we average it."]);
  }],
  ["streamed one character at a time", () => {
    const text = "First sentence. Second one!\nThird line?\n";
    assert.deepEqual(speakAll([...text]), ["First sentence.", "Second one!", "Third line?"]);
  }],
  ["onscreen and code fences are never spoken", () => {
    const text = "```onscreen\n[Mode: Direct | Project: x]\nSecret line.\n```\nSpoken prose here.\n```python\nx = 1.\n```\nMore prose.";
    assert.deepEqual(speakAll([text]), ["Spoken prose here.", "More prose."]);
  }],
  ["fence split across chunks", () => {
    assert.deepEqual(speakAll(["Before. ", "``", "`onscr", "een\nhidden.\n``", "`\nAfter."]), ["Before.", "After."]);
  }],
  ["inline code made pronounceable, markdown stripped", () => {
    assert.deepEqual(speakAll(["**Note:** call `loss_fn` on `logits.view()` — see [docs](http://x.y).\n"]), [
      "Note: call loss fn on logits dot view — see docs.",
    ]);
  }],
  ["file names and snake_case outside code", () => {
    assert.deepEqual(speakAll(["The loss is in tiny_gpt.py at line 25.\n"]), ["The loss is in tiny gpt dot py at line 25."]);
  }],
  ["decimals and list bullets", () => {
    assert.deepEqual(speakAll(["- Learning rate is 3.5 times higher.\n- Second item\n"]), ["Learning rate is 3.5 times higher.", "Second item"]);
  }],
  ["tables skipped", () => {
    assert.deepEqual(speakAll(["| a | b |\n|---|---|\n| 1 | 2 |\nAfter the table.\n"]), ["After the table."]);
  }],
  ["paragraph break ends a fragment", () => {
    assert.deepEqual(speakAll(["A heading without period\n\nBody text."]), ["A heading without period", "Body text."]);
  }],
  ["long first sentence of a turn split at its first comma", () => {
    const long = "The model returns logits with three dimensions, batch and time and vocabulary, so we flatten them first.";
    assert.deepEqual(speakAll([long + " Then the loss is averaged over every position in the batch."]), [
      "The model returns logits with three dimensions,",
      "batch and time and vocabulary, so we flatten them first.",
      "Then the loss is averaged over every position in the batch.",
    ]);
  }],
  ["short first sentence and later long sentences not split", () => {
    const later = "This later sentence is also rather long, with a comma in it, but only the first sentence of a turn is split.";
    assert.deepEqual(speakAll(["Short one. " + later]), ["Short one.", later]);
  }],
  ["steps in order pass straight through", () => {
    const out: string[] = [];
    const seq = new StepSequencer<string>((s) => out.push(s));
    seq.push("a", 1);
    seq.push("b", 2);
    seq.push("c", 3);
    assert.deepEqual(out, ["a", "b", "c"]);
  }],
  ["early step held until the gap fills", () => {
    const out: string[] = [];
    const seq = new StepSequencer<string>((s) => out.push(s));
    seq.push("a", 1);
    seq.push("c", 3);
    assert.deepEqual(out, ["a"]);
    seq.push("b", 2);
    assert.deepEqual(out, ["a", "b", "c"]);
    seq.reset();
  }],
  ["step 1 starts a new walkthrough; unnumbered steps pass", () => {
    const out: string[] = [];
    const seq = new StepSequencer<string>((s) => out.push(s));
    seq.push("a", 1);
    seq.push("b", 2);
    seq.push("x");
    seq.push("A", 1);
    seq.push("B", 2);
    assert.deepEqual(out, ["a", "b", "x", "A", "B"]);
  }],
  ["interruption policy", () => {
    for (const t of ["", "mm-hmm", "Yeah.", "okay okay", "Go on.", "uh huh", "Got it", "right"]) assert.equal(classifyInterruption(t), "resume", t);
    for (const t of ["wait, why the square root?", "stop", "no, the other file", "yeah but what about the mask"]) assert.equal(classifyInterruption(t), "newTurn", t);
  }],
];

const asyncCases: [string, () => Promise<void>][] = [
  ["held steps released in order after the wait", async () => {
    const out: string[] = [];
    const seq = new StepSequencer<string>((s) => out.push(s), 50);
    seq.push("a", 1);
    seq.push("d", 4);
    seq.push("c", 3);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(out, ["a", "c", "d"]);
    seq.push("e", 5);
    assert.deepEqual(out, ["a", "c", "d", "e"]);
  }],
];

let failed = 0;
for (const [name, fn] of asyncCases) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message.split("\n").join("\n     ")}`);
  }
}
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${(err as Error).message.split("\n").join("\n     ")}`);
  }
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
