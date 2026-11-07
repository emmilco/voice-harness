/**
 * Decides what an interruption of the agent's speech means. Acknowledgements
 * ("mm-hmm", "yeah", "okay") and explicit continuations ("go on") resume the
 * speech; an empty transcript (a cough, a noise) resumes too. Anything else is
 * a new user turn.
 */
export type InterruptionAction = "resume" | "newTurn";

const RESUME_PHRASES = new Set([
  "go on",
  "continue",
  "keep going",
  "carry on",
  "go ahead",
  "please continue",
  "sorry go on",
  "sorry continue",
  "got it",
  "i see",
  "uh huh",
  "mm hmm",
]);

const ACK_WORDS = new Set(["mm", "mmm", "hmm", "mhm", "mm-hmm", "uh", "huh", "yeah", "yes", "yep", "ok", "okay", "right", "sure", "oh", "ah", "cool", "nice", "great", "alright"]);

export function classifyInterruption(transcript: string): InterruptionAction {
  const norm = transcript
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return "resume";
  if (RESUME_PHRASES.has(norm)) return "resume";
  const words = norm.split(" ");
  if (words.length <= 3 && words.every((w) => ACK_WORDS.has(w))) return "resume";
  return "newTurn";
}
