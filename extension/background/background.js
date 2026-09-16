/* Hub: owns per-tab caption sessions, drives the speech engine and routes
 * captions back to the tab's top frame. */
"use strict";

const sessions = new Map(); // tabId -> session
const ports = new Map();    // port -> { tabId, frameId, top }

let localEngine = null;
let remoteEngine = null;
let DEBUG = false;

function dlog(...args) {
  if (DEBUG) console.log("[live-caption]", ...args);
}
LCSettings.get().then((s) => (DEBUG = s.debug));

/** How much of the time the recogniser is allowed to be running.
 *
 * Whisper decodes a padded 30 s window whatever the phrase length, so on a
 * CPU-only machine one interim decode costs more than the interval between
 * them: left alone the engine runs back to back and pins a core, which is
 * what makes Firefox put up the "slowing down" notice. Final decodes always
 * run — a committed line must never be lost — but interim ones wait until the
 * engine has been idle long enough to hold the budget.
 *
 * The budget has to be tighter than the rhythm the segmenter already imposes
 * or it changes nothing: partial updates are emitted roughly every 1.5 s, so
 * anything above ~0.5 leaves an expensive recogniser running back to back.
 * A quarter keeps the default model updating the line about every 1.6 s while
 * leaving three quarters of the time idle. */
const DUTY_CYCLE = { high: 0.95, balanced: 0.25, low: 0 };

function interimAllowed(mode, hidden, lastDecodeMs, idleForMs) {
  if (hidden) return false; // nobody can see the panel; commit lines only
  const duty = DUTY_CYCLE[mode] != null ? DUTY_CYCLE[mode] : DUTY_CYCLE.balanced;
  if (duty <= 0) return false;
  if (!lastDecodeMs) return true;
  return idleForMs >= (lastDecodeMs * (1 - duty)) / duty;
}

function engineFor(settings) {
  if (settings.engine === "remote") {
    if (!remoteEngine) remoteEngine = new RemoteEngine((s) => broadcastStatus(s));
    return remoteEngine;
  }
  if (!localEngine) localEngine = new LocalEngine((s) => broadcastStatus(s));
  return localEngine;
}

/* ---------------- sessions ---------------- */

function getSession(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = {
      tabId,
      mode: "auto",       // auto | on | off
      source: "media",    // media | mic
      activeFrameId: null,
      segmenter: null,
      lastFinal: "",
      statusTabId: tabId,
    };
    sessions.set(tabId, s);
  }
  return s;
}

async function ensureSegmenter(session) {
  const settings = await LCSettings.get();
  if (session.segmenter) return session.segmenter;
  session.segmenter = new Segmenter(settings.vad, {
    onInterim: (samples, energy) => decode(session, samples, energy, false),
    onFinal: (samples, energy) => decode(session, samples, energy, true),
  });
  return session.segmenter;
}

async function decode(session, samples, energy, final) {
  const seconds = samples.length / 16000; // capture before the buffer is transferred
  const settings = await LCSettings.get();
  const engine = engineFor(settings);
  if (
    !final &&
    !interimAllowed(settings.cpu, session.hidden, engine.lastDecodeMs,
                    Date.now() - (engine.lastDecodeEndAt || 0))
  ) {
    return; // skip this partial update to keep the CPU budget
  }
  let text;
  try {
    text = await engine.transcribe(samples, settings, { force: final });
  } catch (err) {
    console.error("[live-caption]", err);
    sendToTab(session.tabId, {
      type: "status",
      kind: "error",
      text: `Speech engine error: ${err.message}`,
      show: true,
    });
    return;
  }
  dlog(final ? "final" : "interim", `${seconds.toFixed(1)}s rms=${energy.toFixed(3)}`, "->", text);
  if (text == null) return; // engine was busy; a later window covers this audio
  if (isNoiseText(text, energy)) return;
  if (final) {
    if (text === session.lastFinal) return;
    session.lastFinal = text;
  }
  sendToTab(session.tabId, { type: "caption", text, final });
  if (final) sendToTab(session.tabId, { type: "status", text: "Listening…", kind: "ok" });
}

/* ---------------- messaging ---------------- */

