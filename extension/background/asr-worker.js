/* Whisper inference worker (module worker, extension origin).
 * Everything here runs locally: no audio ever leaves the machine. */

import { pipeline, env } from "../vendor/transformers.min.js";

self.addEventListener("unhandledrejection", (e) =>
  console.error("[live-caption] worker rejection", (e.reason && e.reason.message) || e.reason)
);
env.allowLocalModels = false;
env.useBrowserCache = true;
// Serve onnxruntime's wasm from the add-on itself, never from a CDN: the
// extension CSP (script-src 'self') would block jsdelivr, which is where
// transformers.js points by default.
// Only the .wasm binary is overridden: onnxruntime's JS loader is already
// bundled inside transformers.min.js, and naming an "mjs" path here would make
// transformers.js re-publish that loader as a blob: URL, which the extension
// CSP (script-src 'self') refuses to import.
const VENDOR = new URL("../vendor/", import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = {
  wasm: VENDOR + "ort-wasm-simd-threaded.jsep.wasm",
};
// Extension pages are not cross-origin isolated, so SharedArrayBuffer threads
// are unavailable; ORT must stay single threaded.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let transcriber = null;
let loadedKey = null;
let loading = null;

function dtypeFor(preset) {
  switch (preset) {
    case "q4":
      return { encoder_model: "q8", decoder_model_merged: "q4" };
    case "fp16":
      return "fp16";
    case "fp32":
      return "fp32";
    case "q8":
    default:
      return "q8";
  }
}

async function load({ model, dtype, device }) {
  const key = `${model}|${dtype}|${device}`;
  if (loadedKey === key && transcriber) return transcriber;
  if (loading && loading.key === key) return loading.promise;

  if (transcriber) {
    try { await transcriber.dispose(); } catch (_) {}
    transcriber = null;
    loadedKey = null;
  }

  const promise = pipeline("automatic-speech-recognition", model, {
    dtype: dtypeFor(dtype),
    device: device === "webgpu" ? "webgpu" : "wasm",
    progress_callback: (p) => self.postMessage({ type: "progress", payload: p }),
  }).then((t) => {
    transcriber = t;
    loadedKey = key;
    loading = null;
    return t;
  }).catch((err) => {
    loading = null;
    throw err;
  });

  loading = { key, promise };
  return promise;
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      await load(msg);
      self.postMessage({ type: "ready", id: msg.id, key: loadedKey });
      return;
    }

    if (msg.type === "transcribe") {
      const model = await load(msg);
      const options = {
        chunk_length_s: 30,
        return_timestamps: false,
        max_new_tokens: 180,
        // Greedy decoding keeps latency predictable for live captioning.
        num_beams: 1,
        do_sample: false,
      };
      // English-only checkpoints reject explicit language/task arguments.
      if (!/\.en\b|\.en$/.test(msg.model)) {
        options.language = msg.language || "en";
        options.task = msg.task === "translate" ? "translate" : "transcribe";
      }
      const out = await model(msg.audio, options);
      const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text;
      self.postMessage({ type: "result", id: msg.id, text: (text || "").trim() });
      return;
    }

    if (msg.type === "unload") {
      if (transcriber) { try { await transcriber.dispose(); } catch (_) {} }
      transcriber = null;
      loadedKey = null;
      self.postMessage({ type: "unloaded", id: msg.id });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
