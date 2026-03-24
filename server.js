import Anthropic from "@anthropic-ai/sdk";
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

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const LANGUAGES = {
  ja: "日本語",
  en: "English",
  ar: "العربية",
  hi: "हिंदी",
  pt: "Português",
  zh: "中文",
  fr: "Français",
  it: "Italiano",
  ko: "한국어",
};

// POST /api/translate — streaming translation via SSE
app.post("/api/translate", async (req, res) => {
  const { text, sourceLang, targetLangs } = req.body;

  if (!text || !sourceLang || !targetLangs || targetLangs.length === 0) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set" });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const targetList = targetLangs
    .filter((lang) => lang !== sourceLang)
    .map((lang) => `- ${LANGUAGES[lang]} (${lang})`)
    .join("\n");

  if (!targetList) {
    sendEvent("done", {});
    res.end();
    return;
  }

  const systemPrompt = `You are a professional simultaneous interpreter.
Translate the given text from ${LANGUAGES[sourceLang]} into ALL of the following languages.

Output ONLY a JSON object with language codes as keys and translations as values.
Do not include any explanation, markdown formatting, or extra text.
Example format: {"en":"Hello","fr":"Bonjour","ja":"こんにちは"}`;

  const userPrompt = `Translate this text from ${LANGUAGES[sourceLang]}:
"${text}"

Target languages:
${targetList}

Respond with ONLY the JSON object.`;

  try {
    let buffer = "";

    const stream = client.messages.stream({
      model: "claude-opus-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        buffer += event.delta.text;

        // Try to parse partial JSON as it streams in
        // Send incremental updates when we find complete key-value pairs
        const partialMatches = buffer.matchAll(/"([a-z]{2})"\s*:\s*"([^"]+)"/g);
        for (const match of partialMatches) {
          const [, langCode, translation] = match;
          if (targetLangs.includes(langCode) && langCode !== sourceLang) {
            sendEvent("translation", { lang: langCode, text: translation });
          }
        }
      }
    }

    // Final parse to ensure all translations are sent
    try {
      const cleaned = buffer.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "");
      const translations = JSON.parse(cleaned);
      sendEvent("final", { translations });
    } catch {
      // If JSON parse fails, the partial events already sent are sufficient
    }

    sendEvent("done", {});
    res.end();
  } catch (error) {
    console.error("Translation error:", error);
    sendEvent("error", {
      message: error.message || "Translation failed",
    });
    res.end();
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nVoice Translation App running at http://localhost:${PORT}`);
  console.log(
    `API Key: ${process.env.ANTHROPIC_API_KEY ? "✓ Set" : "✗ Not set (set ANTHROPIC_API_KEY)"}`
  );
});
