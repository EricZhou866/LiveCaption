/* Builds web-ext-artifacts/source-<version>.zip for AMO's source-code review.
 *
 * It archives the committed tree (git archive HEAD), so it refuses to run
 * unless what is committed is exactly what gets built: a clean working tree,
 * and the manifest in HEAD at the version being released. Running it before
 * committing once shipped a source archive one version behind its add-on. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const fail = (msg) => {
  console.error(`source archive not built: ${msg}`);
  process.exit(1);
};

const dirty = git("status", "--porcelain", "--", ".", ":(exclude)web-ext-artifacts").trim();
if (dirty) fail(`commit these first, the archive is taken from HEAD:\n${dirty}`);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const headManifest = JSON.parse(git("show", "HEAD:extension/manifest.json"));
if (headManifest.version !== version) {
  fail(`HEAD's manifest is ${headManifest.version} but package.json says ${version}`);
}

mkdirSync(join(root, "web-ext-artifacts"), { recursive: true });
const out = join("web-ext-artifacts", `source-${version}.zip`);
git("archive", "--format=zip", "-o", out, "HEAD");
console.log(`${out}  (HEAD ${git("rev-parse", "--short", "HEAD").trim()}, manifest ${headManifest.version})`);
