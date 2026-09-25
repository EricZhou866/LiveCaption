# Local Live Captions for Firefox

Automatic English captions for anything playing in a Firefox tab — video, podcasts,
meetings, streams — in the spirit of Chrome's Live Caption.

Speech recognition runs **locally**, in the browser, with a Whisper model executed by
onnxruntime-web. No audio leaves your computer unless you deliberately point the add-on
at a remote transcription endpoint.

## Why it is built this way

Firefox does not ship the two APIs a Chrome-style captioner would normally use:

| Missing in Firefox | What this add-on does instead |
| --- | --- |
| `SpeechRecognition` (Web Speech API) | Runs Moonshine or Whisper locally via `transformers.js` + onnxruntime-web (WASM, optional WebGPU) |
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
| a stream the page loaded without CORS (most radio players) | the same URL is fetched a second time with `crossOrigin="anonymous"` and read from there — never connected to the speakers |

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
npm run build           # -> web-ext-artifacts/local-live-captions-<version>.xpi
npm run source          # -> web-ext-artifacts/source-<version>.zip, required by AMO
```

To publish a new version to the listing in one go — tests, package, source archive, reviewer
notes and release notes from `docs/amo/<version>.json` — commit first, then run
`npm run publish:amo` with `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` set in the shell.

[docs/amo-submission.md](docs/amo-submission.md) has the full submission checklist
(step-by-step Chinese version: [docs/amo-submission.zh.md](docs/amo-submission.zh.md)):
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
| Recommended settings | One button at the top of the engine settings puts model, precision, compute, CPU usage and timing back to the fastest combination that works on every machine — moonshine-tiny, int8, CPU, balanced — and leaves appearance, transcript and stream-fallback choices alone. |
| Model | `moonshine-tiny` (default) and `moonshine-base` for English; Whisper `tiny`/`base`/`small` when you need another language or translation. |
| Precision | `int8` (recommended). Measured for moonshine-tiny on the CPU: int8 0.31 s per update from 27 MB; fp32 0.24 s but 104 MB and four times the memory; int4 0.51 s from 53 MB — slower *and* larger, so never worth it on the CPU. On WebGPU the precision is chosen automatically. |
| Compute | CPU (WebAssembly) everywhere; WebGPU where your Firefox build supports it. |
| CPU usage | How hard the recogniser is allowed to run: smoothest, balanced (default), or low (complete lines only). Partial updates are skipped while the tab is in the background whatever the setting. |
| Language | Transcribe as spoken, or translate any language into English (needs a multilingual model). |
| Panel | Font size, visible lines, opacity, theme, and how long the panel lingers after the last caption (0 = never hide). Position and size are remembered; both have reset buttons. |
| Transcript | Off by default. Keeps each tab's caption lines in memory so *Save transcript* (popup or panel) can write them to a `.txt` file in Downloads. Discarded on tab close, navigation, or switching it off. Asks once for the optional `downloads` permission. |
| Re-fetch uncapturable streams | On by default. Costs the stream's bandwidth twice, and is the only way to caption a player that loads its audio without CORS. |
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
- One decode costs about the same whatever the phrase length, so left alone the
  recogniser runs almost continuously — which is what makes Firefox warn that an
  extension is slowing it down. Partial decodes therefore wait until the engine has been
  idle long enough to hold a duty cycle, and are skipped entirely while the tab is in the
  background. Measured over a 75 s listening session (`npm test`, whisper-tiny.en at
  1.5 s per decode):

  | Version / setting | Duty cycle | Live-line updates | Committed lines |
  | --- | --- | --- | --- |
  | 1.0.0 (whisper-tiny.en, no budget) | 60% | 23 | 7 |
  | **1.2.0 default** (moonshine-tiny, balanced) | **17%** | **25** | 7 |
  | 1.2.0 smoothest | 31% | 51 | 7 |
  | Low, or any setting with the tab in the background | 4-14% | 0 | 7 |

  Committed lines are never dropped, whatever the budget — only the partial updates in
  between are.
- On a page that is not being captioned the content script costs ~0.005 ms per second of
  audio and runs no timers at all: audio blocks are checked with a strided probe, and the
  full resample, the cross-compartment copy and the 2 s media sweep only start once
  something is actually audible.
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

- Media the page loads without asking for CORS reaches the Web Audio graph as digital
  silence. The add-on detects this after ~5 s and re-fetches the same URL itself with
  CORS enabled, which is what makes ordinary radio players work; it deliberately does
  **not** fall back to `createMediaElementSource` there, because that re-routes the
  element's audio through a node which is required to output silence for such media,
  muting the page itself. If the server refuses CORS too, or the source is a blob/MSE
  stream that cannot be re-fetched, the panel says so — microphone mode is the only
  option then. (YouTube, Netflix-style MSE players and most CDNs
  with `crossorigin` are fine.)
- `speechSynthesis` output is produced outside the page's audio graph and cannot be
  captured by any page-level API. Microphone mode is the only option there.
- Captions lag speech by roughly the length of the current phrase — Whisper needs a
  chunk of audio, so this is inherently not word-by-word streaming.
- Whisper always encodes a padded 30 s window, so one decode costs about the same
  whatever the phrase length; Moonshine's cost follows the audio. Measured on an
  M-series Mac, single-threaded WASM (`test/model-bench.html`), for the same transcript:

  | Model | 4 s phrase | 8 s | 12 s |
  | --- | --- | --- | --- |
  | `moonshine-tiny` (default) | 203 ms | 436 ms | 698 ms |
  | `moonshine-base` | 425 ms | 892 ms | 1462 ms |
  | `whisper-tiny.en` | 1356 ms | 1563 ms | 1707 ms |

  That is why Moonshine is the default: the live line can update several times a second
  of audio without the recogniser ever running flat out.
- DRM (Widevine) playback cannot be captured at all.

## Release notes

Dates are as shown in the AMO Developer Hub, which uses UTC.

### 1.4.3 — listed on AMO since 2026-09-25

- New icon: a sound wave above the caption line it becomes, as PNG at every size, with a
  separately drawn, pixel-aligned 16 px version so the bars stay distinct in the toolbar
  instead of blurring together.
- The store page does **not** take its icon from the manifest. AMO keeps a listing icon of
  its own, set in the Developer Hub, and shows a default puzzle piece until one is
  uploaded — the public API still reported `addon-icons/default-64.png` with 1.4.3 live.
  `docs/listing/icon-128.png` is the file to upload there.

### 1.4.2 — listed on AMO since 2026-09-25

The first listed version to carry 1.4.0 and 1.4.1 below.

- **Use recommended settings**: one click at the top of the engine settings restores the
  fastest, most dependable combination — moonshine-tiny, int8, CPU (WebAssembly),
  Balanced, default timing — and shows when you are already on it. Appearance, the
  transcript switch and the stream fallback are left as you set them.
- The precision labels now match measurements. int4 was labelled "fastest"; on the CPU it
  is the slowest option (0.51 s per update against 0.31 s for int8) and twice int8's
  download.
- Release process: `npm run publish:amo` submits the package, source archive, reviewer
  notes and release notes together. The source archive is taken from the committed tree
  and now refuses to build when that is not the version being released — the archive sent
  with 1.3.0 had been built from 1.2.1, which the 1.4.2 reviewer notes point out.

### 1.4.1 — not published separately; ships in 1.4.2

- **Fixed: captions stopped for good after changing the model** (present since 1.0.0).
  Changing any engine setting restarts the recogniser, and the restart discarded the
  request in flight without ever settling it; every later caption — committed lines
  included — was queued behind it for ever. A restart now fails everything that was
  waiting, so the queue drains and the new model takes over.
- A decode that never answers (a stalled GPU, a wedged worker) no longer freezes
  captions: every request to the recogniser has a watchdog, and a stalled one throws the
  worker away and starts clean.
- WebGPU: precision is picked for the GPU (full-precision encoder, 4-bit decoder) instead
  of passing it an 8-bit model it cannot run, and if WebGPU is missing or stalls the
  phrase is redone on the CPU, the panel says so once, and the CPU is used from then on.

### 1.4.0 — not published separately; ships in 1.4.2

- **Save captions as a text file** (Settings → Transcript, off by default). When on, a
  tab's caption lines are kept in memory and *Save transcript* — in the toolbar popup or
  as the ↓ button on the caption panel — writes them to Downloads as a `.txt` file, one
  line per caption with its time. Only committed lines are kept, never the partial ones.
- Uses the new optional `downloads` permission, requested at the moment you switch the
  feature on; nobody who leaves it off is asked for anything.

### 1.3.0 — listed on AMO 2026-09-17 to 2026-09-25

- **Radio and news players work now.** Players that load their stream with
  `new Audio(url)` and no `crossorigin` attribute hand the browser tainted audio, so
  every capture route returns silence — even though the stream host usually does allow
  CORS. The add-on re-fetches the same URL itself with CORS enabled and reads that,
  wired to the recogniser only and never to the speakers. Costs the stream's bandwidth
  twice; switch it off in Settings if that matters.
- The version number is shown in the toolbar popup and at the top of Settings.
- Fixed: turning captions off threw (a method lost in a refactor), so taps stayed
  connected and microphone mode kept the microphone open until the tab closed.

### 1.2.1 — not published

- Fixed: the add-on could silence the page it was captioning. On media it could not
  capture it fell back to `createMediaElementSource`, which permanently routes the
  element's audio through the Web Audio graph — and that node is specified to output
  silence for cross-origin media without CORS. The destructive path is now gated on the
  audio actually being able to come through it.

### 1.2.0 — not published

- **Fixed the bug behind "Local Live Captions is slowing down Firefox".**
  `recoverSilentTaps()` deleted a tap from a Map and re-added it during iteration; a Map
  iterator visits entries inserted while iterating, and the re-added tap always matched
  the same condition, so the loop never ended — inside an audio callback, on every page
  whose media could not be captured. It also leaked a live `MediaStream` per retry.
- Switched the recogniser to Moonshine, whose cost follows the length of the audio
  instead of Whisper's fixed 30-second window: 203 ms against 1356 ms for a 4-second
  phrase, for the same transcript. Whisper remains available for other languages.
- Installations that never changed the model are migrated to the new default.

### 1.1.0 — not published

- A CPU budget for partial caption updates (Settings → CPU usage), and partial updates
  are skipped entirely while the tab is in the background. Committed caption lines are
  never skipped.
- An idle page now runs none of the add-on's timers, and audio blocks are checked with a
  strided probe instead of being resampled: 0.005 ms per second of audio.

### 1.0.0 — on AMO

First release.

## Privacy

See [PRIVACY.md](PRIVACY.md). In short: nothing is collected, and nothing is sent to the
developer — there is no server. Audio is processed in memory and discarded. The add-on
makes network requests only to download a speech model from huggingface.co (once per
model), to re-read a page's own media URL when its player cannot be captured directly
(Settings can turn this off), and — only if you configure one — to your own transcription
endpoint. Transcripts are off by default; when on, they stay in memory until you save one
to your Downloads folder.

## License

MIT
