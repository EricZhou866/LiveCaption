/* Settings storage: defaults, per-key merge, and the upgrade migration that
 * moves users off the slow default model. Run with: npm test */
import { readFileSync } from "node:fs";

let store = {};
globalThis.browser = {
  storage: {
    local: { get: async (k) => (store[k] ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) },
    onChanged: { addListener() {} },
  },
};
eval(readFileSync("extension/background/settings.js", "utf8") + "\nglobalThis.LCSettings = LCSettings;");
const { LCSettings } = globalThis;

let failures = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — got ${JSON.stringify(got)}`);
};

const d = await LCSettings.DEFAULTS;
eq("default model is the fast one", d.model, "onnx-community/moonshine-tiny-ONNX");
eq("default CPU budget", d.cpu, "balanced");
eq("default linger is 5 s", d.ui.autoHideMs, 5000);
eq("no stored size by default", d.ui.size, null);

let next = await LCSettings.set({ ui: { autoHideMs: 0 } });
eq("linger can be set to never", next.ui.autoHideMs, 0);
eq("other ui settings survive", next.ui.fontSize, 20);
next = await LCSettings.set({ ui: { size: { width: 420, height: 220 } } });
eq("size persists", next.ui.size, { width: 420, height: 220 });
next = await LCSettings.set({ ui: { size: null } });
eq("reset size clears it", next.ui.size, null);

/* --- upgrade migration --- */
const boot = async (stored) => {
  store = stored ? { settings: stored } : {};
  eval(readFileSync("extension/background/settings.js", "utf8") + "\nglobalThis.LC2 = LCSettings;");
  return globalThis.LC2;
};

let S = await boot({ schema: undefined, model: "onnx-community/whisper-tiny.en", ui: { fontSize: 28 } });
let after = await S.migrate();
eq("1.0.0 user on the old default is moved to the fast model", after.model, "onnx-community/moonshine-tiny-ONNX");
eq("their other settings are untouched", after.ui.fontSize, 28);

S = await boot({ schema: undefined, model: "onnx-community/whisper-small" });
after = await S.migrate();
eq("a deliberate model choice is left alone", after.model, "onnx-community/whisper-small");

// What 1.0/1.1 really left in storage: no schema key at all, not an undefined one.
S = await boot({ model: "onnx-community/whisper-tiny.en", ui: { fontSize: 28 } });
after = await S.migrate();
eq("a stored object without a schema key is migrated too", after.model, "onnx-community/moonshine-tiny-ONNX");
eq("...and marked as migrated", store.settings.schema, 2);

S = await boot(null);
after = await S.migrate();
eq("a fresh install needs no migration", after.model, "onnx-community/moonshine-tiny-ONNX");

S = await boot({ schema: 2, model: "onnx-community/whisper-tiny.en" });
after = await S.migrate();
eq("migration does not run twice", after.model, "onnx-community/whisper-tiny.en");

/* --- recommended settings --- */
S = await boot(null);
const R = S.RECOMMENDED;
eq("recommended model is moonshine-tiny", R.model, "onnx-community/moonshine-tiny-ONNX");
eq("recommended precision is int8", R.dtype, "q8");
eq("recommended compute is the CPU", R.device, "wasm");
eq("recommended budget is balanced", R.cpu, "balanced");
eq("a fresh install is on the recommended settings", S.isRecommended(await S.get()), true);

// the configuration from the report
let custom = await S.set({ model: "onnx-community/whisper-base.en", device: "webgpu",
                           ui: { fontSize: 30 }, transcript: true, streamClone: false,
                           vad: { interimMs: 600 } });
eq("whisper-base.en on WebGPU is not the recommended set", S.isRecommended(custom), false);
after = await S.set(JSON.parse(JSON.stringify(R)));
eq("one click puts every speed setting back", S.isRecommended(after), true);
eq("...including the timing", after.vad.interimMs, S.DEFAULTS.vad.interimMs);
eq("...but keeps the user's own text size", after.ui.fontSize, 30);
eq("...their transcript choice", after.transcript, true);
eq("...and their stream-fallback choice", after.streamClone, false);

console.log(failures ? `\n${failures} FAILED` : "\nall settings checks passed");
process.exitCode = failures ? 1 : 0;
