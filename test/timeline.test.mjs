/* Drives the shipped segmenter + CPU-budget logic with the real test clip on a
 * virtual clock, and reports what the recogniser would actually have done. */
import { readFileSync } from "node:fs";

const noop = { addListener() {}, removeListener() {} };
let store = {};
globalThis.browser = {
  storage: { local: { get: async () => ({}), set: async (o) => Object.assign(store, o) }, onChanged: noop },
  runtime: { onConnect: noop, onMessage: noop, onInstalled: noop, getURL: (p) => p, openOptionsPage() {} },
  tabs: { onRemoved: noop, onUpdated: noop, query: async () => [], sendMessage: async () => {} },
  commands: { onCommand: noop },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true },
};

// virtual clock so a 19 s clip runs instantly and deterministically
let NOW = 1_000_000;
const realNow = Date.now;
Date.now = () => NOW;

const sources = ["settings", "wav", "segmenter", "engine", "background"]
  .map((f) => readFileSync(`extension/background/${f}.js`, "utf8"))
  .join("\n");
eval(sources + "\nglobalThis.__x = { interimAllowed, Segmenter, LCSettings };");
const { interimAllowed, Segmenter, LCSettings } = globalThis.__x;

/* --- real audio: test/speech.wav is 44.1 kHz 16-bit mono --- */
const wav = readFileSync("test/speech.wav");
const srcRate = wav.readUInt32LE(24);
const pcm16 = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
const ratio = srcRate / 16000;
const out = new Float32Array(Math.floor(pcm16.length / ratio));
for (let i = 0; i < out.length; i++) {
  const start = Math.floor(i * ratio), end = Math.floor((i + 1) * ratio);
  let sum = 0;
  for (let j = start; j < end; j++) sum += pcm16[j] / 0x8000;
  out[i] = sum / Math.max(1, end - start);
}
const DECODE_MS = 1500; // measured: whisper-tiny.en, 30 s window, WASM

/** A long listening session: the real clip back to back. A synthetic tone will
 * not do — the VAD's adaptive noise floor correctly learns to ignore one. */
function longSession(times) {
  const buf = new Float32Array(out.length * times);
  for (let i = 0; i < times; i++) buf.set(out, i * out.length);
  return buf;
}

function run(mode, hidden = false, audio = out) {
  const settings = LCSettings.DEFAULTS;
  let busyUntil = 0, lastDecodeEnd = 0, busyTotal = 0;
  const log = { interims: 0, finals: 0, skipped: 0 };

  const decode = (final) => {
    if (!final) {
      // partial updates are dropped when the engine is busy or over budget
      if (NOW < busyUntil) { log.skipped++; return; }
      if (!interimAllowed(mode, hidden, DECODE_MS, NOW - lastDecodeEnd)) { log.skipped++; return; }
    }
    // finals queue behind whatever is running: a committed line is never lost
    const start = Math.max(NOW, busyUntil);
    busyUntil = start + DECODE_MS;
    lastDecodeEnd = busyUntil;
    busyTotal += DECODE_MS;
    if (final) log.finals++; else log.interims++;
  };

  const seg = new Segmenter(settings.vad, { onInterim: () => decode(false), onFinal: () => decode(true) });

  const CHUNK = 8000; // the 500 ms messages the content script sends
  const t0 = NOW;
  for (let off = 0; off < audio.length; off += CHUNK) {
    seg.push(audio.subarray(off, Math.min(off + CHUNK, audio.length)));
    NOW += 500; // audio arrives in real time
  }
  seg.flush();
  const wall = NOW - t0;
  return { mode, hidden, ...log, duty: Math.round((busyTotal / wall) * 100) };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const clip = (out.length / 16000).toFixed(1);
console.log(`clip: ${clip}s of real speech, decode cost ${DECODE_MS} ms per update\n`);

const high = run("high");
const balanced = run("balanced");
const low = run("low");
const background = run("balanced", true);
for (const r of [high, balanced, low, background]) {
  console.log(
    `  ${r.mode}${r.hidden ? " (tab hidden)" : ""}`.padEnd(26) +
    `duty ${String(r.duty).padStart(3)}%   interims ${r.interims}   finals ${r.finals}   skipped ${r.skipped}`
  );
}
console.log();

const talk = longSession(4); // ~75 s
const talkHigh = run("high", false, talk);
const talkBalanced = run("balanced", false, talk);
const talkLow = run("low", false, talk);
console.log("75s listening session (the clip, four times over):");
for (const r of [talkHigh, talkBalanced, talkLow]) {
  console.log(
    `  ${r.mode}`.padEnd(26) +
    `duty ${String(r.duty).padStart(3)}%   interims ${r.interims}   finals ${r.finals}   skipped ${r.skipped}`
  );
}
console.log();

check("1.0.0 keeps the recogniser busy most of the time", talkHigh.duty >= 55, `${talkHigh.duty}%`);
check("balanced brings it under half", talkBalanced.duty <= 45, `${talkBalanced.duty}%`);
check("balanced still updates the live line", talkBalanced.interims > 0, `${talkBalanced.interims} partial updates`);
check("low mode runs no partial updates", talkLow.interims === 0 && low.interims === 0);
check("hidden tab runs no partial updates", background.interims === 0);
check("no committed line is lost, whatever the budget",
      balanced.finals === high.finals && low.finals === high.finals && background.finals === high.finals &&
      talkBalanced.finals === talkHigh.finals && talkLow.finals === talkHigh.finals,
      `${high.finals} lines on the clip, ${talkHigh.finals} on continuous speech, in every mode`);
check("balanced cuts the work substantially",
      talkBalanced.duty <= talkHigh.duty * 0.75, `${talkHigh.duty}% -> ${talkBalanced.duty}%`);
check("low mode is a big step down again", talkLow.duty <= talkBalanced.duty * 0.6,
      `${talkBalanced.duty}% -> ${talkLow.duty}%`);

Date.now = realNow;
console.log(failures ? `\n${failures} FAILED` : "\nall timeline checks passed");
process.exitCode = failures ? 1 : 0;
