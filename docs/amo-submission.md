# Publishing to addons.mozilla.org

Everything needed for the AMO submission, in the order the form asks for it.
A click-by-click walkthrough in Chinese is in [amo-submission.zh.md](amo-submission.zh.md).

## 0. Before you upload

| Check | Command / where |
| --- | --- |
| Lint is clean | `npm run lint` → 0 errors (2 warnings, explained below) |
| Version bumped in both places | `extension/manifest.json` and `package.json` |
| Package built from a clean vendor dir | `npm run build` → `web-ext-artifacts/local-live-captions-<version>.xpi` |
| Source archive for reviewers | `npm run source` → `web-ext-artifacts/source-<version>.zip` |
| Tested on a fresh profile | `npm start`, then play audio on a normal site |

**Name.** The add-on is called **Local Live Captions**, deliberately not "Live Caption": that is the
name of a Chrome/Android feature, and AMO reviewers ask add-ons to avoid names that
suggest an association with another vendor. "Local" also says the thing that makes this
one different. The add-on ID (`live-caption@ericzhou866`) is unrelated to the display
name and must stay as it is, so updates keep working.

**Account:** AMO uses your Firefox Account — the same login you used for your earlier
add-on. Your existing add-ons are at https://addons.mozilla.org/developers/addons ;
"Submit a New Add-on" starts this one.

## 1. Distribution choice

- **Listed on AMO** (recommended): public page, search, automatic updates.
  https://addons.mozilla.org/developers/addon/submit/distribution
- **Self-distributed**: `npm run sign` with `WEB_EXT_API_KEY` / `WEB_EXT_API_SECRET` from
  https://addons.mozilla.org/developers/addon/api/key/ — returns a signed XPI you host
  yourself. Still reviewed, but not listed.

## 2. Source code submission — required

The add-on ships `extension/vendor/transformers.min.js`, which is minified third-party
code, so AMO requires the sources and build steps. Upload `web-ext-artifacts/source-<version>.zip`
and paste this into the build-instructions box:

```
Build environment: Node.js 20+ on macOS or Linux.

  npm ci
  npm run vendor     # copies the two vendored runtime files into extension/vendor/
  npm run build      # zips extension/ into web-ext-artifacts/local-live-captions-<version>.xpi

extension/vendor/ is generated, never edited by hand, and contains exactly two files
copied verbatim from the @huggingface/transformers npm package pinned in package.json
(version 3.8.1, integrity recorded in package-lock.json):

  transformers.min.js               <- node_modules/@huggingface/transformers/dist/transformers.min.js
  ort-wasm-simd-threaded.jsep.wasm  <- node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm

The published, unminified sources of that package are at
https://github.com/huggingface/transformers.js (tag 3.8.1). No other build step,
bundler, transpiler or minifier is used: every other file in the XPI is the
hand-written source as it appears in the repository.
```

## 3. Reviewer notes

```
What it does
  Shows live English captions for audio playing in a tab. Speech recognition runs
  locally in the browser with a Whisper model (transformers.js + onnxruntime-web,
  WebAssembly). No audio is sent anywhere in the default configuration.

Two lint warnings you will see
  Both are DANGEROUS_EVAL inside extension/vendor/transformers.min.js: the
  onnxruntime WebAssembly loader uses the Function constructor. It is unmodified
  upstream code from the @huggingface/transformers package (see source
  submission). None of the add-on's own code uses eval or the Function constructor.

Network access
  1. huggingface.co (+ CDN): one-time download of the model the user selected,
     cached afterwards. Nothing but the model files is requested.
     These downloads are DATA, not code: .onnx weight files, tokenizer.json,
     config.json and preprocessor_config.json. They are parsed by the
     WebAssembly runtime that ships inside the add-on
     (extension/vendor/), never evaluated as script, so no remote code is
     executed. The model list is fixed in the Settings page
     (extension/options/options.html); the user picks one of those entries and
     cannot point the add-on at an arbitrary URL.
  2. A transcription endpoint the user types in themselves in Settings. This is
     off by default. When it is on, 16 kHz WAV segments go to that URL and nowhere
     else. It exists for people running their own whisper.cpp server.
  No server belonging to the developer is contacted, because there is none.

Page prototype patching (extension/content/capture.js)
  To find audio that is not a DOM media element, the content script patches
  AudioNode.prototype.connect and HTMLMediaElement.prototype.play on the page via
  wrappedJSObject/exportFunction. Both patches call through to the original and
  only attach a silent Web Audio tap; nothing about the page is read or altered
  otherwise. This is the only way to caption sites that play through
  `new Audio()` or the Web Audio API, since Firefox has no tabCapture.

Host permissions
  <all_urls> is declared as optional and requested from the popup, so the user
  grants it deliberately (and can grant it per site).

How to test quickly
  npm ci && npm run vendor && npm start, then open http://localhost:8777 after
  `npm run testpage` — it has pages for each capture path. Captions appear a few
  seconds after playback starts (the first run downloads ~40 MB of model).
```

