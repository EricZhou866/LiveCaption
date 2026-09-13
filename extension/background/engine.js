/* Speech-to-text engines: a local Whisper worker, or an OpenAI-compatible
 * HTTP endpoint for people who prefer a server (self-hosted whisper.cpp, …). */
"use strict";

class LocalEngine {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.busy = false;
    this.ready = false;
    this.loadingProgress = null;
    this.queue = Promise.resolve();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(browser.runtime.getURL("background/asr-worker.js"), { type: "module" });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      this.onStatus({ kind: "error", text: "Speech engine failed to start" });
      console.error(
        "[live-caption] worker error",
        JSON.stringify({ message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }),
        e.error || ""
      );
      for (const [, p] of this.pending) p.reject(new Error(e.message || "worker error"));
      this.pending.clear();
      this.busy = false;
    };
    return this.worker;
  }

  onWorkerMessage(msg) {
    if (msg.type === "progress") {
      const p = msg.payload || {};
      if (p.status === "progress" && p.total) {
        const pct = Math.round((p.loaded / p.total) * 100);
        this.loadingProgress = pct;
        this.onStatus({ kind: "busy", text: `Downloading speech model… ${pct}%`, show: true });
      } else if (p.status === "ready" || p.status === "done") {
        this.loadingProgress = null;
      }
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.type === "error") entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  }

  post(msg, transfer = []) {
    const id = this.nextId++;
    this.ensureWorker().postMessage({ ...msg, id }, transfer);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async warmup(settings) {
    if (this.ready) return;
    this.onStatus({ kind: "busy", text: "Loading speech model…", show: true });
    await this.post({
      type: "load",
      model: settings.model,
      dtype: settings.dtype,
      device: settings.device,
    });
    this.ready = true;
    this.onStatus({ kind: "ok", text: "Listening…" });
  }

  /** Interim windows are dropped while the engine is busy; final windows are
   * queued, because a committed caption line must never be lost. */
  async transcribe(samples, settings, { force = false } = {}) {
    if (this.busy && !force) return null;
    const run = this.queue.catch(() => {}).then(() => this.run(samples, settings));
    this.queue = run.catch(() => {});
    return run;
  }

  async run(samples, settings) {
    this.busy = true;
    try {
      await this.warmup(settings);
      const t0 = Date.now();
      const seconds = samples.length / 16000; // samples.buffer is transferred below
      const res = await this.post(
        {
          type: "transcribe",
          audio: samples,
          model: settings.model,
          dtype: settings.dtype,
          device: settings.device,
          language: settings.language,
          task: settings.task,
        },
        [samples.buffer]
      );
      dlog(`decoded ${seconds.toFixed(1)}s in ${Date.now() - t0} ms`);
      return res.text;
    } finally {
      this.busy = false;
    }
  }

  reload() {
    this.ready = false;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    this.pending.clear();
    this.busy = false;
  }
}

class RemoteEngine {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.busy = false;
    this.queue = Promise.resolve();
  }

  async transcribe(samples, settings, { force = false } = {}) {
    const cfg = settings.remote || {};
    if (!cfg.url) {
      this.onStatus({ kind: "error", text: "No transcription endpoint configured", show: true });
      return null;
    }
    if (this.busy && !force) return null;
    const run = this.queue.catch(() => {}).then(() => this.run(samples, settings, cfg));
    this.queue = run.catch(() => {});
    return run;
  }

  async run(samples, settings, cfg) {
    this.busy = true;
    try {
      const form = new FormData();
      form.append("file", encodeWav(samples, 16000), "audio.wav");
      form.append("model", cfg.model || "whisper-1");
      form.append("response_format", "json");
      if (settings.language) form.append("language", settings.language);
      if (settings.task === "translate") form.append("task", "translate");

      const headers = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      const res = await fetch(cfg.url, { method: "POST", body: form, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.text || "").trim();
    } catch (err) {
      this.onStatus({ kind: "error", text: `Transcription failed: ${err.message}`, show: true });
      return null;
    } finally {
      this.busy = false;
    }
  }

  reload() {}
  async warmup() {}
}
