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
• Choose your accuracy/speed trade-off: Moonshine for the fastest captions,
  Whisper when you need another language; WebGPU if your build supports it
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

## 5. Release notes

### 1.4.0

```
New, and off by default: save captions as a text file. Turn on Settings →
Transcript and the add-on keeps each tab's caption lines in memory; "Save
transcript" in the toolbar popup, or the ↓ button on the caption panel, writes
them to your Downloads folder as a .txt file, one timed line per caption.
Nothing is kept unless you turn this on, nothing is written until you click
Save, and a tab's transcript is discarded when you close it or switch the
feature off.
```

Reviewer notes for this version:

```
New optional permission: "downloads". It is declared under
optional_permissions and requested with permissions.request() only when the
user ticks Settings -> Transcript (extension/options/options.js); declining
leaves the feature off. It is used for one call, downloads.download() on a
blob: URL built in the background page from the tab's caption lines
(extension/background/background.js, saveTranscript), triggered only by the
user clicking Save. The text never leaves the machine and nothing is fetched.
Transcripts live in memory only and are cleared on tab close, navigation, and
when the setting is turned off (background.js, clearTranscripts). The
privacy policy has been updated to describe this. No other change to
permissions, network access or the vendored runtime.
```

### 1.3.0

```
Captions now work on radio and news players that load their stream without
asking for CORS — the case where the browser hands an extension silence even
though the server itself allows it. The add-on fetches the same stream a
second time, with CORS, purely to read it; that connection is never played
back, so what you hear is still the page's own player. It can be turned off
in Settings, where it also explains that it costs the stream's bandwidth
twice.

The add-on's version is now shown in the toolbar popup and at the top of
Settings.

Fixed: turning captions off could throw, leaving a tap and, in microphone
mode, the microphone running until the tab was closed.
```

### 1.2.1

```
Never silences a page. On media that cannot be captured (cross-origin audio
without CORS headers — common in the embedded players on news sites) the
add-on used to fall back to routing the element through the Web Audio API,
which for that kind of media outputs silence: the captions stayed empty and
the page went quiet after a few seconds. It now leaves such players alone and
says so, suggesting microphone mode instead.

Fixes a bug that could pin a CPU core. On media the add-on cannot capture —
cross-origin audio without CORS headers, which is common in embedded players
on news sites — the recovery path looped indefinitely inside an audio
callback, leaving the page's process busy for as long as the tab stayed open.
It now escalates once, reports that the media cannot be captioned, and stops.

Much lighter on the CPU. The recogniser now uses Moonshine by default, whose
cost follows the length of the audio instead of Whisper's fixed 30-second
window: the same transcript for about a seventh of the work on a short phrase.
Measured over a 75-second listening session, the add-on now runs the
recogniser 17% of the time against 60% in 1.0.0, while updating the live
caption line more often than before, not less.

Existing installations that never changed the model are moved to the new
default automatically; a model you chose yourself is left alone.

Whisper is still available in Settings for other languages and for
translating into English.
```

Reviewer notes for this version: no change to permissions, network access or the
vendored runtime. The new model is fetched from the same host as before
(huggingface.co) and, as before, only from a fixed list in the Settings page.

### 1.1.0

```
Performance: the recogniser no longer runs almost continuously while audio
plays, which is what made Firefox report the add-on as slowing the browser
down. Partial caption updates now hold a CPU budget and are skipped while the
tab is in the background; complete caption lines are never skipped.

New setting — CPU usage: Smoothest (1.0.0 behaviour), Balanced (new default,
about a third less CPU) or Low (complete sentences only, at pauses).

Also: a page that is not being captioned now costs almost nothing — no timers,
and audio blocks are checked with a cheap probe instead of being resampled.
```

Reviewer notes for this version: nothing changed about permissions, network
access or the vendored runtime; the diff is scheduling and a new setting. The
same source archive instructions apply.

## 6. After approval

- Updates: bump both versions, `npm run build`, upload the new XPI on the add-on's
  *Manage Versions* page. Users update automatically.
- Keep `strict_min_version` at 128.0 unless you start using newer APIs.
- Watch the first reviews for site-specific capture failures; the diagnostics report in
  Settings is what to ask users for.
