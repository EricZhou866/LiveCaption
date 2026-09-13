/* Zips extension/ into web-ext-artifacts/live-caption-<version>.xpi */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "extension", "manifest.json"), "utf8"));
const outDir = join(root, "web-ext-artifacts");
mkdirSync(outDir, { recursive: true });

const xpi = join(outDir, `local-live-captions-${manifest.version}.xpi`);
rmSync(xpi, { force: true });
execFileSync("zip", ["-qr9", "-X", xpi, ".", "-x", ".*"], { cwd: join(root, "extension") });
console.log(`${xpi}  (${(statSync(xpi).size / 1048576).toFixed(1)} MB)`);
