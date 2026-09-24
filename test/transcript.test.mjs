/* Transcript feature: off by default, records only committed lines, formats
 * a readable file, produces a safe filename, forgets everything when switched
 * off. Boots the real background scripts. Run with: npm test */
import { readFileSync } from "node:fs";

const noop = { addListener() {}, removeListener() {} };
const changeListeners = [];
let store = {};
globalThis.browser = {
  storage: {
    local: { get: async (k) => (store[k] ? { [k]: store[k] } : {}), set: async (o) => Object.assign(store, o) },
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  },
  runtime: { onConnect: noop, onMessage: noop, onInstalled: noop, getURL: (p) => p, openOptionsPage() {} },
  tabs: { onRemoved: noop, onUpdated: noop, query: async () => [], sendMessage: async () => {},
          get: async () => ({ title: "WUNC | Fresh Air: 9/24", url: "https://www.wunc.org/" }) },
  commands: { onCommand: noop },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  permissions: { contains: async () => false },
};

const sources = ["settings", "wav", "segmenter", "engine", "transcript", "background"]
  .map((f) => readFileSync(`extension/background/${f}.js`, "utf8"))
  .join("\n");
eval(sources + `
globalThis.__t = { LCSettings, recordLine, formatTranscript, transcriptFilename,
                   saveTranscript, clearTranscripts, getSession, TRANSCRIPT_MAX_LINES,
                   decode, LocalEngine };`);
const T = globalThis.__t;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

check("off by default", T.LCSettings.DEFAULTS.transcript === false);

/* formatting */
const base = new Date(2026, 8, 24, 14, 3, 7).getTime();
const lines = [
  { at: base, text: "And we know also that there's been a weaponization of trade," },
  { at: base + 4000, text: "and in these circumstances we know that." },
];
const out = T.formatTranscript(lines, { title: "Fresh Air", url: "https://www.wunc.org/", savedAt: base + 60000 });
check("file starts with a readable header", out.startsWith("Local Live Captions — transcript\n"));
check("header names the page and the URL", out.includes("Page:  Fresh Air\n") && out.includes("URL:   https://www.wunc.org/\n"));
check("every caption line gets its wall-clock time", out.includes("[14:03:07] And we know") && out.includes("[14:03:11] and in these"));
check("line count is stated", out.includes("Lines: 2\n"));
check("non-ASCII survives untouched", T.formatTranscript([{ at: base, text: "字幕 — naïve" }]).includes("字幕 — naïve"));

/* filenames */
const name = T.transcriptFilename("WUNC | Fresh Air: 9/24", base);
check("filename has no characters an OS rejects", !/[\\/:*?"<>|]/.test(name), JSON.stringify(name));
check("filename carries the date and time", name.endsWith(" 2026-09-24_1403.txt"), JSON.stringify(name));
check("empty title still gives a usable name", T.transcriptFilename("", base) === "captions 2026-09-24_1403.txt");
check("long titles are cut to a sane length", T.transcriptFilename("x".repeat(300), base).length < 90);
check("no trailing dots before the date", !/\. \d{4}/.test(T.transcriptFilename("Episode 12...", base)));

/* recording */
const s = T.getSession(7);
T.recordLine(s, "one", base);
T.recordLine(s, "two", base + 1);
check("committed lines are kept in order", s.transcript.map((l) => l.text).join(",") === "one,two");
for (let i = 0; i < T.TRANSCRIPT_MAX_LINES + 5; i++) T.recordLine(s, "l" + i, base + i);
check("memory is bounded; oldest lines go first",
      s.transcript.length === T.TRANSCRIPT_MAX_LINES && s.transcript[0].text === "l5",
      s.transcript.length + " lines kept, first is " + s.transcript[0].text);

/* saving without the permission tells the user what to do */
const res = await T.saveTranscript(7);
check("saving without the downloads permission explains itself",
      !res.ok && /Allow downloads/.test(res.error), JSON.stringify(res));
const empty = await T.saveTranscript(999);
check("an empty tab has nothing to save", !empty.ok && /Nothing to save/.test(empty.error));

/* switching the feature off forgets everything */
T.recordLine(T.getSession(8), "private", base);
await T.LCSettings.set({ transcript: true });
await T.LCSettings.set({ transcript: false });
check("turning the feature off clears every tab's transcript",
      T.getSession(7).transcript.length === 0 && T.getSession(8).transcript.length === 0);

/* the real decode path: a committed line is kept only when the feature is on */
T.LocalEngine.prototype.transcribe = async () => "The weather in San Francisco is foggy.";
T.LocalEngine.prototype.warmup = async () => {};
const pcm = () => new Float32Array(16000);
const off = T.getSession(21);
await T.LCSettings.set({ transcript: false });
await T.decode(off, pcm(), 0.2, true);
check("feature off: a decoded sentence is shown but not kept", (off.transcript || []).length === 0);

const on = T.getSession(22);
await T.LCSettings.set({ transcript: true });
await T.decode(on, pcm(), 0.2, false);
check("feature on: partial updates are not kept", (on.transcript || []).length === 0);
await T.decode(on, pcm(), 0.2, true);
check("feature on: the committed sentence is kept", (on.transcript || []).length === 1);
await T.decode(on, pcm(), 0.2, true);
check("a repeated line is not kept twice", on.transcript.length === 1);

/* the save itself, with the permission granted */
let downloaded = null;
browser.permissions.contains = async () => true;
browser.downloads = {
  download: async (opts) => { downloaded = opts; return 42; },
  onChanged: { addListener() {}, removeListener() {} },
};
const saved = await T.saveTranscript(22);
check("save succeeds with the permission granted", saved.ok && saved.lines === 1, JSON.stringify(saved));
check("it goes straight to Downloads, no dialog, never overwriting",
      downloaded && downloaded.saveAs === false && downloaded.conflictAction === "uniquify");
check("the file is named after the page", downloaded && /^WUNC Fresh Air 9 24 \d{4}-\d{2}-\d{2}_\d{4}\.txt$/.test(downloaded.filename),
      downloaded && downloaded.filename);
check("it is handed over as a local blob, not fetched from anywhere",
      downloaded && downloaded.url.startsWith("blob:"));

console.log(failures ? `\n${failures} FAILED` : "\nall transcript checks passed");
// saveTranscript leaves a 60 s backstop timer to release the blob URL; that is
// right in a browser, but it would hold this process open for a minute.
process.exit(failures ? 1 : 0);
