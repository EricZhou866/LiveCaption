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

S = await boot({ schema: 2, model: "onnx-community/whisper-tiny.en" });
after = await S.migrate();
eq("migration does not run twice", after.model, "onnx-community/whisper-tiny.en");

console.log(failures ? `\n${failures} FAILED` : "\nall settings checks passed");
process.exitCode = failures ? 1 : 0;