function sendToTab(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

function broadcastStatus(status) {
  for (const session of sessions.values()) {
    if (session.activeFrameId === null && session.mode !== "on") continue;
    sendToTab(session.tabId, { type: "status", ...status });
  }
}

async function configFor(session) {
  const settings = await LCSettings.get();
  return { type: "config", settings, mode: session.mode, source: session.source };
}

async function pushConfig(tabId) {
  const session = getSession(tabId);
  const msg = await configFor(session);
  for (const [port, info] of ports) {
    if (info.tabId !== tabId) continue;
    try { port.postMessage(msg); } catch (_) {}
  }
}

async function updateBadge(session) {
  const on = session.mode === "on" || (session.mode === "auto" && session.activeFrameId !== null);
  try {
    await browser.action.setBadgeText({ tabId: session.tabId, text: on ? "CC" : "" });
    await browser.action.setBadgeBackgroundColor({ tabId: session.tabId, color: "#2f6fed" });
  } catch (_) {}
}

/* ---------------- ports from content scripts ---------------- */

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "lc-frame") return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (tabId == null) return;
  const frameId = port.sender.frameId || 0;
  ports.set(port, { tabId, frameId, top: frameId === 0 });

  port.onMessage.addListener((msg) => onFrameMessage(port, msg));
  port.onDisconnect.addListener(() => {
    const info = ports.get(port);
    ports.delete(port);
    if (!info) return;
    const session = sessions.get(info.tabId);
    if (session && session.activeFrameId === info.frameId) endCapture(session);
  });
});

async function onFrameMessage(port, msg) {
  const info = ports.get(port);
  if (!info) return;
  const session = getSession(info.tabId);

  switch (msg.type) {
    case "hello":
      port.postMessage(await configFor(session));
      break;

    case "session-start": {
      // First frame to report audio owns the session for this tab.
      if (session.activeFrameId !== null && session.activeFrameId !== info.frameId) return;
      session.activeFrameId = info.frameId;
      session.source = msg.source || "media";
      session.hidden = !!msg.hidden;
      session.lastFinal = "";
      dlog("session start", { tabId: session.tabId, frameId: info.frameId, source: session.source });
      await ensureSegmenter(session);
      updateBadge(session);
      sendToTab(session.tabId, { type: "status", text: "Listening…", kind: "busy", show: true });
      const settings = await LCSettings.get();
      engineFor(settings).warmup(settings).catch((err) =>
        sendToTab(session.tabId, {
          type: "status",
          kind: "error",
          text: `Could not load speech model: ${err.message}`,
          show: true,
        })
      );
      break;
    }

    case "audio": {
      if (session.activeFrameId !== info.frameId) return;
      const segmenter = await ensureSegmenter(session);
      segmenter.push(base64ToPcm(msg.pcm));
      break;
    }

    case "session-stop":
      if (session.activeFrameId !== info.frameId) return;
      endCapture(session);
      break;

    case "set-mode":
      session.mode = msg.mode;
      if (msg.mode === "off") endCapture(session, true);
      await pushConfig(session.tabId);
      updateBadge(session);
      break;

    case "save-ui": {
      const ui = {};
      if (msg.fontSize) ui.fontSize = msg.fontSize;
      if (msg.left != null) ui.position = { left: msg.left, top: msg.top };
      if (msg.width != null) ui.size = { width: msg.width, height: msg.height };
      dlog("save-ui", JSON.stringify(ui));
      await LCSettings.set({ ui });
      break;
    }

    case "visibility":
      if (session.activeFrameId === info.frameId) session.hidden = !!msg.hidden;
      break;

    case "capture-status":
      if (msg.error === "no-media") return;
      sendToTab(session.tabId, {
        type: "status",
        kind: "error",
        show: true,
        text:
          msg.error === "mic-denied"
            ? "Microphone access denied"
            : msg.error === "silent-tap"
            ? "This player's audio can't be captured — switch to Microphone in the toolbar popup"
            : "Could not capture audio from this page",
      });
      break;
  }
}

