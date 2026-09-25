/* Updates the AMO listing — name, summary, description, tags and donation link —
 * from docs/amo/listing-*.txt and docs/amo/listing-meta.json.
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

// Limits from addons-server: Addon.name is a TranslatedField(max_length=50),
// amo.MAX_TAGS = 10 from a fixed list, and contributions must be on one of
// amo.VALID_CONTRIBUTION_DOMAINS.
const NAME_MAX = 50;
const MAX_TAGS = 10;
const CONTRIBUTION_DOMAINS = [
  "buymeacoffee.com", "donate.mozilla.org", "flattr.com", "github.com", "ko-fi.com",
  "liberapay.com", "www.micropayment.de", "opencollective.com", "www.patreon.com",
  "www.paypal.com", "paypal.me",
];

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

  const meta = JSON.parse(read("listing-meta.json"));
  const payload = {
    name: { [locale]: meta.name.default, "zh-CN": meta.name["zh-CN"] },
    summary: { [locale]: read("listing-summary.txt"), "zh-CN": read("listing-summary.zh-CN.txt") },
    description: { [locale]: read("listing-description.txt"), "zh-CN": read("listing-description.zh-CN.txt") },
    tags: meta.tags,
  };
  for (const [field, limit] of [["name", NAME_MAX], ["summary", 250]]) {
    for (const [loc, text] of Object.entries(payload[field])) {
      if ([...text].length > limit) throw new Error(`${field} (${loc}) is over ${limit} characters`);
    }
  }

  // Tags are a fixed vocabulary on AMO; check against the live list.
  const allowed = await (await fetch("https://addons.mozilla.org/api/v5/addons/tags/")).json();
  const unknown = meta.tags.filter((t) => !allowed.includes(t));
  if (unknown.length) throw new Error(`not AMO tags: ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
  if (meta.tags.length > MAX_TAGS) throw new Error(`at most ${MAX_TAGS} tags`);

  // A donation link is only sent once there is one; AMO accepts a short list of services.
  if (meta.contributions_url) {
    const host = new URL(meta.contributions_url).hostname;
    if (!CONTRIBUTION_DOMAINS.includes(host)) {
      throw new Error(`AMO only accepts donation links on: ${CONTRIBUTION_DOMAINS.join(", ")} — not ${host}`);
    }
    payload.contributions_url = meta.contributions_url;
  }

  console.log(`listing ${listing.slug} (id ${listing.id}), default locale ${locale}`);
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value === "string" || Array.isArray(value)) {
      console.log(`  ${field.padEnd(17)} ${Array.isArray(value) ? value.join(", ") : value}`);
      continue;
    }
    for (const [loc, text] of Object.entries(value)) {
      console.log(`  ${field.padEnd(11)} ${loc.padEnd(5)} ${String([...text].length).padStart(4)} chars  "${text.slice(0, 56).replace(/\n/g, " ")}${text.length > 56 ? "…" : ""}"`);
    }
  }
  if (!payload.contributions_url) console.log("  contributions_url (not set in listing-meta.json — skipped)");
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
  const pick = (f) => (f && (f[locale] || Object.values(f)[0])) || "";
  console.log(`updated.\n  name: ${pick(updated.name)}\n  tags: ${(updated.tags || []).join(", ")}\n  donation link: ${updated.contributions_url || "(none)"}`);
  console.log(`check: https://addons.mozilla.org/firefox/addon/${listing.slug}/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
