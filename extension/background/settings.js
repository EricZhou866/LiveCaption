/* Settings storage with defaults. Loaded first in the background scripts. */
"use strict";

var LCSettings = (function () {
  const DEFAULTS = {
    debug: false,           // log pipeline events to the browser console
    enabled: true,          // master switch
    autoStart: true,        // show captions as soon as audio plays
    engine: "local",        // local | remote
    // tiny.en decodes a 30 s Whisper window in ~1.6 s on WASM, which is what
    // keeps captions close to real time; base.en is ~2x slower but sharper.
    model: "onnx-community/whisper-tiny.en",
    dtype: "q8",            // q4 | q8 | fp16 | fp32
    device: "wasm",         // wasm | webgpu
    language: "en",
    task: "transcribe",     // transcribe | translate (into English)
    remote: { url: "", apiKey: "", model: "whisper-1" },
    vad: {
      threshold: 0.010,     // absolute RMS floor for "this is speech"
      silenceMs: 600,       // pause that ends an utterance
      minSpeechMs: 300,
      maxUtteranceMs: 12000,
      interimMs: 1100,      // how often a partial re-decode runs
      prerollMs: 320,
    },
    ui: {
      fontSize: 20,
      maxLines: 3,
      opacity: 0.88,
      theme: "dark",
      position: null,
    },
  };

  let cache = null;
  const listeners = new Set();

  function merge(base, override) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(override || {})) {
      out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && base[k]
        ? merge(base[k], v)
        : v;
    }
    return out;
  }

  async function get() {
    if (cache) return cache;
    const stored = await browser.storage.local.get("settings");
    cache = merge(DEFAULTS, stored.settings || {});
    return cache;
  }

  async function set(patch) {
    const next = merge(await get(), patch);
    cache = next;
    await browser.storage.local.set({ settings: next });
    for (const fn of listeners) {
      try { fn(next); } catch (err) { console.error(err); }
    }
    return next;
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    cache = merge(DEFAULTS, changes.settings.newValue || {});
    for (const fn of listeners) {
      try { fn(cache); } catch (err) { console.error(err); }
    }
  });

  return { DEFAULTS, get, set, onChange: (fn) => listeners.add(fn) };
})();
