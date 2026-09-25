/* PRIVACY.md -> docs/amo/privacy-policy.txt: the same policy as plain text for
 * AMO's privacy-policy field, which does not render Markdown tables or
 * emphasis. Keeps one source of truth for the policy. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(root, "PRIVACY.md"), "utf8");

const inline = (s) =>
  s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
   .replace(/`([^`]+)`/g, "$1").replace(/_(Last updated: [^_]+)_/g, "$1");

const out = [];
let tableHeader = null;
for (const raw of md.split("\n")) {
  const line = raw.trimEnd();
  if (/^\|\s*-/.test(line)) continue; // table separator
  if (line.startsWith("|")) {
    const cells = line.split("|").slice(1, -1).map((c) => inline(c.trim()));
    if (!tableHeader) { tableHeader = cells; continue; }
    out.push(cells.map((c, i) => `${tableHeader[i]}: ${c}`).join("\n"), "");
    continue;
  }
  tableHeader = null;
  if (line.startsWith("# ")) { out.push(inline(line.slice(2)).toUpperCase()); continue; }
  if (line.startsWith("## ")) { out.push(inline(line.slice(3)).toUpperCase()); continue; }
  out.push(inline(line));
}
// Undo the source's hard wrapping: a line that does not start a new block
// continues the previous one. AMO keeps newlines, so wrapped source text would
// otherwise show up as ragged paragraphs.
const startsBlock = (l) => l === "" || l.startsWith("- ") || /^[A-Z ,—-]+$/.test(l) || /^(When|Where|What is sent):/.test(l);
const joined = [];
for (const line of out) {
  const prev = joined.length ? joined[joined.length - 1] : "";
  if (!startsBlock(line.trim()) && prev !== "" && !/^[A-Z ,—-]+$/.test(prev)) {
    joined[joined.length - 1] = prev + " " + line.trim();
  } else {
    joined.push(line);
  }
}
const text = joined.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
mkdirSync(join(root, "docs", "amo"), { recursive: true });
writeFileSync(join(root, "docs", "amo", "privacy-policy.txt"), text);
console.log(`docs/amo/privacy-policy.txt  (${text.length} characters)`);
