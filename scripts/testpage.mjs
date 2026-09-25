/* Serves test/ on http://localhost:8777 as a known-good page for checking that
 * captions work, independently of any particular website's media. */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSpeechWav } from "./speech-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test");

try {
  ensureSpeechWav();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const TYPES = { ".html": "text/html", ".wav": "audio/wav", ".js": "text/javascript", ".css": "text/css" };
const extDir = join(root, "..", "extension");

createServer((req, res) => {
  const path = req.url === "/" ? "/index.html" : decodeURIComponent(req.url).split("?")[0];
  // /ext/* exposes the add-on's own sources so a harness page can load them.
  const base = path.startsWith("/ext/") ? extDir : root;
  const file = join(base, path.startsWith("/ext/") ? path.slice(5) : path);
  if (!file.startsWith(base) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(8777, () => console.log("Test page: http://localhost:8777  (Ctrl+C to stop)"));
