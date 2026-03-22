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
    currentTopic: "No topic assigned yet",
    topicIndex: 0, lastTopicDate: "", lastClearDate: ""
  }, null, 2));
}

// ── In-memory job store ──
const jobs = {};

// ── Helpers ──
function readState()   { return JSON.parse(fs.readFileSync(statePath)); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function readTopics()  { return JSON.parse(fs.readFileSync(topicsPath)); }
function todayStr()    { return new Date().toISOString().slice(0, 10); }

// ── Auto clear every 24h ──
function autoClearIfNeeded() {
  const state = readState();
  const today = todayStr();
  if (state.lastClearDate === today) return;
  console.log("[AutoClear] Running for", today);
  try { fs.readdirSync(uploadPath).forEach(f => fs.unlinkSync(path.join(uploadPath, f))); }
  catch (e) { console.error("[AutoClear]", e); }
  fs.writeFileSync(recordsPath, "[]");
  state.lastClearDate = today;
  writeState(state);
}

// ── Auto topic every day ──
function autoPickTopicIfNeeded() {
  const state  = readState();
  const topics = readTopics();
  const today  = todayStr();
  if (state.lastTopicDate === today || topics.length === 0) return;
  const idx           = state.topicIndex % topics.length;
  state.currentTopic  = topics[idx];
  state.topicIndex    = idx + 1;
  state.lastTopicDate = today;
  writeState(state);
  console.log("[AutoTopic]", today, "->", state.currentTopic);
}

autoClearIfNeeded();
autoPickTopicIfNeeded();
setInterval(() => { autoClearIfNeeded(); autoPickTopicIfNeeded(); }, 60 * 60 * 1000);

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 }
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

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

app.get("/audios", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(recordsPath))); }
  catch { res.json([]); }
});

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

app.use("/uploads", express.static(uploadPath));

app.get("/get-topic",  (req, res) => res.json({ topic: readState().currentTopic }));
app.get("/get-topics", (req, res) => res.json({ topics: readTopics() }));

app.post("/set-topics", (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics)) return res.status(400).json({ error: "topics must be array" });
  const cleaned = topics.map(t => t.trim()).filter(t => t.length > 0);
  fs.writeFileSync(topicsPath, JSON.stringify(cleaned, null, 2));
  const state = readState();
  state.topicIndex = 0; state.lastTopicDate = "";
  writeState(state);
  autoPickTopicIfNeeded();
  res.json({ message: "Topics saved", count: cleaned.length });
});

app.post("/set-topic", (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: "Topic empty" });
  const state = readState();
  state.currentTopic  = topic.trim();
  state.lastTopicDate = todayStr();
  writeState(state);
  res.json({ message: "Topic set", topic: state.currentTopic });
});

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
// TRANSCRIPTION — Job polling system
// POST /transcribe → returns jobId immediately
// GET  /job/:id   → poll until done/error
// ─────────────────────────────────────────────

app.post("/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "No audio received" });
  }

  const size = req.file.buffer.length;
  const mime = req.file.mimetype || "";
  console.log("[Transcribe] size:", size, "mime:", mime);

  if (size < 1000) {
    return res.json({ jobId: null, error: "too_short" });
  }

  const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  jobs[jobId] = { status: "processing", transcript: "", error: null };

  // Return jobId immediately — mobile gets response before Whisper starts
  res.json({ jobId });

  // Run Whisper in background
  runWhisper(jobId, req.file.buffer, mime);
});

