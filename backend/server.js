const express = require("express");
const cors    = require("cors");
const multer  = require("multer");
const fs      = require("fs");
const path    = require("path");
const OpenAI  = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY is not set!");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── File paths ──
const uploadPath  = path.join(__dirname, "uploads");
const recordsPath = path.join(__dirname, "records.json");
const topicsPath  = path.join(__dirname, "topics.json");
const statePath   = path.join(__dirname, "state.json");

if (!fs.existsSync(uploadPath))  fs.mkdirSync(uploadPath);
if (!fs.existsSync(recordsPath)) fs.writeFileSync(recordsPath, "[]");
if (!fs.existsSync(topicsPath))  fs.writeFileSync(topicsPath,  "[]");

if (!fs.existsSync(statePath)) {
  fs.writeFileSync(statePath, JSON.stringify({
    currentTopic:  "No topic assigned yet",
    topicIndex:    0,
    lastTopicDate: "",
    lastClearDate: ""
  }, null, 2));
}

// ── Helpers ──
function readState()   { return JSON.parse(fs.readFileSync(statePath)); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function readTopics()  { return JSON.parse(fs.readFileSync(topicsPath)); }
function todayStr()    { return new Date().toISOString().slice(0, 10); }

// ── Auto clear every 24 hours ──
function autoClearIfNeeded() {
  const state = readState();
  const today = todayStr();
  if (state.lastClearDate === today) return;
  console.log("[AutoClear] Running for", today);
  try {
    fs.readdirSync(uploadPath).forEach(f =>
      fs.unlinkSync(path.join(uploadPath, f))
    );
  } catch (e) { console.error("[AutoClear] Error:", e); }
  fs.writeFileSync(recordsPath, "[]");
  state.lastClearDate = today;
  writeState(state);
  console.log("[AutoClear] Done.");
}

// ── Auto topic pick every day ──
function autoPickTopicIfNeeded() {
  const state  = readState();
  const topics = readTopics();
  const today  = todayStr();
  if (state.lastTopicDate === today) return;
  if (topics.length === 0) return;
  const idx              = state.topicIndex % topics.length;
  state.currentTopic     = topics[idx];
  state.topicIndex       = idx + 1;
  state.lastTopicDate    = today;
  writeState(state);
  console.log("[AutoTopic]", today, "->", state.currentTopic);
}

autoClearIfNeeded();
autoPickTopicIfNeeded();
setInterval(() => { autoClearIfNeeded(); autoPickTopicIfNeeded(); }, 60 * 60 * 1000);

// ── Multer — no fileFilter, mobile sends various mimetypes ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 }
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// POST /upload
app.post("/upload", upload.single("audio"), (req, res) => {
  try {
    const name     = (req.body.name || "student").replace(/[^a-zA-Z0-9]/g, "_");
    const pin      = (req.body.pin  || "0000").replace(/[^a-zA-Z0-9]/g, "_");
    const fileName = name + "_" + pin + "_" + Date.now() + ".webm";
    fs.writeFileSync(path.join(uploadPath, fileName), req.file.buffer);
    const records = JSON.parse(fs.readFileSync(recordsPath));
    records.push({ name: req.body.name, pin: req.body.pin, file: fileName });
    fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
    res.json({ message: "Uploaded successfully" });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /audios
app.get("/audios", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(recordsPath))); }
  catch { res.json([]); }
});

// DELETE /clear-all
app.delete("/clear-all", (req, res) => {
  try {
    fs.readdirSync(uploadPath).forEach(f => fs.unlinkSync(path.join(uploadPath, f)));
    fs.writeFileSync(recordsPath, "[]");
    const state = readState();
    state.lastClearDate = todayStr();
    writeState(state);
    res.json({ message: "All cleared" });
  } catch (err) {
    res.status(500).json({ error: "Clear failed" });
  }
});

// Serve audio files
app.use("/uploads", express.static(uploadPath));

// GET /get-topic
app.get("/get-topic", (req, res) => {
  res.json({ topic: readState().currentTopic });
});

// GET /get-topics
app.get("/get-topics", (req, res) => {
  res.json({ topics: readTopics() });
});

// POST /set-topics
app.post("/set-topics", (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics))
    return res.status(400).json({ error: "topics must be an array" });
  const cleaned = topics.map(t => t.trim()).filter(t => t.length > 0);
  fs.writeFileSync(topicsPath, JSON.stringify(cleaned, null, 2));
  const state = readState();
  state.topicIndex    = 0;
  state.lastTopicDate = "";
  writeState(state);
  autoPickTopicIfNeeded();
  res.json({ message: "Topics saved", count: cleaned.length });
});

// POST /set-topic
app.post("/set-topic", (req, res) => {
  const { topic } = req.body;
  if (!topic || topic.trim() === "")
    return res.status(400).json({ error: "Topic cannot be empty" });
  const state = readState();
  state.currentTopic  = topic.trim();
  state.lastTopicDate = todayStr();
  writeState(state);
  res.json({ message: "Topic set", topic: state.currentTopic });
});

