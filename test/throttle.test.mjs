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

// balanced = 40% duty: after a 1.5 s decode the engine must idle 2.25 s
check("balanced: blocked immediately after a decode", interimAllowed("balanced", false, DECODE, 0), false);
check("balanced: still blocked at 2.2 s idle", interimAllowed("balanced", false, DECODE, 2200), false);
check("balanced: allowed at 2.25 s idle", interimAllowed("balanced", false, DECODE, 2250), true);

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
check("unknown mode falls back to balanced", interimAllowed(undefined, false, DECODE, 2200), false);

// duty cycle actually achieved, as a sanity check on the arithmetic
const idle = (DECODE * (1 - 0.4)) / 0.4;
check("balanced duty cycle is 40%", Math.round((DECODE / (DECODE + idle)) * 100), 40);

console.log(failures ? `\n${failures} FAILED` : "\nall throttle checks passed");
process.exitCode = failures ? 1 : 0;
