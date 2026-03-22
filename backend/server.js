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

// ── In-memory job store for transcription polling ──
// Mobile browsers kill long fetch() connections when screen locks.
// Solution: POST audio → get jobId → poll GET /job/:id until done
const jobs = {};

function readState()   { return JSON.parse(fs.readFileSync(statePath)); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function readTopics()  { return JSON.parse(fs.readFileSync(topicsPath)); }
function todayStr()    { return new Date().toISOString().slice(0, 10); }

// ── Auto clear ──
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

// ── Auto topic ──
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

// ── Multer — no fileFilter, accept all for mobile ──
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

app.use("/uploads", express.static(uploadPath));

// GET /get-topic
app.get("/get-topic", (req, res) => res.json({ topic: readState().currentTopic }));

// GET /get-topics
app.get("/get-topics", (req, res) => res.json({ topics: readTopics() }));

// POST /set-topics
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

// POST /set-topic
app.post("/set-topic", (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: "Topic empty" });
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
// TRANSCRIPTION — Job-based polling
// Mobile browsers kill long connections when screen locks.
// So we: POST audio → server starts job in background → return jobId immediately
//        Frontend polls GET /job/:id every 3 seconds until done
// ─────────────────────────────────────────────

// POST /transcribe — accepts audio, starts background job, returns jobId immediately
app.post("/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file || !req.file.buffer) {
    return res.status(400).json({ error: "No audio received" });
  }

  const size = req.file.buffer.length;
  const mime = req.file.mimetype || "";
  console.log("[Transcribe] Received — size:", size, "mime:", mime);

  if (size < 1000) {
    return res.json({ jobId: null, transcript: "", error: "too_short" });
  }

  // Create job immediately and return jobId — don't make mobile wait
  const jobId = "job_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
  jobs[jobId] = { status: "processing", transcript: "", error: null, createdAt: Date.now() };

  res.json({ jobId }); // return immediately — mobile won't lose connection

  // Run Whisper in background (non-blocking)
  runWhisper(jobId, req.file.buffer, mime);
});

// Background Whisper processing
async function runWhisper(jobId, buffer, mime) {
  let tempPath = null;
  try {
    let ext = "webm";
    if (mime.includes("mp4") || mime.includes("m4a")) ext = "mp4";
    else if (mime.includes("ogg"))  ext = "ogg";
    else if (mime.includes("wav"))  ext = "wav";
    else if (mime.includes("mpeg") || mime.includes("mp3")) ext = "mp3";

    tempPath = path.join(__dirname, "temp_" + jobId + "." + ext);
    fs.writeFileSync(tempPath, buffer);
    console.log("[Whisper] Job", jobId, "— file:", tempPath, "size:", fs.statSync(tempPath).size);

    const fileStream  = fs.createReadStream(tempPath);
    fileStream.path   = "recording." + ext;

    const response = await openai.audio.transcriptions.create({
      file:     fileStream,
      model:    "whisper-1",
      language: "en"
    });

    try { fs.unlinkSync(tempPath); } catch {}

    const transcript = (response.text || "").trim();
    console.log("[Whisper] Job", jobId, "done:", transcript.substring(0, 80));
    jobs[jobId] = { status: "done", transcript, error: null };

  } catch (err) {
    if (tempPath) { try { fs.unlinkSync(tempPath); } catch {} }
    console.error("[Whisper] Job", jobId, "failed:", err.message);

    // Retry with mp4 if webm failed
    if (!mime.includes("mp4")) {
      try {
        console.log("[Whisper] Retrying job", jobId, "as mp4...");
        const retryPath = path.join(__dirname, "retry_" + jobId + ".mp4");
        fs.writeFileSync(retryPath, buffer);
        const retryStream = fs.createReadStream(retryPath);
        retryStream.path  = "recording.mp4";
        const r2 = await openai.audio.transcriptions.create({
          file: retryStream, model: "whisper-1", language: "en"
        });
        try { fs.unlinkSync(retryPath); } catch {}
        const t2 = (r2.text || "").trim();
        console.log("[Whisper] Retry job", jobId, "OK:", t2.substring(0, 80));
        jobs[jobId] = { status: "done", transcript: t2, error: null };
        return;
      } catch (e2) {
        console.error("[Whisper] Retry job", jobId, "also failed:", e2.message);
      }
    }

    jobs[jobId] = { status: "error", transcript: "", error: err.message };
  }

  // Clean up job after 10 minutes
  setTimeout(() => { delete jobs[jobId]; }, 10 * 60 * 1000);
}

// GET /job/:id — frontend polls this every 3 seconds
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
    res.status(500).json({ corrected: "AI Error: " + (err.message || "Unknown error") });
  }
});

// ── Start + keep-alive self-ping ──
app.listen(PORT, () => {
  console.log("SpeakUp server running on port " + PORT);

  // Ping self every 14 min to prevent Render free tier sleep
  setInterval(() => {
    const http = require("http");
    http.get("http://localhost:" + PORT + "/status", res => {
      console.log("[KeepAlive] OK - status:", res.statusCode);
    }).on("error", e => console.log("[KeepAlive] Failed:", e.message));
  }, 14 * 60 * 1000);
});