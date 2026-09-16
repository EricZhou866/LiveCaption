/* Settings storage with defaults. Loaded first in the background scripts. */
"use strict";

var LCSettings = (function () {
  const SCHEMA = 2; // bump when a stored value needs rewriting on upgrade

  const DEFAULTS = {
    schema: SCHEMA,
    debug: false,           // log pipeline events to the browser console
    enabled: true,          // master switch
    autoStart: true,        // show captions as soon as audio plays
    cpu: "balanced",        // high | balanced | low — how hard the recogniser runs
    engine: "local",        // local | remote
    // Moonshine's cost follows the length of the audio instead of Whisper's
    // fixed 30 s window: ~0.05x real time against ~0.36x for whisper-tiny.en
    // on a 4 s phrase, for the same transcript.
    model: "onnx-community/moonshine-tiny-ONNX",
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
      position: null,      // {left, top} once the panel has been dragged
      size: null,          // {width, height} once the panel has been resized
      autoHideMs: 5000,    // how long the panel lingers after the last caption; 0 = never
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

  /** Users who never touched the model picker are still on the old default,
   * which is the slow one — the reason Firefox flagged the add-on. Move them
   * across on upgrade, and leave a deliberate choice alone. */
  async function migrate() {
    const current = await get();
    if (current.schema >= SCHEMA) return current;
    const patch = { schema: SCHEMA };
    if (current.model === "onnx-community/whisper-tiny.en") patch.model = DEFAULTS.model;
    return set(patch);
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    cache = merge(DEFAULTS, changes.settings.newValue || {});
    for (const fn of listeners) {
      try { fn(cache); } catch (err) { console.error(err); }
    }
  });

  return { DEFAULTS, get, set, migrate, onChange: (fn) => listeners.add(fn) };
})();
