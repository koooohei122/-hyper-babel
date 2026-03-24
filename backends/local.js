/**
 * Local translation backend — NLLB-200 via @huggingface/transformers
 *
 * Model : Xenova/nllb-200-distilled-600M (q8 quantized, ~350 MB)
 * Source: Meta AI — supports 200 languages, runs 100% offline after first download
 * Cache : ./.cache/models  (persists between restarts)
 */

import { pipeline, env } from "@huggingface/transformers";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep models in project folder so they survive npm ci
env.cacheDir = join(__dirname, "..", ".cache", "models");
env.allowRemoteModels = true;

const MODEL_ID = process.env.LOCAL_MODEL || "Xenova/nllb-200-distilled-600M";
const DTYPE    = process.env.LOCAL_DTYPE  || "q8";   // q4 / q8 / fp32

// NLLB BCP-47-style codes
const NLLB_CODE = {
  ja: "jpn_Jpan",
  en: "eng_Latn",
  ar: "arb_Arab",
  hi: "hin_Deva",
  pt: "por_Latn",
  zh: "zho_Hans",
  fr: "fra_Latn",
  it: "ita_Latn",
  ko: "kor_Hang",
};

let _pipe = null;

export async function init() {
  const isFirstRun = !_pipe;
  if (isFirstRun) {
    console.log(`\n  Loading model: ${MODEL_ID}  (dtype=${DTYPE})`);
    console.log("  First run: downloading model files (~350 MB) ...\n");
  }
  _pipe = await pipeline("translation", MODEL_ID, {
    dtype: DTYPE,
    progress_callback: isFirstRun
      ? (p) => {
          if (p.status === "downloading") {
            const pct = p.total
              ? Math.round((p.loaded / p.total) * 100)
              : "?";
            process.stdout.write(`\r  Downloading ${p.file} … ${pct}%   `);
          } else if (p.status === "ready") {
            process.stdout.write("\n");
          }
        }
      : undefined,
  });
  if (isFirstRun) console.log("  Model ready!\n");
}

/**
 * Translate `text` from `sourceLang` into each of `targetLangs`.
 * Sends SSE events as each language completes for live feedback.
 *
 * @param {string}   text
 * @param {string}   sourceLang  ISO-639-1 code
 * @param {string[]} targetLangs ISO-639-1 codes
 * @param {Function} sendEvent   (event, data) => void
 */
export async function translate(text, sourceLang, targetLangs, sendEvent) {
  if (!_pipe) throw new Error("Local model not initialised — call init() first");

  const srcCode = NLLB_CODE[sourceLang];
  if (!srcCode) throw new Error(`Unsupported source language: ${sourceLang}`);

  const targets = targetLangs.filter((l) => l !== sourceLang && NLLB_CODE[l]);

  // Translate sequentially; each result is streamed back immediately
  const finalTranslations = {};
  for (const lang of targets) {
    try {
      const [result] = await _pipe(text, {
        src_lang: srcCode,
        tgt_lang: NLLB_CODE[lang],
        max_new_tokens: 256,
      });
      const translated = result.translation_text ?? "";
      finalTranslations[lang] = translated;
      sendEvent("translation", { lang, text: translated });
    } catch (err) {
      console.error(`  NLLB error (${lang}):`, err.message);
      sendEvent("translation", { lang, text: "⚠ translation error" });
    }
  }

  sendEvent("final", { translations: finalTranslations });
}
