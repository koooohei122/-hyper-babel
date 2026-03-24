import { GoogleGenerativeAI } from "@google/generative-ai";
import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const LANGUAGES = {
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

// Build Gemini client lazily so missing key gives a clear error at request time
function getModel() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set");
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    generationConfig: {
      temperature: 0.1,       // Low temperature → consistent, accurate translations
      maxOutputTokens: 2048,
    },
    systemInstruction: `You are a professional simultaneous interpreter.
When given text and a list of target languages, return ONLY a single JSON object mapping
language codes to their translations. No markdown, no explanation, no extra text.
Example: {"en":"Hello","fr":"Bonjour","ja":"こんにちは"}`,
  });
}

// POST /api/translate  — streams translations via SSE
app.post("/api/translate", async (req, res) => {
  const { text, sourceLang, targetLangs } = req.body;

  if (!text?.trim() || !sourceLang || !targetLangs?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const targets = targetLangs.filter((l) => l !== sourceLang);
  if (targets.length === 0) { send("done", {}); res.end(); return; }

  const targetList = targets
    .map((l) => `- ${LANGUAGES[l]} → key: "${l}"`)
    .join("\n");

  const prompt = `Translate the following ${LANGUAGES[sourceLang]} text into ALL languages listed below.
Respond with ONLY a JSON object using the exact key names shown.

Text to translate:
"${text}"

Target languages:
${targetList}`;

  try {
    const model = getModel();
    const result = await model.generateContentStream(prompt);

    let buffer = "";
    const sent = new Set();

    for await (const chunk of result.stream) {
      const piece = chunk.text();
      if (!piece) continue;
      buffer += piece;

      // Stream partial translations as soon as we see complete key:"value" pairs
      for (const match of buffer.matchAll(/"([a-z]{2})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        const [, lang, translation] = match;
        if (targets.includes(lang) && !sent.has(lang)) {
          sent.add(lang);
          send("translation", { lang, text: translation.replace(/\\"/g, '"') });
        }
      }
    }

    // Final pass — parse the full JSON to catch anything missed
    try {
      const clean = buffer.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      const all = JSON.parse(clean);
      send("final", { translations: all });
    } catch {
      // Partial events already cover the content
    }

    send("done", {});
    res.end();
  } catch (err) {
    console.error("Translation error:", err.message);
    send("error", { message: err.message });
    res.end();
  }
});

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.GOOGLE_API_KEY,
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚡ Hyper Babel  →  http://localhost:${PORT}`);
  console.log(
    `   Gemini model : ${process.env.GEMINI_MODEL || "gemini-2.0-flash"}`
  );
  console.log(
    `   API key      : ${process.env.GOOGLE_API_KEY ? "✓ set" : "✗ missing  →  set GOOGLE_API_KEY in .env"}`
  );
});
