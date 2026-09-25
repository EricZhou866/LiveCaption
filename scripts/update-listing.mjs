/* Updates the AMO listing's summary and description from docs/amo/listing-*.txt.
 *
 *   npm run listing:amo -- --dry-run   # show what would be sent, no credentials needed
 *   npm run listing:amo                # send it (needs WEB_EXT_API_KEY / WEB_EXT_API_SECRET)
 *
 * The English copy goes to the listing's default locale (read from AMO — this
 * listing's is en-CA, so patching en-US alone would leave the old text in place
 * for everyone else), and the Chinese copy to zh-CN. Credentials are read from
 * the environment only and never printed. */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://addons.mozilla.org/api/v5/addons/addon/";
const GUID = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"))
  .browser_specific_settings.gecko.id;
const dryRun = process.argv.includes("--dry-run");
const read = (f) => readFileSync(join(root, "docs/amo", f), "utf8").trim();

/** HS256 JWT in the form AMO's API expects (same claims web-ext sends). */
export function amoJwt(key, secret, now = Math.floor(Date.now() / 1000)) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: key, jti: randomBytes(16).toString("hex"), iat: now, exp: now + 60 });
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function main() {
  const listing = await (await fetch(`${API}${encodeURIComponent(GUID)}/`)).json();
  if (!listing.id) throw new Error(`could not find ${GUID} on AMO: ${JSON.stringify(listing)}`);
  const locale = listing.default_locale;

  const payload = {
    summary: { [locale]: read("listing-summary.txt"), "zh-CN": read("listing-summary.zh-CN.txt") },
    description: { [locale]: read("listing-description.txt"), "zh-CN": read("listing-description.zh-CN.txt") },
  };
  for (const [field, limit] of [["summary", 250]]) {
    for (const [loc, text] of Object.entries(payload[field])) {
      if ([...text].length > limit) throw new Error(`${field} (${loc}) is over ${limit} characters`);
    }
  }

  console.log(`listing ${listing.slug} (id ${listing.id}), default locale ${locale}`);
  for (const [field, byLocale] of Object.entries(payload)) {
    for (const [loc, text] of Object.entries(byLocale)) {
      console.log(`  ${field.padEnd(11)} ${loc.padEnd(5)} ${[...text].length} chars  "${text.slice(0, 60).replace(/\n/g, " ")}…"`);
    }
  }
  if (dryRun) {
    console.log("dry run: nothing sent");
    return;
  }

  const key = process.env.WEB_EXT_API_KEY;
  const secret = process.env.WEB_EXT_API_SECRET;
  if (!key || !secret) {
    console.error("WEB_EXT_API_KEY and WEB_EXT_API_SECRET must be set in this shell (the same ones npm run publish:amo uses).");
    process.exit(1);
  }
  const res = await fetch(`${API}${listing.id}/`, {
    method: "PATCH",
    headers: { Authorization: `JWT ${amoJwt(key, secret)}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`AMO refused the update: HTTP ${res.status}\n${text.slice(0, 600)}`);
    process.exit(1);
  }
  const updated = JSON.parse(text);
  const live = updated.summary && updated.summary[locale];
  console.log(`updated. summary (${locale}) now reads: "${String(live).slice(0, 80)}…"`);
  console.log(`check: https://addons.mozilla.org/firefox/addon/${listing.slug}/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