// GET /status
app.get("/status", (req, res) => {
  const state  = readState();
  const topics = readTopics();
  res.json({
    currentTopic:  state.currentTopic,
    topicIndex:    state.topicIndex,
    lastTopicDate: state.lastTopicDate,
    lastClearDate: state.lastClearDate,
    totalTopics:   topics.length,
    serverTime:    new Date().toISOString()
  });
});

// ─────────────────────────────────────────────
// POST /transcribe  — Whisper for mobile
// ─────────────────────────────────────────────
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let tempPath = null;

  try {
    if (!req.file || !req.file.buffer) {
      console.error("[Transcribe] No file received");
      return res.status(400).json({ error: "No audio received" });
    }

    const size = req.file.buffer.length;
    const mime = req.file.mimetype || "";
    console.log("[Transcribe] size:", size, "mime:", mime);

    // Too small = nothing recorded
    if (size < 1000) {
      console.warn("[Transcribe] File too small:", size);
      return res.json({ transcript: "" });
    }

    // Pick file extension based on mime
    // Mobile Chrome = audio/webm, iOS Safari = audio/mp4
    let ext = "webm";
    if (mime.includes("mp4") || mime.includes("m4a")) ext = "mp4";
    else if (mime.includes("ogg"))                    ext = "ogg";
    else if (mime.includes("wav"))                    ext = "wav";
    else if (mime.includes("mpeg") || mime.includes("mp3")) ext = "mp3";

    // Write to temp file — Whisper requires a real file stream
    tempPath = path.join(__dirname, "temp_" + Date.now() + "." + ext);
    fs.writeFileSync(tempPath, req.file.buffer);
    console.log("[Transcribe] Temp file:", tempPath, "size:", fs.statSync(tempPath).size);

    // Call Whisper using file stream
    const fileStream = fs.createReadStream(tempPath);
    fileStream.path   = "recording." + ext; // SDK uses .path to set filename

    const response = await openai.audio.transcriptions.create({
      file:     fileStream,
      model:    "whisper-1",
      language: "en"
    });

    // Clean up
    try { fs.unlinkSync(tempPath); } catch {}
    tempPath = null;

    const transcript = (response.text || "").trim();
    console.log("[Transcribe] OK:", transcript.substring(0, 80));
    res.json({ transcript });

  } catch (err) {
    // Clean up temp file
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }

    console.error("[Transcribe] FAILED:", err.message);
    console.error("[Transcribe] Status:", err.status || "none");
    console.error("[Transcribe] Detail:", JSON.stringify(err.error || {}));

    // If webm failed, try once more sending as mp4 (helps with some iOS recordings)
    if (req.file && req.file.buffer && ext !== "mp4") {
      try {
        console.log("[Transcribe] Retrying as mp4...");
        const retryPath = path.join(__dirname, "retry_" + Date.now() + ".mp4");
        fs.writeFileSync(retryPath, req.file.buffer);
        const retryStream  = fs.createReadStream(retryPath);
        retryStream.path   = "recording.mp4";
        const r2 = await openai.audio.transcriptions.create({
          file:     retryStream,
          model:    "whisper-1",
          language: "en"
        });
        try { fs.unlinkSync(retryPath); } catch {}
        const t2 = (r2.text || "").trim();
        console.log("[Transcribe] Retry OK:", t2.substring(0, 80));
        return res.json({ transcript: t2 });
      } catch (retryErr) {
        console.error("[Transcribe] Retry failed:", retryErr.message);
      }
    }

    res.status(500).json({
      error:  "Transcription failed: " + err.message,
      detail: err.status || err.code || "unknown"
    });
  }
});

// ─────────────────────────────────────────────
// POST /correct — AI grammar correction
// ─────────────────────────────────────────────
app.post("/correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || text.trim() === "")
      return res.json({ corrected: "No speech detected." });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an English grammar correction assistant. Correct the grammar of the given text and return only the corrected sentence. Do not add any explanation."
        },
        { role: "user", content: text }
      ]
    });
    res.json({ corrected: response.choices?.[0]?.message?.content || "No correction found" });
  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({ corrected: "AI Error: " + (err.message || "Unknown error") });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log("SpeakUp server running on port " + PORT);

  // Self-ping every 14 minutes to prevent Render free tier from sleeping
  // Render sleeps after 15 minutes of inactivity
  setInterval(async () => {
    try {
      const http = require("http");
      http.get("http://localhost:" + PORT + "/status", res => {
        console.log("[KeepAlive] Ping OK - status:", res.statusCode);
      }).on("error", e => {
        console.log("[KeepAlive] Ping failed:", e.message);
      });
    } catch(e) {
      console.log("[KeepAlive] Error:", e.message);
    }
  }, 14 * 60 * 1000); // every 14 minutes
});