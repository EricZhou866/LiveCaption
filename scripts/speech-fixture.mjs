/* test/speech.wav: an English speech clip the timeline test and the test page
 * both need. It is not checked in; it is spoken on the spot — macOS `say` if
 * available, otherwise espeak-ng (`apt install espeak-ng`). */
import { existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "test");
export const SPEECH_WAV = join(root, "speech.wav");

const TEXT =
  "Hello and welcome to this test of the live caption extension for Firefox. " +
  "The weather in San Francisco today is foggy and cool, with a light wind from the west. " +
  "Machine learning models can now transcribe speech directly inside your web browser, " +
  "without sending any audio to a server. Thank you for listening to this short demonstration.";

function has(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

/** Returns the path, or throws saying what to install. */
export function ensureSpeechWav() {
  if (existsSync(SPEECH_WAV)) return SPEECH_WAV;
  if (process.platform === "darwin") {
    console.log("Generating speech.wav with macOS `say`…");
    const aiff = join(root, "speech.aiff");
    execFileSync("say", ["-v", "Samantha", "-o", aiff, TEXT]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "1", aiff, SPEECH_WAV]);
    rmSync(aiff, { force: true });
  } else if (has("espeak-ng")) {
    console.log("Generating speech.wav with espeak-ng…");
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "150", "-w", SPEECH_WAV, TEXT]);
  } else {
    throw new Error(`Put any English speech .wav at ${SPEECH_WAV}, or install espeak-ng to generate one.`);
  }
  return SPEECH_WAV;
}
