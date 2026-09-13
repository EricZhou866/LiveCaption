"use strict";

const el = (id) => document.getElementById(id);
let state = null;

async function refresh() {
  state = await browser.runtime.sendMessage({ type: "get-state" });
  if (!state) return;

  el("enabled").checked = state.settings.enabled;
  document.body.classList.toggle("disabled", !state.settings.enabled);
  el("permission").hidden = state.granted;

  for (const b of document.querySelectorAll("#mode button")) {
    b.classList.toggle("active", b.dataset.mode === state.mode);
  }
  for (const b of document.querySelectorAll("#source button")) {
    b.classList.toggle("active", b.dataset.source === state.source);
  }

  el("modeHint").textContent =
    state.mode === "auto"
      ? "Auto shows captions whenever this tab plays audio."
      : state.mode === "on"
      ? "Captions stay on for this tab."
      : "Captions are off for this tab.";

  const engine = state.settings.engine === "remote" ? "Remote endpoint" : shortModel(state.settings.model);
  el("engineLabel").textContent = engine;

  const dot = el("dot");
  if (state.mode === "off") { dot.className = "dot"; el("status").textContent = "Off for this tab"; }
  else if (state.active) { dot.className = "dot on"; el("status").textContent = "Captioning this tab"; }
  else if (state.modelReady) { dot.className = "dot on"; el("status").textContent = "Ready — waiting for audio"; }
  else { dot.className = "dot busy"; el("status").textContent = "Model loads on first audio"; }
}

function shortModel(id) {
  return String(id).split("/").pop();
}

el("enabled").addEventListener("change", async (e) => {
  await browser.runtime.sendMessage({ type: "set-settings", patch: { enabled: e.target.checked } });
  refresh();
});

el("mode").addEventListener("click", async (e) => {
  const mode = e.target.dataset && e.target.dataset.mode;
  if (!mode || !state || !state.tab) return;
  await browser.runtime.sendMessage({ type: "set-mode", tabId: state.tab.id, mode });
  refresh();
});

el("source").addEventListener("click", async (e) => {
  const source = e.target.dataset && e.target.dataset.source;
  if (!source || !state || !state.tab) return;
  // Switching source restarts capture on the tab.
  await browser.runtime.sendMessage({ type: "set-mode", tabId: state.tab.id, mode: "off" });
  await browser.runtime.sendMessage({
    type: "set-mode",
    tabId: state.tab.id,
    mode: source === "mic" ? "on" : "auto",
    source,
  });
  refresh();
});

el("grant").addEventListener("click", async () => {
  const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
  if (granted) {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab) browser.tabs.reload(tab.id);
  }
  refresh();
});

el("options").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

refresh();
setInterval(refresh, 1500);
