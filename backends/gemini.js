/**
 * Gemini backend — Google AI Studio (free tier, needs API key)
 *
 * Free limits: 1,500 req/day · 15 RPM · no credit card required
 * Get a key  : https://aistudio.google.com/apikey
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

const LANG_NAME = {
  ja: "日本語 (Japanese)",
  en: "English",
  ar: "العربية (Arabic)",
  hi: "हिंदी (Hindi)",
  pt: "Português (Portuguese)",
  zh: "中文 (Chinese)",
  fr: "Français (French)",
  it: "Italiano (Italian)",
  ko: "한국어 (Korean)",
};


export async function init() {
  if (process.env.GOOGLE_API_KEY) {
    console.log(`  Gemini OK — model: ${MODEL} (server env key)`);
  } else {
    console.log(`  Gemini — API key will be provided by the browser`);
  }
}

/**
 * @param {string}   text
 * @param {string}   sourceLang
 * @param {string[]} targetLangs
 * @param {Function} sendEvent
 * @param {object}   [opts]
 * @param {string}   [opts.apiKey]  — key from browser (overrides env)
 */
export async function translate(text, sourceLang, targetLangs, sendEvent, opts = {}) {
  const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Gemini API key not provided");

  const targets = targetLangs.filter((l) => l !== sourceLang);
  if (targets.length === 0) return;

  const targetList = targets
    .map((l) => `- ${LANG_NAME[l]} → key: "${l}"`)
    .join("\n");

  const prompt =
    `Translate the following ${LANG_NAME[sourceLang]} text:\n` +
    `"${text}"\n\n` +
    `Target languages:\n${targetList}\n\n` +
    "Respond with ONLY the JSON object.";

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    systemInstruction:
      "You are a professional simultaneous interpreter. " +
      "Respond ONLY with a JSON object mapping language codes to translations. " +
      'No markdown, no explanation. Example: {"en":"Hello","fr":"Bonjour"}',
  });
  const result = await model.generateContentStream(prompt);

  let buffer = "";
  const sent = new Set();

  for await (const chunk of result.stream) {
    const piece = chunk.text();
    if (!piece) continue;
    buffer += piece;

    for (const m of buffer.matchAll(/"([a-z]{2})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const [, lang, translation] = m;
      if (targets.includes(lang) && !sent.has(lang)) {
        sent.add(lang);
        sendEvent("translation", { lang, text: translation.replace(/\\"/g, '"') });
      }
    }
  }

  try {
    const clean = buffer.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    sendEvent("final", { translations: JSON.parse(clean) });
  } catch {}
}
