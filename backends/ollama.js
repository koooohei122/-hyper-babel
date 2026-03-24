/**
 * Ollama backend — local LLM via http://localhost:11434
 *
 * Install Ollama : https://ollama.com/download
 * Pull a model   : ollama pull gemma3        (~2.5 GB, multilingual)
 *                  ollama pull llama3.2:3b   (~2.0 GB, alternative)
 *
 * Set in .env    :
 *   OLLAMA_URL   = http://localhost:11434   (default)
 *   OLLAMA_MODEL = gemma3                  (default)
 */

const BASE_URL = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "");
const MODEL    = process.env.OLLAMA_MODEL || "gemma3";

const LANG_NAME = {
  ja: "Japanese",
  en: "English",
  ar: "Arabic",
  hi: "Hindi",
  pt: "Portuguese (Brazil)",
  zh: "Simplified Chinese",
  fr: "French",
  it: "Italian",
  ko: "Korean",
};

export async function init() {
  // Health check
  let ok = false;
  try {
    const r = await fetch(`${BASE_URL}/`, { signal: AbortSignal.timeout(3000) });
    ok = r.ok;
  } catch {}

  if (!ok) {
    console.warn(`\n  ⚠  Ollama not reachable at ${BASE_URL}`);
    console.warn("     Start it with: ollama serve");
    console.warn(`     Then pull the model: ollama pull ${MODEL}\n`);
  } else {
    console.log(`  Ollama OK — model: ${MODEL}`);
  }
}

/**
 * @param {string}   text
 * @param {string}   sourceLang
 * @param {string[]} targetLangs
 * @param {Function} sendEvent
 */
export async function translate(text, sourceLang, targetLangs, sendEvent) {
  const targets = targetLangs.filter((l) => l !== sourceLang && LANG_NAME[l]);
  if (targets.length === 0) return;

  const targetList = targets
    .map((l) => `- ${LANG_NAME[l]} → key: "${l}"`)
    .join("\n");

  const systemPrompt =
    "You are a professional simultaneous interpreter. " +
    "Respond ONLY with a JSON object mapping language codes to their translations. " +
    "No markdown, no explanation, no extra text.\n" +
    'Example: {"en":"Hello","fr":"Bonjour"}';

  const userPrompt =
    `Translate the following ${LANG_NAME[sourceLang]} text into ALL languages listed below.\n\n` +
    `Text: "${text}"\n\n` +
    `Target languages:\n${targetList}\n\n` +
    "Respond with ONLY the JSON object.";

  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      options: { temperature: 0.1 },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
    }),
  });

  if (!response.ok) {
    const msg = await response.text();
    throw new Error(`Ollama error ${response.status}: ${msg}`);
  }

  const reader  = response.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf   = "";
  let jsonBuf   = "";
  const sent    = new Set();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    lineBuf += decoder.decode(value, { stream: true });
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        jsonBuf += msg.message?.content ?? "";
      } catch {}

      // Stream partial translations as JSON key-value pairs arrive
      for (const m of jsonBuf.matchAll(/"([a-z]{2})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        const [, lang, translation] = m;
        if (targets.includes(lang) && !sent.has(lang)) {
          sent.add(lang);
          sendEvent("translation", { lang, text: translation.replace(/\\"/g, '"') });
        }
      }
    }
  }

  // Final JSON parse to catch any remaining translations
  try {
    const clean = jsonBuf.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    const all   = JSON.parse(clean);
    sendEvent("final", { translations: all });
  } catch {
    // Partial SSE events already delivered — no-op
  }
}
