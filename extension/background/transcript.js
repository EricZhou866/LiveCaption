/* Optional transcript: committed caption lines kept per tab so they can be
 * saved as a text file. Off by default. Nothing here is written to disk or
 * sent anywhere until the user clicks Save; the lines live in memory and go
 * away with the tab, a navigation, or the feature being switched off. */
"use strict";

const TRANSCRIPT_MAX_LINES = 10000; // ~20 h of speech; oldest lines drop first

function recordLine(session, text, at = Date.now()) {
  if (!session.transcript) session.transcript = [];
  session.transcript.push({ at, text });
  if (session.transcript.length > TRANSCRIPT_MAX_LINES) {
    session.transcript.splice(0, session.transcript.length - TRANSCRIPT_MAX_LINES);
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function clock(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dateStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Plain UTF-8 text, one line per caption, local wall-clock times. */
function formatTranscript(lines, { title = "", url = "", savedAt = Date.now() } = {}) {
  const head = [
    "Local Live Captions — transcript",
    title ? `Page:  ${title}` : null,
    url ? `URL:   ${url}` : null,
    `Saved: ${dateStamp(savedAt)} ${clock(savedAt)}`,
    `Lines: ${lines.length}`,
    "",
  ].filter((l) => l !== null);
  const body = lines.map((l) => `[${clock(l.at)}] ${l.text}`);
  return head.concat(body).join("\n") + "\n";
}

/** Something every OS accepts: no path separators, no reserved characters,
 * no trailing dots, bounded length. */
function transcriptFilename(title, savedAt = Date.now()) {
  const d = new Date(savedAt);
  const stamp = `${dateStamp(savedAt)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slug = String(title || "captions")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/, "");
  return `${slug || "captions"} ${stamp}.txt`;
}
