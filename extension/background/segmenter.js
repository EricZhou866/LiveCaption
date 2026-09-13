/* Energy VAD + utterance segmentation.
 *
 * Audio arrives as a continuous 16 kHz stream. We cut it into utterances on
 * pauses, re-decoding the growing utterance every ~1 s so the caption updates
 * while someone is still speaking, then committing the line on the pause. */
"use strict";

const FRAME = 320; // 20 ms @ 16 kHz

class Segmenter {
  constructor(vad, handlers) {
    this.vad = vad;
    this.onInterim = handlers.onInterim || (() => {});
    this.onFinal = handlers.onFinal || (() => {});

    this.capacity = Math.ceil(((vad.maxUtteranceMs + 2000) / 1000) * 16000);
    this.buffer = new Float32Array(this.capacity);
    this.length = 0;
    this.leftover = new Float32Array(0);
    this.prerollSamples = Math.ceil((vad.prerollMs / 1000) * 16000);

    this.noiseFloor = 0.004;
    this.reset();
  }

  reset() {
    this.length = 0;
    this.hasSpeech = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.energySum = 0;
    this.energyFrames = 0;
    this.lastInterimAt = 0;
    this.lastInterimLength = 0;
  }

  get durationMs() {
    return (this.length / 16000) * 1000;
  }

  get meanEnergy() {
    return this.energyFrames ? this.energySum / this.energyFrames : 0;
  }

  push(samples) {
    let data = samples;
    if (this.leftover.length) {
      data = new Float32Array(this.leftover.length + samples.length);
      data.set(this.leftover, 0);
      data.set(samples, this.leftover.length);
    }
    let offset = 0;
    while (offset + FRAME <= data.length) {
      this.processFrame(data.subarray(offset, offset + FRAME));
      offset += FRAME;
    }
    this.leftover = data.slice(offset);
  }

  processFrame(frame) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / FRAME);

    // Slow-attack / fast-decay noise floor so the VAD adapts to room tone,
    // music beds and codec noise instead of a single fixed threshold.
    this.noiseFloor =
      rms < this.noiseFloor
        ? this.noiseFloor * 0.9 + rms * 0.1
        : this.noiseFloor * 0.9995 + rms * 0.0005;

    const isSpeech = rms > Math.max(this.vad.threshold, this.noiseFloor * 3);

    this.append(frame);

    if (isSpeech) {
      this.hasSpeech = true;
      this.speechMs += 20;
      this.silenceMs = 0;
      this.energySum += rms;
      this.energyFrames++;
    } else if (this.hasSpeech) {
      this.silenceMs += 20;
    } else if (this.length > this.prerollSamples) {
      // Keep a short pre-roll so the first word is never clipped.
      this.buffer.copyWithin(0, this.length - this.prerollSamples, this.length);
      this.length = this.prerollSamples;
    }

    if (!this.hasSpeech) return;

    if (this.silenceMs >= this.vad.silenceMs) {
      if (this.speechMs >= this.vad.minSpeechMs) this.emit(true);
      else this.reset();
      return;
    }

    if (this.durationMs >= this.vad.maxUtteranceMs) {
      this.emit(true, true);
      return;
    }

    const now = Date.now();
    const grew = this.length - this.lastInterimLength > 16000 * 0.4;
    if (
      this.speechMs >= this.vad.minSpeechMs &&
      grew &&
      now - this.lastInterimAt >= this.vad.interimMs
    ) {
      this.lastInterimAt = now;
      this.lastInterimLength = this.length;
      this.onInterim(this.snapshot(), this.meanEnergy);
    }
  }

  append(frame) {
    if (this.length + FRAME > this.capacity) {
      // Should not happen (maxUtterance cuts first), but never overflow.
      if (this.hasSpeech && this.speechMs >= this.vad.minSpeechMs) this.emit(true, true);
      else this.reset();
    }
    this.buffer.set(frame, this.length);
    this.length += FRAME;
  }

  snapshot() {
    return this.buffer.slice(0, this.length);
  }

  emit(final, continued = false) {
    const samples = this.snapshot();
    const energy = this.meanEnergy;
    this.reset();
    if (final) this.onFinal(samples, energy, continued);
    else this.onInterim(samples, energy);
  }

  /** Commit whatever is buffered, e.g. when playback stops. */
  flush() {
    if (this.hasSpeech && this.speechMs >= this.vad.minSpeechMs) this.emit(true);
    else this.reset();
  }
}

/* Whisper emits stock phrases when fed near-silence or music. */
const HALLUCINATIONS = new Set([
  "you", "thank you.", "thanks for watching!", "thank you for watching!",
  "thanks for watching.", "bye.", "bye bye.", ".", "so", "[blank_audio]",
  "(upbeat music)", "(music)", "(soft music)", "♪", "♪♪", "the",
]);

function isNoiseText(text, meanEnergy) {
  const t = (text || "").trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  if (HALLUCINATIONS.has(lower) && meanEnergy < 0.05) return true;
  if (/^[\s.,!?-]*$/.test(t)) return true;
  // "you you you you" style loops
  const words = lower.split(/\s+/);
  if (words.length > 5 && new Set(words).size <= 2) return true;
  return false;
}