function endCapture(session, clear = false) {
  if (session.segmenter) session.segmenter.flush();
  session.activeFrameId = null;
  session.lastFinal = "";
  if (clear) sendToTab(session.tabId, { type: "clear" });
  updateBadge(session);
}

/* ---------------- popup / options ---------------- */

/** Everything a user needs to see when captions do not show up. */
async function buildDiagnostics() {
  const settings = await LCSettings.get();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  let frame;
  if (tab) {
    try {
      frame = await browser.tabs.sendMessage(tab.id, { type: "ping" }, { frameId: 0 });
    } catch (err) {
      frame = { error: err.message };
    }
  }
  const session = tab ? sessions.get(tab.id) : null;
  return {
    firefox: navigator.userAgent,
    siteAccessGranted: granted,
    tabUrl: tab ? tab.url : null,
    contentScript: frame || { error: "no active tab" },
    session: session
      ? {
          mode: session.mode,
          source: session.source,
          activeFrameId: session.activeFrameId,
          hasSegmenter: !!session.segmenter,
          tabHidden: !!session.hidden,
        }
      : null,
    engine: {
      kind: settings.engine,
      model: settings.model,
      workerStarted: !!(localEngine && localEngine.worker),
      modelReady: !!(localEngine && localEngine.ready),
      busy: !!(localEngine && localEngine.busy),
      downloadProgress: localEngine ? localEngine.loadingProgress : null,
    },
  };
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  switch (msg && msg.type) {
    case "get-state": {
      const settings = await LCSettings.get();
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const session = tab ? getSession(tab.id) : null;
      const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
      return {
        settings,
        granted,
        tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
        mode: session ? session.mode : "auto",
        source: session ? session.source : "media",
        active: session ? session.activeFrameId !== null : false,
        modelReady: !!(localEngine && localEngine.ready),
      };
    }

    case "set-mode": {
      const session = getSession(msg.tabId);
      session.mode = msg.mode;
      session.source = msg.source || session.source;
      if (msg.mode === "off") {
        endCapture(session, true);
        sendToTab(msg.tabId, { type: "stop" });
      } else if (msg.mode === "on") {
        sendToTab(msg.tabId, { type: "start", source: session.source });
      }
      await pushConfig(msg.tabId);
      updateBadge(session);
      return { ok: true };
    }

    case "set-settings": {
      const before = await LCSettings.get();
      const settings = await LCSettings.set(msg.patch);
      const modelChanged =
        before.model !== settings.model ||
        before.dtype !== settings.dtype ||
        before.device !== settings.device ||
        before.engine !== settings.engine;
      if (modelChanged && localEngine) localEngine.reload();
      for (const tabId of sessions.keys()) pushConfig(tabId);
      return { ok: true, settings };
    }

    case "download-model": {
      const settings = await LCSettings.get();
      const engine = engineFor(settings);
      try {
        await engine.warmup(settings);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "diagnose":
      return buildDiagnostics();

    case "clear-model-cache": {
      try {
        await caches.delete("transformers-cache");
        if (localEngine) localEngine.reload();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
  }
});

/* ---------------- lifecycle ---------------- */

browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-captions") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const session = getSession(tab.id);
  const next = session.mode === "off" ? "on" : "off";
  session.mode = next;
  if (next === "off") {
    endCapture(session, true);
    sendToTab(tab.id, { type: "stop" });
  } else {
    sendToTab(tab.id, { type: "start", source: session.source });
  }
  await pushConfig(tab.id);
  updateBadge(session);
});

browser.tabs.onRemoved.addListener((tabId) => sessions.delete(tabId));

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const session = sessions.get(tabId);
  if (!session) return;
  session.activeFrameId = null;
  session.segmenter = null;
  session.lastFinal = "";
  updateBadge(session);
});

LCSettings.onChange((s) => {
  DEBUG = s.debug;
  for (const tabId of sessions.keys()) pushConfig(tabId);
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") browser.runtime.openOptionsPage();
  if (reason === "update") {
    const before = await LCSettings.get();
    const after = await LCSettings.migrate();
    if (after.model !== before.model) {
      dlog("migrated model", before.model, "->", after.model);
      if (localEngine) localEngine.reload();
    }
  }
});


