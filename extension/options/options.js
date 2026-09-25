"use strict";

const el = (id) => document.getElementById(id);
let settings = null;
let recommended = null;
let savedTimer = null;

function flashSaved() {
  el("saved").classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el("saved").classList.remove("show"), 1200);
}

async function save(patch) {
  const res = await browser.runtime.sendMessage({ type: "set-settings", patch });
  if (res && res.settings) settings = res.settings;
  if (recommended) syncRecommended();
  flashSaved();
}

function bindCheckbox(id, path) {
  el(id).addEventListener("change", (e) => save(nest(path, e.target.checked)));
}

function bindValue(id, path, transform = (v) => v, onInput = null) {
  const node = el(id);
  const handler = (e) => {
    const value = transform(e.target.value);
    if (onInput) onInput(value);
    save(nest(path, value));
  };
  node.addEventListener("change", handler);
  if (node.type === "range") node.addEventListener("input", (e) => onInput && onInput(transform(e.target.value)));
}

function nest(path, value) {
  const parts = path.split(".");
  const out = {};
  let cur = out;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else cur = cur[p] = {};
  });
  return out;
}

function describeHide(ms) {
  return ms > 0 ? ms / 1000 + " s" : "never hide";
}

function isRecommended(s) {
  if (!recommended) return false;
  return Object.keys(recommended).every((k) =>
    k === "vad"
      ? Object.keys(recommended.vad).every((v) => s.vad && s.vad[v] === recommended.vad[v])
      : s[k] === recommended[k]
  );
}

function syncRecommended() {
  const ok = isRecommended(settings);
  el("recommendedState").textContent = ok
    ? "✓ You are using the recommended settings"
    : "You have changed the engine settings";
  el("recommendedState").className = "rec-state" + (ok ? " ok" : "");
  el("useRecommended").hidden = ok;
}

function syncEngineVisibility() {
  const remote = settings.engine === "remote";
  el("localOpts").hidden = remote;
  el("remoteOpts").hidden = !remote;
}

function render() {
  el("enabled").checked = settings.enabled;
  el("autoStart").checked = settings.autoStart;
  el("streamClone").checked = settings.streamClone;
  el("transcript").checked = settings.transcript;
  el("debug").checked = settings.debug;
  el("engine").value = settings.engine;
  el("model").value = settings.model;
  el("dtype").value = settings.dtype;
  el("device").value = settings.device;
  el("cpu").value = settings.cpu;
  el("task").value = settings.task;

  el("remoteUrl").value = settings.remote.url || "";
  el("remoteKey").value = settings.remote.apiKey || "";
  el("remoteModel").value = settings.remote.model || "";

  el("fontSize").value = settings.ui.fontSize;
  el("fontSizeOut").textContent = settings.ui.fontSize + " px";
  el("maxLines").value = settings.ui.maxLines;
  el("maxLinesOut").textContent = settings.ui.maxLines;
  el("opacity").value = settings.ui.opacity;
  el("opacityOut").textContent = Math.round(settings.ui.opacity * 100) + "%";
  el("theme").value = settings.ui.theme;
  el("autoHide").value = Math.round((settings.ui.autoHideMs ?? 5000) / 1000);
  el("autoHideOut").textContent = describeHide(settings.ui.autoHideMs ?? 5000);

  el("silenceMs").value = settings.vad.silenceMs;
  el("silenceOut").textContent = settings.vad.silenceMs + " ms";
  el("interimMs").value = settings.vad.interimMs;
  el("interimOut").textContent = settings.vad.interimMs + " ms";
  el("threshold").value = settings.vad.threshold;
  el("thresholdOut").textContent = settings.vad.threshold.toFixed(3);

  syncEngineVisibility();
  syncRecommended();
}

document.getElementById("version").textContent = "v" + browser.runtime.getManifest().version;

async function init() {
  const state = await browser.runtime.sendMessage({ type: "get-state" });
  settings = state.settings;
  recommended = state.recommended;
  el("permissionCard").hidden = state.granted;
  el("modelStatus").textContent = state.modelReady ? "Model loaded and ready." : "";
  render();

  bindCheckbox("enabled", "enabled");
  bindCheckbox("autoStart", "autoStart");
  bindCheckbox("streamClone", "streamClone");

  // Saving a file needs the optional "downloads" permission; ask for it at the
  // moment the user turns the feature on, and back out if they decline.
  el("transcript").addEventListener("change", async (e) => {
    if (e.target.checked) {
      const granted = await browser.permissions.request({ permissions: ["downloads"] });
      if (!granted) {
        e.target.checked = false;
        return;
      }
    }
    save({ transcript: e.target.checked });
  });
  bindCheckbox("debug", "debug");
  bindValue("engine", "engine", (v) => v, (v) => { settings.engine = v; syncEngineVisibility(); });
  bindValue("model", "model");
  bindValue("dtype", "dtype");
  bindValue("device", "device");
  bindValue("cpu", "cpu");
  bindValue("task", "task");
  bindValue("remoteUrl", "remote.url");
  bindValue("remoteKey", "remote.apiKey");
  bindValue("remoteModel", "remote.model");

  bindValue("fontSize", "ui.fontSize", Number, (v) => (el("fontSizeOut").textContent = v + " px"));
  bindValue("maxLines", "ui.maxLines", Number, (v) => (el("maxLinesOut").textContent = v));
  bindValue("opacity", "ui.opacity", Number, (v) => (el("opacityOut").textContent = Math.round(v * 100) + "%"));
  bindValue("theme", "ui.theme");
  bindValue("autoHide", "ui.autoHideMs", (v) => Number(v) * 1000, (v) =>
    (el("autoHideOut").textContent = describeHide(v))
  );

  bindValue("silenceMs", "vad.silenceMs", Number, (v) => (el("silenceOut").textContent = v + " ms"));
  bindValue("interimMs", "vad.interimMs", Number, (v) => (el("interimOut").textContent = v + " ms"));
  bindValue("threshold", "vad.threshold", Number, (v) => (el("thresholdOut").textContent = Number(v).toFixed(3)));

  el("resetPos").addEventListener("click", () => save({ ui: { position: null } }));

  el("useRecommended").addEventListener("click", async () => {
    await save(JSON.parse(JSON.stringify(recommended)));
    render();
  });
  el("resetSize").addEventListener("click", () => save({ ui: { size: null } }));

  el("download").addEventListener("click", async () => {
    el("modelStatus").textContent = "Downloading… this can take a minute on first use.";
    const res = await browser.runtime.sendMessage({ type: "download-model" });
    el("modelStatus").textContent = res && res.ok ? "Model loaded and ready." : `Failed: ${res && res.error}`;
  });

  el("clearCache").addEventListener("click", async () => {
    const res = await browser.runtime.sendMessage({ type: "clear-model-cache" });
    el("modelStatus").textContent = res && res.ok ? "Cached models removed." : `Failed: ${res && res.error}`;
  });

  el("diagnose").addEventListener("click", async () => {
    const out = el("diagOut");
    out.hidden = false;
    out.textContent = "Running…";
    try {
      const report = await browser.runtime.sendMessage({ type: "diagnose" });
      out.textContent = JSON.stringify(report, null, 2);
    } catch (err) {
      out.textContent = "Diagnostics failed: " + err.message;
    }
  });

  el("grant").addEventListener("click", async () => {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    el("permissionCard").hidden = granted;
  });
}

init();
