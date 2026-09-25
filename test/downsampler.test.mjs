/* The content-side resampler: every page rate must come out as 16 kHz, in
 * pieces that join up seamlessly. Run with: npm test */
import { readFileSync } from "node:fs";

eval(readFileSync("extension/content/shared.js", "utf8"));
const { Downsampler } = globalThis.LiveCaption;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

/** One second of a 440 Hz tone at `rate`, fed through in 4096-sample blocks
 * as the ScriptProcessor delivers it. */
function run(rate) {
  const ds = new Downsampler(rate);
  const input = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
  const parts = [];
  for (let i = 0; i < input.length; i += 4096) parts.push(ds.process(input.subarray(i, i + 4096)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Largest gap between the output and the ideal 16 kHz tone. */
function error(out) {
  let worst = 0;
  for (let i = 0; i < out.length; i++) {
    worst = Math.max(worst, Math.abs(out[i] - Math.sin((2 * Math.PI * 440 * i) / 16000)));
  }
  return worst;
}

for (const rate of [8000, 11025, 16000, 22050, 44100, 48000]) {
  const out = run(rate);
  check(`${rate} Hz becomes one second at 16 kHz`, Math.abs(out.length - 16000) <= 2, `${out.length} samples`);
  // A box filter over the source period smears a 440 Hz tone a little at
  // high rates; interpolation is exact at the source samples. Either way the
  // speech must come out at the right pitch and speed.
  const e = error(out);
  check(`${rate} Hz keeps the tone in step`, e < 0.1, e.toFixed(3));
}

console.log(failures ? `\n${failures} FAILED` : "\nall downsampler checks passed");
process.exitCode = failures ? 1 : 0;
