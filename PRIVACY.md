# Privacy Policy — Local Live Captions

_Last updated: 2026-09-13_

Local Live Captions does not collect, transmit, or sell any personal data. There is no
analytics, no telemetry, and no account.

## What the add-on processes

- **Audio from the tab or your microphone.** It is read only while captions are on,
  converted to 16 kHz mono in memory, transcribed, and discarded. It is never written to
  disk and never sent anywhere in the default (local) mode.
- **Captions.** Shown on screen only. They are not stored, logged, or uploaded, and are
  discarded when the panel closes.
- **Your settings** (model, appearance, panel position and size, timing). Stored locally
  with the browser's extension storage. They never leave your computer.

## Network connections

| When | Where | What is sent |
| --- | --- | --- |
| First use of a speech model, once per model | `huggingface.co` and its CDN | A normal file download request for the model weights. No audio, no page data, no identifiers beyond what any HTTPS request includes. |
| Only if you explicitly configure a remote endpoint in Settings | The URL **you** enter | 16 kHz WAV audio segments and, if you set one, your API key. This is off by default; in local mode it never happens. |

No other connections are made. The add-on does not talk to any server operated by the
developer, because there isn't one.

## Permissions

- **Access to the sites you visit** — required to read the audio of pages you play media
  on and to draw the caption panel there. Firefox asks you to grant this explicitly, and
  you can grant it per site.
- **Microphone** — only when you switch the audio source to Microphone; Firefox asks each
  site for permission in the usual way.
- **Storage** — your settings.
- **Tabs** — to know which tab is playing and to keep captions per tab.

## Contact

Questions or reports: open an issue at
https://github.com/EricZhou866/LiveCaption/issues
