/* Per-frame orchestrator: attaches taps to whatever the page plays, streams
 * PCM to the background worker, and (in the top frame) draws the overlay.
 *
 * A session starts when audio is actually heard, not when a media element
 * exists — the Web Audio tap runs continuously and would otherwise stream
 * silence. */
"use strict";

(function (LC) {
  const IS_TOP = window.top === window;
  const CHUNK_SAMPLES = LC.SAMPLE_RATE / 2; // ship ~500 ms per message
  const ACTIVITY_LEVEL = 0.0025;            // "something is audible"
  const IDLE_STOP_MS = 4000;
  const DEFAULT_AUTO_HIDE_MS = 5000;

  const state = {
    port: null,
    settings: null,
    mode: "auto", // auto | on | off  (per tab, owned by the background)
    source: "media", // media | mic
    sessionActive: false,
    pending: [],
    pendingLength: 0,
    lastAudioAt: 0,
    lastCaption: 0,
  };

  const tap = new LC.AudioTap({
    onSamples: (samples, level) => onSamples(samples, level),
    onStatus: (s) => send({ type: "capture-status", ...s }),
  });

  tap.installPageHooks();

  const watcher = new LC.MediaWatcher((playing) => onPlayingChanged(playing));

  const overlay = IS_TOP
    ? new LC.Overlay({
        onClose: () => send({ type: "set-mode", mode: "off" }),
        onGeometry: (geo) => send({ type: "save-ui", ...geo }),
      })
    : null;

  /* ---------------- transport ---------------- */

  function connect() {
    try {
      state.port = browser.runtime.connect({ name: "lc-frame" });
    } catch (err) {
      return; // extension reloading
    }
    state.port.onMessage.addListener(onBackgroundMessage);
    state.port.onDisconnect.addListener(() => {
      state.port = null;
      endSession();
      setTimeout(connect, 1500);
    });
    send({ type: "hello", top: IS_TOP, url: location.href });
  }

  function send(msg) {
    if (!state.port) return;
    try { state.port.postMessage(msg); } catch (_) { state.port = null; }
  }

  /* ---------------- audio flow ---------------- */

  function enabled() {
    return !!(state.settings && state.settings.enabled) && state.mode !== "off";
  }

  function onSamples(samples, level) {
    if (!enabled()) return;
    if (level > ACTIVITY_LEVEL) {
      state.lastAudioAt = Date.now();
      if (!state.sessionActive) beginSession();
    }
    if (!state.sessionActive) return; // idle: don't stream silence
    queueSamples(samples);
  }

  function queueSamples(samples) {
    state.pending.push(samples);
    state.pendingLength += samples.length;
    if (state.pendingLength < CHUNK_SAMPLES) return;

    const merged = new Float32Array(state.pendingLength);
    let offset = 0;
    for (const part of state.pending) { merged.set(part, offset); offset += part.length; }
    state.pending = [];
    state.pendingLength = 0;
    send({ type: "audio", pcm: LC.pcmToBase64(merged) });
  }

  function beginSession() {
    state.sessionActive = true;
    state.lastAudioAt = Date.now();
    tap.active = true;          // full-rate processing only while captioning
    watcher.setPolling(true);   // and only then is the 2 s sweep worth running
    startTicking();
    send({ type: "session-start", source: state.source, hidden: document.hidden });
  }

  function endSession() {
    if (!state.sessionActive) return;
    state.sessionActive = false;
    state.pending = [];
    state.pendingLength = 0;
    tap.active = false;
    watcher.setPolling(false);
    tap.noteIdle();
    send({ type: "session-stop" });
    // Anything still playing gets a fresh tap for the next stretch of audio.
    onPlayingChanged(watcher.playingElements());
  }

  /* ---------------- capture lifecycle ---------------- */

  /** Hooks are what catch `new Audio()` and Web Audio playback. */
  function armCapture() {
    if (!enabled()) return;
    tap.installPageHooks();
    tap.running = true;
    if (state.source === "mic") tap.startMic();
    else onPlayingChanged(watcher.playingElements());
  }

  function onPlayingChanged(playing) {
    if (!enabled() || state.source === "mic") return;
    if (playing.length) tap.startMedia(playing);
  }

  function stopCapture() {
    endSession();
    tap.stop();
  }

  /* ---------------- background -> frame ---------------- */

  function onBackgroundMessage(msg) {
    switch (msg.type) {
      case "config":
        state.settings = msg.settings;
        LC.debug = !!msg.settings.debug;
        state.mode = msg.mode || "auto";
        state.source = msg.source || "media";
        tap.disabled = !enabled();
        if (overlay) overlay.applyOptions(msg.settings.ui || {});
        if (!enabled()) {
          stopCapture();
          if (overlay) overlay.hide();
        } else {
          armCapture();
        }
        break;

      case "start":
        state.mode = "on";
        state.source = msg.source || "media";
        if (overlay) { overlay.show(); overlay.setStatus("Starting…", "busy"); }
        armCapture();
        break;

      case "stop":
        state.mode = "off";
        stopCapture();
        if (overlay) { overlay.clear(); overlay.hide(); }
        break;

      case "caption":
        if (!overlay) return;
        overlay.show();
        state.lastCaption = Date.now();
        startTicking();
        if (msg.final) overlay.pushFinal(msg.text);
        else overlay.setInterim(msg.text);
        break;

      case "status":
        if (!overlay) return;
        if (msg.show) overlay.show();
        overlay.setStatus(msg.text, msg.kind || "ok");
        break;

      case "clear":
        if (overlay) overlay.clear();
        break;
    }
  }

  /** What this frame sees — used by the diagnostics button in the options page. */
  function report() {
    const media = Array.from(document.querySelectorAll("video, audio")).map((el) => ({
      tag: el.tagName.toLowerCase(),
      src: String(el.currentSrc || el.src || "").slice(0, 90),
      paused: el.paused,
      muted: el.muted,
      volume: el.volume,
      readyState: el.readyState,
      tapped: tap.taps.has(el),
    }));
    return {
      ok: true,
      top: IS_TOP,
      url: location.href.slice(0, 120),
      mode: state.mode,
      source: state.source,
      connected: !!state.port,
      gotSettings: !!state.settings,
      sessionActive: state.sessionActive,
      secondsSinceAudio: state.lastAudioAt ? (Date.now() - state.lastAudioAt) / 1000 : null,
      playingInDom: watcher.playingElements().length,
      capture: tap.describe(),
      media,
    };
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ping") return Promise.resolve(report());
    if (!IS_TOP) return;
    onBackgroundMessage(msg);
  });

  /* Close the session when the page goes quiet, and hide a stale panel. This
   * ticks only while there is something to do — an idle frame (which is most
   * frames on most pages) runs no timer at all. */
  let tickTimer = null;

  function startTicking() {
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }

  function tick() {
    if (state.sessionActive && Date.now() - state.lastAudioAt > IDLE_STOP_MS) endSession();
    const ui = (state.settings && state.settings.ui) || {};
    const hideAfter = ui.autoHideMs == null ? DEFAULT_AUTO_HIDE_MS : ui.autoHideMs;
    if (hideAfter > 0 && overlay && state.lastCaption && !state.sessionActive &&
        Date.now() - state.lastCaption > hideAfter) {
      overlay.hide();
      overlay.clear();
      state.lastCaption = 0;
    }
    // With "never hide" there is nothing left to do once the session ends, so
    // the timer must stop there too — otherwise it would run for the life of
    // the page, which is exactly the cost this is meant to avoid.
    if (!state.sessionActive && (hideAfter <= 0 || !state.lastCaption)) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (state.sessionActive) send({ type: "visibility", hidden: document.hidden });
  });

  window.addEventListener("pagehide", () => stopCapture());

  watcher.start();
  connect();
})(globalThis.LiveCaption);
