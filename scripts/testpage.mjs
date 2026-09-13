/* Serves test/ on http://localhost:8777 as a known-good page for checking that
 * captions work, independently of any particular website's media. */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
const wav = join(root, "speech.wav");

if (!existsSync(wav)) {
  if (process.platform !== "darwin") {
    console.error(`Put any English speech .wav at ${wav} first.`);
    process.exit(1);
  }
  console.log("Generating speech.wav with macOS `say`…");
  const aiff = join(root, "speech.aiff");
  execFileSync("say", ["-v", "Samantha", "-o", aiff,
    "Hello and welcome to this test of the live caption extension for Firefox. " +
    "The weather in San Francisco today is foggy and cool, with a light wind from the west. " +
    "Machine learning models can now transcribe speech directly inside your web browser, " +
    "without sending any audio to a server. Thank you for listening to this short demonstration."]);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "1", aiff, wav]);
}

const TYPES = { ".html": "text/html", ".wav": "audio/wav" };
createServer((req, res) => {
  const file = join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url).split("?")[0]);
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(8777, () => console.log("Test page: http://localhost:8777  (Ctrl+C to stop)"));
