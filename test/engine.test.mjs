/* The recogniser must never get stuck: a request that never answers, a model
 * switch in the middle of a decode, and WebGPU failing or stalling must all
 * leave captions working. Drives the real LocalEngine against a scripted
 * fake worker. Run with: npm test */
import { readFileSync } from "node:fs";
import { loadOptions, decodeOptions } from "../extension/background/asr-options.js";

const noop = { addListener() {}, removeListener() {} };
globalThis.browser = {
  storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: noop },
  runtime: { onConnect: noop, onMessage: noop, onInstalled: noop, getURL: (p) => p, openOptionsPage() {} },
  tabs: { onRemoved: noop, onUpdated: noop, query: async () => [], sendMessage: async () => {} },
  commands: { onCommand: noop },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => false },
};

/* A worker whose answers each scenario scripts. */
class FakeWorker {
  constructor() { FakeWorker.all.push(this); this.terminated = false; this.seen = []; }
  postMessage(msg) {
    this.seen.push(msg);
    const answer = FakeWorker.script(msg, this);
    if (answer === "hang") return;
    setTimeout(() => !this.terminated && this.onmessage({ data: { id: msg.id, ...answer } }), 1);
  }
  terminate() { this.terminated = true; }
}
FakeWorker.all = [];
globalThis.Worker = FakeWorker;

const sources = ["settings", "wav", "segmenter", "engine", "transcript", "background"]
  .map((f) => readFileSync(`extension/background/${f}.js`, "utf8"))
  .join("\n");
eval(sources + "\nglobalThis.__e = { LocalEngine };");
const { LocalEngine } = globalThis.__e;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
/** Settle within ms, or report that it would have hung. */
const within = (ms, p) =>
  Promise.race([
    p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: e.message })),
    new Promise((r) => setTimeout(() => r({ hung: true }), ms)),
  ]);

const answer = (msg) =>
  msg.type === "load" ? { type: "ready" } : { type: "result", text: `heard on ${msg.device}` };
const pcm = () => new Float32Array(16000 * 3);
const cpu = { model: "onnx-community/whisper-base.en", dtype: "q8", device: "wasm" };
const gpu = { ...cpu, device: "webgpu" };

/* 1. a decode that never answers */
{
  const statuses = [];
  const eng = new LocalEngine((s) => statuses.push(s));
  eng.timeouts = { load: 500, firstDecode: 150, decode: 150 };
  FakeWorker.script = (msg) => (msg.type === "transcribe" ? "hang" : answer(msg));
  const r = await within(2000, eng.transcribe(pcm(), cpu, { force: true }));
  check("a stalled decode is abandoned instead of hanging", !r.hung && !r.ok, r.hung ? "still waiting after 2 s" : r.e);
  check("the engine is free again afterwards", eng.busy === false);
  check("the stuck worker is thrown away", FakeWorker.all.at(-1).terminated);
  FakeWorker.script = answer;
  const next = await within(2000, eng.transcribe(pcm(), cpu, { force: true }));
  check("the next sentence is captioned normally", next.ok && next.v === "heard on wasm", JSON.stringify(next));
}

/* 2. switching model in the middle of a decode (the reported bug) */
{
  const eng = new LocalEngine(() => {});
  eng.timeouts = { load: 60000, firstDecode: 60000, decode: 60000 }; // no watchdog rescue
  FakeWorker.script = (msg) => (msg.type === "transcribe" ? "hang" : answer(msg));
  const inFlight = eng.transcribe(pcm(), cpu, { force: true });
  await new Promise((r) => setTimeout(r, 20));
  eng.reload(); // what changing the model in Settings does
  const first = await within(1000, inFlight);
  check("the decode in flight is released when the model changes", !first.hung, first.hung ? "never settled" : first.e);
  FakeWorker.script = answer;
  const later = await within(2000, eng.transcribe(pcm(), { ...cpu, model: "onnx-community/moonshine-tiny-ONNX" }, { force: true }));
  check("captions keep working with the new model", later.ok && later.v === "heard on wasm",
        later.hung ? "queued behind the lost decode for ever" : JSON.stringify(later));
}

/* 3. WebGPU not available in this Firefox */
{
  const statuses = [];
  const eng = new LocalEngine((s) => statuses.push(s));
  FakeWorker.script = (msg) =>
    msg.type === "load" && msg.device === "webgpu"
      ? { type: "error", message: "WebGPU is not available in this Firefox" }
      : answer(msg);
  const r = await within(2000, eng.transcribe(pcm(), gpu, { force: true }));
  check("with no WebGPU the phrase is still captioned, on the CPU", r.ok && r.v === "heard on wasm", JSON.stringify(r));
  check("the user is told once", statuses.filter((s) => /WebGPU didn't work/.test(s.text || "")).length === 1);
  const again = await within(2000, eng.transcribe(pcm(), gpu, { force: true }));
  check("later phrases go straight to the CPU", again.ok && again.v === "heard on wasm" &&
        statuses.filter((s) => /WebGPU didn't work/.test(s.text || "")).length === 1);
  eng.reload();
  check("changing settings gives WebGPU another chance", eng.forceWasm === false);
}

/* 4. WebGPU loads but stalls on the first decode */
{
  const eng = new LocalEngine(() => {});
  eng.timeouts = { load: 500, firstDecode: 150, decode: 150 };
  FakeWorker.script = (msg) => (msg.type === "transcribe" && msg.device === "webgpu" ? "hang" : answer(msg));
  const r = await within(3000, eng.transcribe(pcm(), gpu, { force: true }));
  check("a WebGPU stall falls back and captions the same phrase", r.ok && r.v === "heard on wasm", JSON.stringify(r));
  const retry = FakeWorker.all.at(-1).seen.find((m) => m.type === "transcribe");
  check("the retry gets the audio, not an emptied buffer", retry && retry.audio.length === 16000 * 3,
        retry ? retry.audio.length + " samples" : "no retry");
}

/* 5. precision on WebGPU, and per-model decode options */
{
  const g = loadOptions("q8", "webgpu");
  check("int8 is never sent to WebGPU", g.device === "webgpu" &&
        JSON.stringify(g.dtype) === JSON.stringify({ encoder_model: "fp32", decoder_model_merged: "q4" }), JSON.stringify(g));
  check("fp16 is kept on WebGPU", loadOptions("fp16", "webgpu").dtype === "fp16");
  check("the CPU keeps the chosen precision", loadOptions("q8", "wasm").dtype === "q8" && loadOptions("fp32", "wasm").dtype === "fp32");
  const moon = decodeOptions("onnx-community/moonshine-tiny-ONNX", "en", "transcribe");
  check("Moonshine gets no Whisper-only options", !("chunk_length_s" in moon) && !("language" in moon));
  const multi = decodeOptions("onnx-community/whisper-base", "de", "translate");
  check("multilingual Whisper gets language and task", multi.language === "de" && multi.task === "translate");
}

console.log(failures ? `\n${failures} FAILED` : "\nall engine checks passed");
process.exit(failures ? 1 : 0);
