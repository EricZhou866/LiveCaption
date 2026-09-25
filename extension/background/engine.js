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
    this.lastDecodeMs = 0;
    this.lastDecodeEndAt = 0;
    this.decodedSinceLoad = 0;
    // A request that outlives these is treated as a stalled engine. The first
    // decode after a load is allowed longer: WebGPU compiles its shaders then.
    this.timeouts = { load: 300000, firstDecode: 90000, decode: 30000 };
    this.forceWasm = false; // WebGPU failed here; use the CPU until settings change
  }

  device(settings) {
    return this.forceWasm ? "wasm" : settings.device;
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new Worker(browser.runtime.getURL("background/asr-worker.js"), { type: "module" });
    this.worker.onmessage = (e) => this.onWorkerMessage(e.data);
    this.worker.onerror = (e) => {
      console.error(
        "[live-caption] worker error",
        JSON.stringify({ message: e.message, filename: e.filename, lineno: e.lineno, colno: e.colno }),
        e.error || ""
      );
      this.restart(new Error(e.message || "speech engine crashed"));
      this.onStatus({ kind: "error", text: "Speech engine failed to start", show: true });
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
    clearTimeout(entry.timer);
    if (msg.type === "error") entry.reject(new Error(msg.message));
    else entry.resolve(msg);
  }

  post(msg, transfer = [], timeoutMs = 0) {
    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (timeoutMs) {
        entry.timer = setTimeout(
          () => this.restart(new Error(`speech engine stalled for ${Math.round(timeoutMs / 1000)} s`)),
          timeoutMs
        );
      }
      this.pending.set(id, entry);
      worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Throw the worker away and fail everything that was waiting on it. Every
   * caller — and everything queued behind a caller — must be released, or one
   * request that never answers freezes captions for good. */
  restart(err) {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    const waiting = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of waiting) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.ready = false;
    this.busy = false;
    this.loadingProgress = null;
  }

  async warmup(settings) {
    if (this.ready) return;
    this.onStatus({ kind: "busy", text: "Loading speech model…", show: true });
    await this.post(
      { type: "load", model: settings.model, dtype: settings.dtype, device: this.device(settings) },
      [],
      this.timeouts.load
    );
    this.ready = true;
    this.decodedSinceLoad = 0;
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
      const onGpu = this.device(settings) === "webgpu";
      try {
        // Keep a copy on WebGPU: the buffer is transferred to the worker, and
        // it is needed again if this attempt has to be retried on the CPU.
        return await this.decodeOnce(onGpu ? samples.slice() : samples, settings);
      } catch (err) {
        if (!onGpu) throw err;
        // WebGPU is missing in this Firefox, or stalled on the model. Use the
        // CPU from here on, tell the user once, and redo this phrase there.
        console.warn("[live-caption] WebGPU failed, falling back to WebAssembly:", err.message);
        this.forceWasm = true;
        this.restart(err);
        this.busy = true;
        this.onStatus({
          kind: "error",
          show: true,
          text: "WebGPU didn't work here — captioning on the CPU (WebAssembly) instead",
        });
        return await this.decodeOnce(samples, settings);
      }
    } finally {
      this.busy = false;
      this.lastDecodeEndAt = Date.now();
    }
  }

  async decodeOnce(samples, settings) {
    await this.warmup(settings);
    const t0 = Date.now();
    const seconds = samples.length / 16000; // samples.buffer is transferred below
    const timeout = this.decodedSinceLoad === 0
      ? this.timeouts.firstDecode
      : Math.max(this.timeouts.decode, this.lastDecodeMs * 10);
    const res = await this.post(
      {
        type: "transcribe",
        audio: samples,
        model: settings.model,
        dtype: settings.dtype,
        device: this.device(settings),
        language: settings.language,
        task: settings.task,
      },
      [samples.buffer],
      timeout
    );
    this.decodedSinceLoad++;
    this.lastDecodeMs = Date.now() - t0;
    dlog(`decoded ${seconds.toFixed(1)}s in ${this.lastDecodeMs} ms`);
    return res.text;
  }

  /** Settings changed: start over, and give WebGPU another chance. */
  reload() {
    this.forceWasm = false;
    this.restart(new Error("speech engine restarted"));
  }
}

class RemoteEngine {
  constructor(onStatus) {
    this.onStatus = onStatus || (() => {});
    this.busy = false;
    this.queue = Promise.resolve();
    this.lastDecodeMs = 0;
    this.lastDecodeEndAt = 0;
    this.timeoutMs = 30000;
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
    const t0 = Date.now();
    try {
      const form = new FormData();
      form.append("file", encodeWav(samples, 16000), "audio.wav");
      form.append("model", cfg.model || "whisper-1");
      form.append("response_format", "json");
      if (settings.language) form.append("language", settings.language);
      if (settings.task === "translate") form.append("task", "translate");

      const headers = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

      // A server that never answers must not hold the queue: every committed
      // line behind it would wait forever, exactly as with a stalled worker.
      const res = await fetch(cfg.url, {
        method: "POST",
        body: form,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.text || "").trim();
    } catch (err) {
      this.onStatus({ kind: "error", text: `Transcription failed: ${err.message}`, show: true });
      return null;
    } finally {
      this.busy = false;
      this.lastDecodeMs = Date.now() - t0;
      this.lastDecodeEndAt = Date.now();
    }
  }

  reload() {}
  async warmup() {}
}