// ── Whisper background processor ──
async function runWhisper(jobId, buffer, mime) {
  try {
    // Pick extension — Whisper uses this to detect format
    let ext = "webm"; // Android Chrome default
    if (mime.includes("mp4") || mime.includes("m4a")) ext = "mp4"; // iOS Safari
    else if (mime.includes("ogg"))  ext = "ogg";
    else if (mime.includes("wav"))  ext = "wav";
    else if (mime.includes("mpeg") || mime.includes("mp3")) ext = "mp3";

    console.log("[Whisper]", jobId, "size:", buffer.length, "ext:", ext, "mime:", mime);

    // ── SDK v4.28 correct method: pass Buffer directly as File ──
    // Do NOT use toFile(stream,...) — streams are unreliable in background jobs
    // Use the File constructor with the raw buffer instead
    const audioFile = new File([buffer], "recording." + ext, {
      type: ext === "webm" ? "audio/webm" :
            ext === "mp4"  ? "audio/mp4"  :
            ext === "ogg"  ? "audio/ogg"  :
            ext === "wav"  ? "audio/wav"  :
            ext === "mp3"  ? "audio/mpeg" : "audio/webm"
    });

    const response = await openai.audio.transcriptions.create({
      file:     audioFile,
      model:    "whisper-1",
      language: "en"
    });

    const transcript = (response.text || "").trim();
    console.log("[Whisper]", jobId, "SUCCESS:", transcript.substring(0, 80));
    jobs[jobId] = { status: "done", transcript, error: null };

  } catch (err) {
    console.error("[Whisper]", jobId, "FAILED:", err.message);
    if (err.status)  console.error("[Whisper] HTTP status:", err.status);
    if (err.error)   console.error("[Whisper] Detail:", JSON.stringify(err.error));

    // ── Retry: try mp4 format if first attempt failed ──
    if (!mime.includes("mp4")) {
      try {
        console.log("[Whisper]", jobId, "retrying as mp4...");
        const retryFile = new File([buffer], "recording.mp4", { type: "audio/mp4" });
        const r2 = await openai.audio.transcriptions.create({
          file:     retryFile,
          model:    "whisper-1",
          language: "en"
        });
        const t2 = (r2.text || "").trim();
        console.log("[Whisper]", jobId, "retry SUCCESS:", t2.substring(0, 80));
        jobs[jobId] = { status: "done", transcript: t2, error: null };
        return;
      } catch (e2) {
        console.error("[Whisper]", jobId, "retry FAILED:", e2.message);
      }
    }

    // ── Second retry: try as ogg ──
    try {
      console.log("[Whisper]", jobId, "retrying as ogg...");
      const oggFile = new File([buffer], "recording.ogg", { type: "audio/ogg" });
      const r3 = await openai.audio.transcriptions.create({
        file:     oggFile,
        model:    "whisper-1",
        language: "en"
      });
      const t3 = (r3.text || "").trim();
      console.log("[Whisper]", jobId, "ogg retry SUCCESS:", t3.substring(0, 80));
      jobs[jobId] = { status: "done", transcript: t3, error: null };
      return;
    } catch (e3) {
      console.error("[Whisper]", jobId, "ogg retry FAILED:", e3.message);
    }

    jobs[jobId] = { status: "error", transcript: "", error: err.message };
  }

  // Clean up job after 10 minutes
  setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);
}

// GET /job/:id — frontend polls this
app.get("/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.json({ status: "not_found" });
  res.json(job);
});

// ─────────────────────────────────────────────
// POST /correct — AI grammar correction
// ─────────────────────────────────────────────
app.post("/correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.json({ corrected: "No speech detected." });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are an English grammar correction assistant. Correct the grammar of the given text and return only the corrected sentence. Do not add any explanation." },
        { role: "user",   content: text }
      ]
    });

    res.json({ corrected: response.choices?.[0]?.message?.content || "No correction found" });

  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({ corrected: "AI Error: " + (err.message || "Unknown") });
  }
});

// ── Start server + self-ping to prevent Render sleep ──
app.listen(PORT, () => {
  console.log("SpeakUp server running on port " + PORT);

  // Ping self every 14 min — Render free tier sleeps after 15 min
  setInterval(() => {
    const http = require("http");
    http.get("http://localhost:" + PORT + "/status", r => {
      console.log("[KeepAlive] OK:", r.statusCode);
    }).on("error", e => console.log("[KeepAlive] Failed:", e.message));
  }, 14 * 60 * 1000);
});