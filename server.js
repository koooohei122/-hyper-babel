import express from "express";
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Backend selection ─────────────────────────────────────────────────────────
// TRANSLATION_BACKEND= local | ollama | gemini
const BACKEND = (process.env.TRANSLATION_BACKEND || "local").toLowerCase();

const backendModule = await (async () => {
  switch (BACKEND) {
    case "gemini":     return import("./backends/gemini.js");
    case "ollama":     return import("./backends/ollama.js");
    case "local":
    default:           return import("./backends/local.js");
  }
})();

// Initialise (downloads model / checks connectivity) before accepting requests
await backendModule.init();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// POST /api/translate  — SSE streaming
app.post("/api/translate", async (req, res) => {
  const { text, sourceLang, targetLangs } = req.body;

  if (!text?.trim() || !sourceLang || !targetLangs?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // API key may come from browser (Gemini browser-key mode)
  const browserApiKey = req.headers["x-gemini-key"] || "";

  try {
    await backendModule.translate(text, sourceLang, targetLangs, send, { apiKey: browserApiKey });
    send("done", {});
  } catch (err) {
    console.error("Translation error:", err.message);
    send("error", { message: err.message });
  }
  res.end();
});

// GET /api/health
app.get("/api/health", (_req, res) => {
  const info = {
    status:  "ok",
    backend: BACKEND,
  };

  switch (BACKEND) {
    case "gemini":
      info.model          = process.env.GEMINI_MODEL || "gemini-2.0-flash";
      info.browserKeyMode = !process.env.GOOGLE_API_KEY;  // true → key comes from browser
      break;
    case "ollama":
      info.ollamaUrl = process.env.OLLAMA_URL  || "http://localhost:11434";
      info.model     = process.env.OLLAMA_MODEL || "gemma3";
      break;
    case "local":
      info.model     = process.env.LOCAL_MODEL || "Xenova/nllb-200-distilled-600M";
      info.dtype     = process.env.LOCAL_DTYPE || "q8";
      break;
  }

  res.json(info);
});

const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  const labels = {
    local:  "NLLB-200 (local, offline)",
    ollama: `Ollama — ${process.env.OLLAMA_MODEL || "gemma3"}`,
    gemini: `Gemini — ${process.env.GEMINI_MODEL || "gemini-2.0-flash"}`,
  };
  console.log(`\n⚡ Hyper Babel  →  http://localhost:${PORT}`);
  console.log(`   Backend: ${labels[BACKEND] ?? BACKEND}\n`);
});
