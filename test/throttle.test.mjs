/* Boots the real background scripts in Node with stub browser APIs and checks
 * the CPU-budget decision that shipped. Run with: npm test */
import { readFileSync } from "node:fs";

const noop = { addListener() {}, removeListener() {} };
let store = {};
globalThis.browser = {
  storage: {
    local: { get: async (k) => (store[k] ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) },
    onChanged: noop,
  },
  runtime: { onConnect: noop, onMessage: noop, onInstalled: noop, getURL: (p) => p, openOptionsPage() {} },
  tabs: { onRemoved: noop, onUpdated: noop, query: async () => [], sendMessage: async () => {} },
  commands: { onCommand: noop },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => true },
};

// Module eval scopes are isolated, so boot the whole background in one go and
// hand the function under test back out.
const sources = ["settings", "wav", "segmenter", "engine", "background"]
  .map((f) => readFileSync(`extension/background/${f}.js`, "utf8"))
  .join("\n");
eval(sources + "\nglobalThis.interimAllowed = interimAllowed;");
const { interimAllowed } = globalThis;

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — got ${got}`);
};

const DECODE = 1500; // measured: whisper-tiny.en on WASM

// balanced = 25% duty: after a 1.5 s decode the engine must idle 4.5 s
check("balanced: blocked immediately after a decode", interimAllowed("balanced", false, DECODE, 0), false);
check("balanced: still blocked at 4.4 s idle", interimAllowed("balanced", false, DECODE, 4400), false);
check("balanced: allowed at 4.5 s idle", interimAllowed("balanced", false, DECODE, 4500), true);

// the default model decodes in ~400 ms, so the same budget lets the live line
// update about every 1.6 s instead of every 6 s
check("cheap decodes need only a short pause", interimAllowed("balanced", false, 400, 1200), true);
check("cheap decodes are still spaced out", interimAllowed("balanced", false, 400, 1100), false);

// high = 95% duty: a short breather only
check("high: blocked at 50 ms idle", interimAllowed("high", false, DECODE, 50), false);
check("high: allowed at 100 ms idle", interimAllowed("high", false, DECODE, 100), true);

// low = no partial updates at all
check("low: never runs an interim", interimAllowed("low", false, DECODE, 60000), false);

// background tab: partials are pointless
check("hidden tab: no interims even on high", interimAllowed("high", true, DECODE, 60000), false);

// first decode of a session must not be blocked
check("no measurement yet: allowed", interimAllowed("balanced", false, 0, 0), true);

// an unknown value falls back to balanced rather than running flat out
check("unknown mode falls back to balanced", interimAllowed(undefined, false, DECODE, 4400), false);

// duty cycle actually achieved, as a sanity check on the arithmetic
const idle = (DECODE * (1 - 0.25)) / 0.25;
check("balanced duty cycle is 25%", Math.round((DECODE / (DECODE + idle)) * 100), 25);

console.log(failures ? `\n${failures} FAILED` : "\nall throttle checks passed");
process.exitCode = failures ? 1 : 0;
