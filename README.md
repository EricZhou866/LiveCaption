# Live Caption for Firefox

Automatic English captions for anything playing in a Firefox tab — video, podcasts,
meetings, streams — in the spirit of Chrome's Live Caption.

Speech recognition runs **locally**, in the browser, with a Whisper model executed by
onnxruntime-web. No audio leaves your computer unless you deliberately point the add-on
at a remote transcription endpoint.

## Why it is built this way

Firefox does not ship the two APIs a Chrome-style captioner would normally use:

| Missing in Firefox | What this add-on does instead |
| --- | --- |
| `SpeechRecognition` (Web Speech API) | Runs Whisper locally via `transformers.js` + onnxruntime-web (WASM, optional WebGPU) |
| `chrome.tabCapture` | Taps the page's audio itself — see *Capture paths* below |

The speech runtime (transformers.js 3.8.1 with onnxruntime-web) is vendored into the
add-on, because the extension CSP (`script-src 'self'`) blocks the CDN that
transformers.js reaches for by default.

## Capture paths

Sites make sound in three different ways, and all three are covered:

| How the page plays audio | How it is captured |
| --- | --- |
| `<audio>`/`<video>` in the DOM | `captureStream()`, falling back to a Web Audio `MediaElementSource` |
| `new Audio(url).play()` — element never added to the DOM | patched `HTMLMediaElement.prototype.play` |
| Web Audio with no media element at all | patched `AudioNode.prototype.connect`: anything connected to `ctx.destination` is mirrored into a silent tap in that same context |

A `captureStream()` track ends together with the media it came from, so every tap is
re-validated before reuse and replaced when it has gone dead — otherwise captions would
only ever appear for the first play of a clip.

The patches are applied with Firefox's `wrappedJSObject` + `exportFunction` at
`document_start`, so no script is injected into the page and a strict page CSP cannot
block them. When two taps would carry the same sound, the first audible one owns the
stream until it falls quiet, so the recognizer never receives two interleaved copies.

## Install (temporary, for development)

```bash
npm install
npm run vendor          # copies transformers.js + onnxruntime wasm into extension/vendor
npm start               # launches Firefox with the add-on loaded
```

To load it by hand: open `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → pick `extension/manifest.json`.

For a permanent install, build a package and submit it to
[addons.mozilla.org](https://addons.mozilla.org/developers/) (Firefox only installs
signed add-ons permanently):

```bash
npm run build           # -> web-ext-artifacts/live-caption-<version>.xpi
npm run source          # -> web-ext-artifacts/source-<version>.zip, required by AMO
```

[docs/amo-submission.md](docs/amo-submission.md) has the full submission checklist:
listing copy, permission justifications, reviewer notes, and the build instructions AMO
requires because a minified dependency is vendored. Self-distribution instead:
`npm run sign` with your AMO API credentials.

## Using it

1. Click the toolbar icon and press **Allow on all sites**. Firefox MV3 keeps host
   access opt-in, and without it the add-on cannot read a page's audio.
2. Play anything with sound. The caption panel appears by itself.
3. The first run downloads the speech model (~40 MB for the default `whisper-tiny.en`);
   progress is shown in the caption panel. It is cached afterwards, and works offline
   from then on.

- `Ctrl+Shift+L` toggles captions for the current tab.
- Drag the panel by its header; drag its bottom-right corner to resize it; `A-` / `A+`
  change text size; `✕` hides it. Position and size are remembered.
- The panel disappears 5 s after the last caption once the audio stops. That delay is
  configurable in Settings, including "never hide".
- Popup → **Microphone** captions audio from your mic instead of the tab, which is the
  way to caption a call, a desktop app, or a site whose media cannot be tapped.

## Settings

| Setting | Notes |
| --- | --- |
| Model | `whisper-tiny.en` (default) → `whisper-small.en` (most accurate). Multilingual variants are available for translation. |
| Precision | `q8` is the default; `q4` is faster, `fp16`/`fp32` are for WebGPU. |
| Compute | CPU (WebAssembly) everywhere; WebGPU where your Firefox build supports it. |
| Language | Transcribe as spoken, or translate any language into English (needs a multilingual model). |
| Panel | Font size, visible lines, opacity, theme, and how long the panel lingers after the last caption (0 = never hide). Position and size are remembered; both have reset buttons. |
| Timing | Pause length that ends a caption line, partial-update interval, and speech sensitivity. |
| Engine | Local, or an OpenAI-compatible `POST /v1/audio/transcriptions` endpoint (e.g. a local `whisper.cpp` server). |

## How it works

```
content script                     background page                worker
──────────────                     ──────────────                 ──────
<video>/<audio>
  └─ captureStream() ──┐
     or MediaElementSource
                       ├─ AudioContext → ScriptProcessor
                       └─ box-filter resample to 16 kHz mono
                                  │ base64 Int16, ~500 ms per message
                                  ▼
                          energy VAD + segmenter
                            ├─ every ~1.1 s → interim decode  → live line
                            └─ on a 700 ms pause → final decode → committed line
                                  │                                  │
                                  └──────────► Whisper (transformers.js) ◄┘
                                  ▲
        caption overlay (shadow DOM, top frame) ◄── captions
```

- The VAD tracks a rolling noise floor, so it adapts to room tone and music beds rather
  than relying on one fixed threshold.
- Interim decodes are dropped while the engine is busy; final ones are queued, so a
  committed line is never lost.
- Common Whisper silence hallucinations (`you`, `Thanks for watching!`, `(music)`) are
  filtered when the segment's energy is low.

## When captions do not appear

Open **Settings → Diagnostics → Run diagnostics**. It reports whether the content script
reached the tab, what media it found, which tap won, and how the model is doing. There is
also a known-good page to test against, independent of any site:

```bash
npm run testpage      # http://localhost:8777 — plain <audio>, Web Audio, new Audio(), replay
```

Two things that are easy to miss with a temporary add-on: reload the add-on in
`about:debugging` after `npm run vendor`, and reload any tab that was already open,
since content scripts only inject on page load.

## Limitations

- Media served cross-origin **without** CORS headers cannot be tapped — the Web Audio
  graph receives digital silence. The add-on detects this after ~5 s and says so; use
  microphone mode for those sites. (YouTube, Netflix-style MSE players and most CDNs
  with `crossorigin` are fine.)
- `speechSynthesis` output is produced outside the page's audio graph and cannot be
  captured by any page-level API. Microphone mode is the only option there.
- Captions lag speech by roughly the length of the current phrase — Whisper needs a
  chunk of audio, so this is inherently not word-by-word streaming.
- Whisper always processes a padded 30 s window, so one decode costs about the same
  whatever the phrase length. Measured on an M-series Mac, single-threaded WASM:
  `tiny.en` ≈ 1.6 s per decode, `base.en` ≈ 3.5 s. That decode time is the floor on how
  often the live line can update, which is why `tiny.en` is the default; `small` is
  only sensible with WebGPU or a fast desktop CPU.
- DRM (Widevine) playback cannot be captured at all.

## Privacy

The add-on stores only your settings. Audio is processed in memory and discarded; the
only network traffic in local mode is the one-time model download from huggingface.co.
Remote mode uploads 16 kHz WAV segments to the endpoint you configure, and nowhere else.

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: nothing is collected; the only network
traffic in local mode is the one-time model download.

## License

MIT