## 4. Listing fields

**Name:** Local Live Captions

**Summary** (250 char max):

```
Live English captions for any audio or video in a tab — video, podcasts, meetings,
streams. Speech recognition runs locally in your browser with Whisper; your audio
never leaves your computer.
```

**Description:**

```
Local Live Captions puts a caption panel over whatever is playing in a tab, the way Chrome's Live
Caption does — except the speech recognition runs on your own machine, inside Firefox,
using a Whisper model compiled to WebAssembly.

• Captions appear on their own as soon as a tab starts playing audio
• Everything is local: after the one-time model download the add-on works offline,
  and your audio is never uploaded
• Works with ordinary <video>/<audio> players, with sites that play through the Web
  Audio API, and with a microphone source for calls or anything Firefox cannot tap
• Drag the panel anywhere, resize it, change the text size, pick dark or light
• Choose your accuracy/speed trade-off: whisper-tiny.en for the fastest captions,
  base or small when you want more accuracy; WebGPU if your build supports it
• Can translate other languages into English with a multilingual model
• Optionally point it at your own transcription server instead (OpenAI-compatible)

Keyboard shortcut: Ctrl+Shift+L (Cmd+Shift+L on macOS) toggles captions for the tab.

First run downloads the speech model (about 40 MB for the default). Firefox asks you
to grant site access before the add-on can read a page's audio.

Known limits: media served cross-origin without CORS headers cannot be tapped (use
microphone mode there), DRM video cannot be captured at all, and captions lag by about
the length of the phrase being spoken.
```

**Categories:** Accessibility (primary), Other / Photos-Music-Videos (secondary)
**Tags:** captions, subtitles, accessibility, speech recognition, whisper, offline
**Support site:** https://github.com/EricZhou866/LiveCaption
**Support email:** EricZhou866@gmail.com
**Privacy policy:** paste `PRIVACY.md`
**License:** MIT

**Data collection disclosure:** "No data collected" — matches
`browser_specific_settings.gecko.data_collection_permissions.required = ["none"]` in the
manifest. Mention the optional user-configured remote endpoint in the reviewer notes
(already in the text above) so the disclosure is unambiguous.

**Images:**

| File | Use |
| --- | --- |
| `docs/listing/icon-128.png` | Listing icon |
| `docs/listing/screenshot-captions.png` | Screenshot 1 — the caption panel over a player |
| `docs/listing/screenshot-settings.png` | Screenshot 2 — the Settings page, rendered from the real options page with the shipped defaults |

Both screenshots are generated, not hand-drawn: the first from the add-on's own stylesheet,
the second from `extension/options/options.html` itself. A third one taken during a real
session (your own video with captions running) is worth adding if you have one.

## 5. After approval

- Updates: bump both versions, `npm run build`, upload the new XPI on the add-on's
  *Manage Versions* page. Users update automatically.
- Keep `strict_min_version` at 128.0 unless you start using newer APIs.
- Watch the first reviews for site-specific capture failures; the diagnostics report in
  Settings is what to ask users for.
