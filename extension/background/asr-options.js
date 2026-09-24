/* Pure option builders for the recogniser, shared by the worker and the tests. */

/** Precision is only a real choice on the CPU. ONNX Runtime's WebGPU backend
 * has no kernels for most int8 operators, so a quantised model either falls
 * back op by op or stalls outright; on WebGPU use what transformers.js
 * recommends for encoder-decoder speech models instead: a full-precision
 * encoder and a 4-bit decoder. Every model in the picker ships both. */
export function loadOptions(dtype, device) {
  if (device === "webgpu") {
    return {
      device: "webgpu",
      dtype: dtype === "fp16" ? "fp16" : { encoder_model: "fp32", decoder_model_merged: "q4" },
    };
  }
  switch (dtype) {
    case "q4":
      return { device: "wasm", dtype: { encoder_model: "q8", decoder_model_merged: "q4" } };
    case "fp16":
      return { device: "wasm", dtype: "fp16" };
    case "fp32":
      return { device: "wasm", dtype: "fp32" };
    case "q8":
    default:
      return { device: "wasm", dtype: "q8" };
  }
}

/** Whisper always encodes a padded 30-second window, so a short phrase costs
 * as much as a long one; Moonshine's cost follows the length of the audio.
 * They also take different options: Moonshine is English-only and does its
 * own chunking. */
export function decodeOptions(model, language, task) {
  const options = { return_timestamps: false, max_new_tokens: 180, num_beams: 1, do_sample: false };
  const isMoonshine = /moonshine/i.test(model);
  const englishOnly = isMoonshine || /\.en\b|\.en$/.test(model);
  if (!isMoonshine) options.chunk_length_s = 30;
  if (!englishOnly) {
    options.language = language || "en";
    options.task = task === "translate" ? "translate" : "transcribe";
  }
  return options;
}
