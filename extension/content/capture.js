/* Audio capture: finds whatever is making sound on the page and emits 16 kHz
 * mono PCM blocks.
 *
 * Three sources, because sites play audio in three different ways:
 *   1. <audio>/<video> elements in the DOM      -> MediaWatcher + AudioTap
 *   2. media elements never added to the DOM    -> patched HTMLMediaElement.play
 *      (`new Audio(url).play()`)
 *   3. the Web Audio API with no media element  -> patched AudioNode.connect
 * The patches use Firefox's wrappedJSObject/exportFunction, so no script is
 * injected into the page and a strict page CSP cannot block them. */
"use strict";

(function (LC) {
  const PROCESSOR_BUFFER = 4096;
  const MAX_PAGE_TAPS = 8;
  const SILENCE = 0.0008;

  LC.AudioTap = class AudioTap {
    constructor({ onSamples, onStatus } = {}) {
      this.onSamples = onSamples || (() => {});
      this.onStatus = onStatus || (() => {});
      this.ctx = null;
      this.bus = null;
      this.processor = null;
      this.downsampler = null;
      this.taps = new Map(); // HTMLMediaElement -> tap info
      this.unsupported = new WeakSet(); // media we have proved we cannot capture
      this.ownElements = new WeakSet(); // clones we made, so the hooks skip them
      this.clones = new Map(); // original element -> { clone, node, sync }
      this.pageTaps = new Map(); // page AudioContext -> tap info
      this.micStream = null;
      this.running = false;
      this.silentBlocks = 0;
      this.sawAudio = false;
      this.hooked = false;
      this.active = false; // a caption session is running: do the full work
    }

    /** Strided level check — 1/16th of the reads of a full RMS, and for page
     * taps it avoids copying 4096 samples across the compartment boundary
     * just to discover that the page is silent. */
    probe(channel) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < channel.length; i += 16) {
        const v = channel[i];
        sum += v * v;
        n++;
      }
      return Math.sqrt(sum / Math.max(1, n));
    }

    /* ---------------- our own graph (DOM elements + microphone) ------------ */

    ensureGraph() {
      if (this.ctx) return;
      this.ctx = new AudioContext();
      this.downsampler = new LC.Downsampler(this.ctx.sampleRate);
      this.bus = this.ctx.createGain();
      this.bus.gain.value = 1;

      // ScriptProcessorNode is deprecated but needs no module loading, which
      // makes it immune to strict page CSPs that would block an AudioWorklet.
      this.processor = this.ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
      this.processor.onaudioprocess = (e) =>
        this.handleBlock(e.inputBuffer.getChannelData(0), this.downsampler, "element", true);

      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.bus.connect(this.processor);
      this.processor.connect(mute);
      mute.connect(this.ctx.destination);
    }

    /* A site can route the same sound through more than one tap (a media
     * element that is also piped through Web Audio). Feeding both into the
     * recognizer would interleave two copies of the speech, so the first
     * source that is actually audible owns the stream until it falls quiet. */
    handleBlock(channel, downsampler, key, trackSilence) {
      // Nothing is being captioned: just watch for the audio starting again.
      if (!this.active && this.probe(channel) <= SILENCE) {
        // Keep counting, or a tap that only ever delivers silence (cross-origin
        // media, typically) would never be detected and reported.
        if (trackSilence && this.running) this.countSilence();
        return;
      }
      const level = LC.rms(channel);
      const now = Date.now();
      if (level > SILENCE) {
        if (!this.primary || this.primary === key || now - this.primaryAt > 2000) {
          if (this.primary !== key) LC.log("primary audio source:", key);
          this.primary = key;
          this.primaryAt = now;
        }
      }
      if (this.primary && this.primary !== key) return;

      if (trackSilence) {
        if (level > SILENCE) {
          this.sawAudio = true;
          this.silentBlocks = 0;
        } else if (this.running) {
          this.countSilence();
        }
      }
      const samples = downsampler.process(channel);
      if (samples.length) this.onSamples(samples, level);
    }

    /** ~5 s of digital silence while media plays means the tap is dead,
     * typically cross-origin media served without CORS headers. */
    countSilence() {
      this.silentBlocks++;
      const blocksPerSecond = (this.ctx ? this.ctx.sampleRate : 48000) / PROCESSOR_BUFFER;
      if (!this.sawAudio && this.silentBlocks > blocksPerSecond * 5) {
        this.silentBlocks = 0;
        this.recoverSilentTaps();
      }
    }

    /* ---------------- media elements in the DOM ---------------- */

    async startMedia(elements) {
      this.ensureGraph();
      this.running = true;
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (_) {}
      }
      let tapped = 0;
      for (const el of elements) if (this.tapElement(el)) tapped++;
      return tapped;
    }

    tapElement(el, preferElementSource = false) {
      if (this.unsupported.has(el)) return false;
      const existing = this.taps.get(el);
      if (existing) {
        if (this.tapIsLive(existing)) return true;
        // A captureStream() track ends with the media it came from, so a
        // second play() must be given a fresh tap instead of a dead one.
        LC.log("tap went dead, re-tapping");
        this.dropTap(el);
      }
      this.ensureGraph();

      // 1) captureStream(): non-destructive, page audio path is untouched.
      const stream = preferElementSource ? null : this.captureStream(el);
      if (stream) {
        try {
          const node = this.ctx.createMediaStreamSource(stream);
          node.connect(this.bus);
          this.taps.set(el, { node, stream, method: "captureStream", passthrough: false });
          this.watchTap(el, stream);
          LC.log("tapped via captureStream", el.currentSrc || el.src);
          return true;
        } catch (err) {
          LC.log("createMediaStreamSource failed", err);
        }
      }

      // 2) createMediaElementSource(): permanent re-route, so we have to feed
      // the element's audio back to the speakers ourselves — and we must be
      // sure the audio will come through, or the page goes mute.
      if (!this.canUseElementSource(el)) {
        this.unsupported.add(el);
        this.onStatus({ error: "silent-tap" });
        return false;
      }
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      try {
        const node = this.ctx.createMediaElementSource(el);
        node.connect(this.ctx.destination);
        node.connect(this.bus);
        this.taps.set(el, { node, method: "elementSource", passthrough: true });
        LC.log("tapped via createMediaElementSource", el.currentSrc || el.src);
        return true;
      } catch (err) {
        LC.log("createMediaElementSource failed", err);
        this.onStatus({ error: "tap-failed", detail: String(err && err.message) });
        return false;
      }
    }

    tapIsLive(tap) {
      if (tap.method !== "captureStream") return true;
      const tracks = tap.stream && tap.stream.getAudioTracks ? tap.stream.getAudioTracks() : [];
      return tracks.some((t) => t.readyState === "live");
    }

    dropTap(el) {
      const tap = this.taps.get(el);
      if (!tap) return;
      try { tap.node.disconnect(); } catch (_) {}
      // A captureStream() track keeps running — and keeps costing the page's
      // process — until it is stopped. Dropping the node is not enough.
      if (tap.stream) {
        try { tap.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      }
      if (tap.unwatch) tap.unwatch();
      this.dropClone(el);
      this.taps.delete(el);
      if (this.primary === "element") this.primary = null;
    }

    /** Re-tap when the source dies or the element loads something else. */
    watchTap(el, stream) {
      const drop = () => this.dropTap(el);
      const tracks = stream ? stream.getAudioTracks() : [];
      tracks.forEach((t) => t.addEventListener("ended", drop));
      el.addEventListener("emptied", drop);
      el.addEventListener("loadstart", drop);
      const tap = this.taps.get(el);
      if (tap) {
        tap.unwatch = () => {
          tracks.forEach((t) => t.removeEventListener("ended", drop));
          el.removeEventListener("emptied", drop);
          el.removeEventListener("loadstart", drop);
        };
      }
    }

    /** Last resort for a player we cannot tap: fetch the same stream ourselves
     * with CORS enabled and listen to that instead.
     *
     * Plenty of radio players build a `new Audio(url)` without a crossorigin
     * attribute, so the browser treats the audio as tainted and hands us
     * silence — even when the server itself allows CORS, which most do. A
     * second element that does ask for CORS gets real samples. It is never
     * connected to the speakers, so the page's own playback is what the user
     * hears; this one only feeds the recogniser. */
    tryStreamClone(el) {
      if (this.clones.has(el)) return true;
      const url = String(el.currentSrc || el.src || "");
      // blob:/MSE sources cannot be re-fetched, and there is nothing to gain
      // from re-fetching same-origin media that already failed.
      if (!/^https?:/i.test(url) || this.mediaOrigin(el) === location.origin) return false;

      try {
        this.ensureGraph();
        const clone = document.createElement("audio");
        this.ownElements.add(clone);
        clone.crossOrigin = "anonymous";
        clone.preload = "auto";
        clone.src = url;

        const node = this.ctx.createMediaElementSource(clone);
        node.connect(this.bus); // deliberately not connected to ctx.destination

        const live = !isFinite(el.duration);
        if (!live) clone.currentTime = el.currentTime;

        const onError = () => {
          LC.log("stream clone failed", clone.error && clone.error.message);
          this.dropClone(el);
          this.unsupported.add(el);
          this.onStatus({ error: "silent-tap" });
        };
        clone.addEventListener("error", onError);

        const mirror = () => {
          if (el.paused) clone.pause();
          else clone.play().catch(() => {});
          // Keep a recording in step with the player; a live stream has no
          // position to match.
          if (!live && Math.abs(clone.currentTime - el.currentTime) > 0.5) {
            clone.currentTime = el.currentTime;
          }
        };
        for (const type of ["play", "pause", "seeked", "ended"]) el.addEventListener(type, mirror);
        const sync = live ? null : setInterval(mirror, 2000);

        this.clones.set(el, { clone, node, sync, mirror, onError, types: ["play", "pause", "seeked", "ended"] });
        clone.play().catch(() => {});
        this.onStatus({ info: "stream-clone" });
        LC.log("captioning through a CORS clone of", url.slice(0, 80));
        return true;
      } catch (err) {
        LC.log("stream clone failed", err);
        this.dropClone(el);
        return false;
      }
    }

    dropClone(el) {
      const c = this.clones.get(el);
      if (!c) return;
      this.clones.delete(el);
      if (c.sync) clearInterval(c.sync);
      for (const type of c.types) el.removeEventListener(type, c.mirror);
      try { c.node.disconnect(); } catch (_) {}
      try {
        c.clone.removeEventListener("error", c.onError);
        c.clone.pause();
        c.clone.removeAttribute("src");
        c.clone.load();
      } catch (_) {}
    }

    /** Where the media itself comes from. blob:/MSE data was fetched by the
     * page, so it counts as same-origin. */
    mediaOrigin(el) {
      const src = String(el.currentSrc || el.src || "");
      if (!src || /^(blob|data|mediasource):/.test(src)) return location.origin;
      try {
        return new URL(src, location.href).origin;
      } catch (_) {
        return location.origin;
      }
    }

    /** createMediaElementSource() re-routes an element's audio through our
     * graph permanently, and for cross-origin media without CORS the node is
     * required to output silence — which silences the page itself. Never take
     * that path unless the media can actually come through it. */
    canUseElementSource(el) {
      return this.mediaOrigin(el) === location.origin || !!el.crossOrigin;
    }

    captureStream(el) {
      const fn = el.captureStream || el.mozCaptureStream;
      if (typeof fn !== "function") return null;
      try {
        const stream = fn.call(el);
        if (stream && stream.getAudioTracks && stream.getAudioTracks().length) return stream;
        return null;
      } catch (err) {
        LC.log("captureStream failed", err);
        return null;
      }
    }

    /** Deal with a tap that is alive but carrying pure silence.
     *
     * This escalates exactly once, to the Web Audio element source, and then
     * gives up: retrying `captureStream()` on media that cannot be captured
     * (cross-origin without CORS) just mints a new live MediaStream every few
     * seconds, and those keep costing the page's process for as long as the
     * tab is open. */
    recoverSilentTaps() {
      // Iterate a snapshot: re-tapping re-inserts into this.taps, and a Map
      // iterator visits entries added during iteration — which is how the
      // previous version span forever inside an audio callback.
      for (const [el, tap] of Array.from(this.taps)) {
        if (el.paused || el.muted || el.volume === 0) continue;

        if (tap.method === "captureStream") {
          if (!this.canUseElementSource(el)) {
            if (tap.reported) continue;
            tap.reported = true;
            // Re-fetching the stream with CORS is the only way left that does
            // not touch the page's own playback.
            if (this.allowStreamClone && this.tryStreamClone(el)) continue;
            this.unsupported.add(el);
            LC.log("cross-origin media cannot be captured, leaving it alone");
            this.onStatus({ error: "silent-tap" });
            continue;
          }
          LC.log("silent captureStream tap, escalating to element source");
          this.dropTap(el);
          if (!this.tapElement(el, true)) this.onStatus({ error: "silent-tap" });
          continue;
        }

        if (!tap.reported) {
          // Already on the element source and still silent: this media cannot
          // be captured at all. Say so once, and stop trying.
          tap.reported = true;
          this.unsupported.add(el);
          LC.log("media cannot be captured, giving up", String(el.currentSrc || el.src).slice(0, 80));
          this.onStatus({ error: "silent-tap" });
        }
      }
    }

    /* ---------------- page hooks: detached media + Web Audio ------------- */

    /** Patch the page's own prototypes so nothing that makes sound is missed. */
    installPageHooks() {
      if (this.hooked) return false;
      const win = window.wrappedJSObject;
      if (!win || typeof exportFunction !== "function") return false;
      this.hooked = true;
      const self = this;

      // Arguments must be passed one by one: handing a content-compartment
      // array to Function.prototype.apply on a page function makes the page
      // side read `length` off an object it is not allowed to touch
      // ("Permission denied to access property length"), which would break
      // every connect() call on the site.
      const audioNode = win.AudioNode && win.AudioNode.prototype;
      if (audioNode && audioNode.connect) {
        const connect = audioNode.connect;
        this.rawConnect = connect;
        exportFunction(
          function (destination, output, input) {
            const result = connect.call(this, destination, output, input);
            try { self.onPageConnect(this, destination); } catch (err) { LC.log("hook connect", err); }
            return result;
          },
          audioNode,
          { defineAs: "connect" }
        );
      }

      const media = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
      if (media && media.play) {
        const play = media.play;
        exportFunction(
          function () {
            try { self.onPagePlay(this); } catch (err) { LC.log("hook play", err); }
            return play.call(this);
          },
          media,
          { defineAs: "play" }
        );
      }

      LC.log("page audio hooks installed");
      return true;
    }

    /** Anything the page routes to its speakers gets mirrored into a tap. */
    onPageConnect(node, target) {
      if (this.disabled || !node || !target) return;
      const ctx = node.context;
      if (!ctx || target !== ctx.destination) return;
      const tap = this.tapPageContext(ctx);
      if (tap) this.rawConnect.call(node, tap.processor);
    }

    /** `new Audio(src).play()` never enters the DOM, so the watcher misses it. */
    onPagePlay(el) {
      if (this.ownElements.has(el)) return; // our own capture clone
      if (this.disabled || !el || el.isConnected) return; // in the DOM: MediaWatcher handles it
      if (this.taps.has(el)) return;
      this.ensureGraph();
      this.running = true;
      if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
      if (this.tapElement(el)) {
        LC.log("tapped detached media element", String(el.currentSrc || el.src).slice(0, 80));
      }
    }

    /** One silent ScriptProcessor per page AudioContext, fed by its output. */
    tapPageContext(ctx) {
      const existing = this.pageTaps.get(ctx);
      if (existing) return existing;
      // Some players build a fresh AudioContext per sound. Tap a handful and
      // stop: each tap costs a processor callback for the life of the page.
      if (this.pageTaps.size >= MAX_PAGE_TAPS) return null;
      try {
        const processor = ctx.createScriptProcessor(PROCESSOR_BUFFER, 1, 1);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        this.rawConnect.call(processor, mute);
        this.rawConnect.call(mute, ctx.destination);

        const downsampler = new LC.Downsampler(ctx.sampleRate);
        const key = "webaudio:" + (this.pageTaps.size + 1);
        const tap = { processor, mute, downsampler, key };
        processor.onaudioprocess = exportFunction((event) => {
          const raw = event.inputBuffer.getChannelData(0);
          // Every read of `raw` crosses the compartment boundary, so check a
          // strided sample first and bail out before copying 4096 of them.
          if (!this.active && this.probe(raw) <= SILENCE) return;
          if (this.primary && this.primary !== key && Date.now() - this.primaryAt < 2000) return;
          const block = new Float32Array(raw.length);
          for (let i = 0; i < raw.length; i++) block[i] = raw[i];
          this.handleBlock(block, downsampler, key, false);
        }, window.wrappedJSObject);

        this.pageTaps.set(ctx, tap);
        LC.log("tapped page AudioContext", ctx.sampleRate + " Hz");
        return tap;
      } catch (err) {
        LC.log("page context tap failed", err);
        return null;
      }
    }

    /* ---------------- microphone ---------------- */

    async startMic() {
      this.ensureGraph();
      this.running = true;
      if (this.micStream) return true;
      try {
        this.micStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        this.running = false;
        this.onStatus({ error: "mic-denied", detail: String(err && err.message) });
        return false;
      }
      const node = this.ctx.createMediaStreamSource(this.micStream);
      node.connect(this.bus);
      this.micNode = node;
      if (this.ctx.state === "suspended") {
        try { await this.ctx.resume(); } catch (_) {}
      }
      return true;
    }

    /* ---------------- teardown ---------------- */

    stop() {
      this.running = false;
      this.sawAudio = false;
      this.silentBlocks = 0;
      this.primary = null;

      for (const [el, tap] of this.taps) {
        if (tap.passthrough) {
          // Keep source -> destination alive, or the page would go mute.
          if (tap.method !== "detachedElement") {
            try { tap.node.disconnect(this.bus); } catch (_) {}
          }
        } else {
          try { tap.node.disconnect(); } catch (_) {}
          this.taps.delete(el);
        }
      }

      for (const el of Array.from(this.clones.keys())) this.dropClone(el);
      if (this.micNode) { try { this.micNode.disconnect(); } catch (_) {} this.micNode = null; }
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => t.stop());
        this.micStream = null;
      }

      // With nothing left to listen to, stop our own context entirely. Taps
      // that re-route an element's audio must keep running or the page would
      // go silent, so those keep the context alive.
      if (this.ctx && this.ctx.state === "running" && !this.hasPassthroughTaps() && !this.micStream) {
        this.ctx.suspend().catch(() => {});
      }
    }

    /** Element-source taps carry the page's own sound; suspending the context
     * while one exists would mute the page. */
    hasPassthroughTaps() {
      for (const tap of this.taps.values()) if (tap.passthrough) return true;
      return false;
    }

    /** Called when a stretch of audio ends, so the next one is judged afresh. */
    noteIdle() {
      this.running = false;
      this.sawAudio = false;
      this.silentBlocks = 0;
      this.primary = null;
      for (const [el, tap] of this.taps) {
        if (!this.tapIsLive(tap)) this.dropTap(el);
      }
    }

    describe() {
      return {
        elementTaps: Array.from(this.taps.values()).map((t) => t.method),
        webAudioContexts: this.pageTaps.size,
        hooksInstalled: this.hooked,
        primarySource: this.primary || null,
        streamClones: this.clones.size,
        heardAudio: this.sawAudio,
      };
    }
  };

  /* ---------------- playback detection ---------------- */

  LC.MediaWatcher = class MediaWatcher {
    constructor(onChange) {
      this.onChange = onChange;
      this.bound = false;
      this.handler = () => this.onChange(this.playingElements());
    }

    playingElements() {
      const els = Array.from(document.querySelectorAll("video, audio"));
      return els.filter(
        (el) => !el.paused && !el.ended && !el.muted && el.volume > 0 && el.readyState >= 2
      );
    }

    start() {
      if (this.bound) return;
      this.bound = true;
      for (const type of ["play", "playing", "pause", "ended", "volumechange", "emptied"]) {
        document.addEventListener(type, this.handler, true);
      }
      this.handler();
    }

    /** The capture-phase listeners catch playback starting; the 2 s sweep only
     * exists to notice players that change state without firing events, so it
     * runs while captions are on and never on an idle page. */
    setPolling(on) {
      if (on && !this.timer) this.timer = setInterval(this.handler, 2000);
      if (!on && this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    stop() {
      if (!this.bound) return;
      this.bound = false;
      for (const type of ["play", "playing", "pause", "ended", "volumechange", "emptied"]) {
        document.removeEventListener(type, this.handler, true);
      }
      this.setPolling(false);
    }
  };
})(globalThis.LiveCaption);
