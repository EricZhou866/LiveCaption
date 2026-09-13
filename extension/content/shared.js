/* Shared helpers for all content scripts. Content scripts of one extension
 * share a single sandbox global per document, so this namespace is visible
 * to capture.js / overlay.js / main.js. */
"use strict";

var LiveCaption = (globalThis.LiveCaption = globalThis.LiveCaption || {});

LiveCaption.SAMPLE_RATE = 16000;

LiveCaption.log = (...args) => {
  if (LiveCaption.debug) console.log("[live-caption]", ...args);
};

/**
 * Anti-aliased decimator: box-filters and resamples an arbitrary-rate mono
 * stream down to 16 kHz, carrying the fractional remainder between blocks.
 */
LiveCaption.Downsampler = class Downsampler {
  constructor(srcRate, dstRate = LiveCaption.SAMPLE_RATE) {
    this.ratio = srcRate / dstRate;
    this.tail = new Float32Array(0);
    this.pos = 0; // fractional read position inside `tail`
  }

  process(input) {
    if (this.ratio <= 1.0001) return Float32Array.from(input);

    const buf = new Float32Array(this.tail.length + input.length);
    buf.set(this.tail, 0);
    buf.set(input, this.tail.length);

    const out = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const start = Math.floor(pos);
      const end = Math.floor(pos + this.ratio);
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      out.push(sum / Math.max(1, end - start));
      pos += this.ratio;
    }

    const consumed = Math.floor(pos);
    this.tail = buf.slice(consumed);
    this.pos = pos - consumed;
    return Float32Array.from(out);
  }
};

/** Float32 [-1,1] PCM -> base64 of little-endian Int16, for structured-clone
 * free transport over runtime ports. */
LiveCaption.pcmToBase64 = function (float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

LiveCaption.rms = function (samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
};
