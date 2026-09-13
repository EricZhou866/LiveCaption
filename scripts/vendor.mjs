/* Copies the third-party runtime (transformers.js + onnxruntime-web wasm)
 * from node_modules into extension/vendor/ so the add-on ships everything it
 * needs and never loads code from a CDN. */
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "extension", "vendor");
mkdirSync(out, { recursive: true });

const tf = join(root, "node_modules", "@huggingface", "transformers", "dist");

const files = [
  // transformers.min.js is the fully bundled build (onnxruntime included);
  // transformers.web.min.js leaves onnxruntime-web as a bare import that a
  // module worker cannot resolve.
  [join(tf, "transformers.min.js"), "transformers.min.js"],
  // The wasm binary is the only piece fetched at runtime. jsep = the build with
  // WebGPU support, which the bundled loader expects.
  [join(tf, "ort-wasm-simd-threaded.jsep.wasm"), "ort-wasm-simd-threaded.jsep.wasm"],
];

let total = 0;
for (const [src, name] of files) {
  copyFileSync(src, join(out, name));
  const size = statSync(src).size;
  total += size;
  console.log(`  ${name.padEnd(40)} ${(size / 1048576).toFixed(1)} MB`);
}
console.log(`vendored ${files.length} files, ${(total / 1048576).toFixed(1)} MB -> extension/vendor/`);
