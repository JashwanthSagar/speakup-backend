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

// state.json holds: currentTopic, topicIndex, lastTopicDate, lastClearDate
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

// ────────────────────────────────────────────────────
// AUTO CLEAR every 24 hours
// Deletes all audio files and clears records.json
// ────────────────────────────────────────────────────
function autoClearIfNeeded() {
  const state = readState();
  const today = todayStr();
  if (state.lastClearDate === today) return;

  console.log("[AutoClear] Running for", today);
  try {
    fs.readdirSync(uploadPath).forEach(f =>
      fs.unlinkSync(path.join(uploadPath, f))
    );
  } catch (e) { console.error("[AutoClear] File delete error:", e); }

  fs.writeFileSync(recordsPath, "[]");
  state.lastClearDate = today;
  writeState(state);
  console.log("[AutoClear] Done.");
}

// ────────────────────────────────────────────────────
// AUTO TOPIC PICK every day
// Cycles through the topics list in order, one per day
// ────────────────────────────────────────────────────
function autoPickTopicIfNeeded() {
  const state  = readState();
  const topics = readTopics();
  const today  = todayStr();

  if (state.lastTopicDate === today) return;
  if (topics.length === 0) return;

  const nextIndex        = state.topicIndex % topics.length;
  state.currentTopic     = topics[nextIndex];
  state.topicIndex       = nextIndex + 1;
  state.lastTopicDate    = today;
  writeState(state);
  console.log("[AutoTopic]", today, "→", state.currentTopic);
}

// Run both at startup and every hour
autoClearIfNeeded();
autoPickTopicIfNeeded();
setInterval(() => {
  autoClearIfNeeded();
  autoPickTopicIfNeeded();
}, 60 * 60 * 1000);

// ── Multer ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) cb(null, true);
    else cb(new Error("Only audio files are allowed"), false);
  }
});

// ────────────────────────────────────────────────────
// ROUTES
// ────────────────────────────────────────────────────

// POST /upload — student submits audio
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

// GET /audios — teacher fetches all recordings
app.get("/audios", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(recordsPath))); }
  catch { res.json([]); }
});

// DELETE /clear-all — teacher manually clears everything
app.delete("/clear-all", (req, res) => {
  try {
    fs.readdirSync(uploadPath).forEach(f =>
      fs.unlinkSync(path.join(uploadPath, f))
    );
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

// GET /get-topic — student gets today's topic
app.get("/get-topic", (req, res) => {
  res.json({ topic: readState().currentTopic });
});

// GET /get-topics — teacher gets the full topic list
app.get("/get-topics", (req, res) => {
  res.json({ topics: readTopics() });
});

// POST /set-topics — teacher saves full topic list
app.post("/set-topics", (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics))
    return res.status(400).json({ error: "topics must be an array" });

  const cleaned = topics.map(t => t.trim()).filter(t => t.length > 0);
  fs.writeFileSync(topicsPath, JSON.stringify(cleaned, null, 2));

  // Reset index so next day picks from beginning of new list
  const state = readState();
  state.topicIndex    = 0;
  state.lastTopicDate = ""; // force re-pick today
  writeState(state);
  autoPickTopicIfNeeded();

  res.json({ message: "Topics saved", count: cleaned.length });
});

// POST /set-topic — teacher manually overrides today's topic
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

// GET /status — debug info
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

// POST /correct — AI grammar correction

// POST /transcribe — Whisper transcription for mobile devices
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  let tempPath = null;
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file received" });

    let ext = "webm";
    if (req.file.mimetype.includes("ogg")) ext = "ogg";
    if (req.file.mimetype.includes("mp4")) ext = "mp4";

    tempPath = path.join(__dirname, "temp_" + Date.now() + "." + ext);
    fs.writeFileSync(tempPath, req.file.buffer);

    const response = await openai.audio.transcriptions.create({
      file:     fs.createReadStream(tempPath),
      model:    "whisper-1",
      language: "en"
    });

    fs.unlinkSync(tempPath);
    res.json({ transcript: response.text || "" });

  } catch (err) {
    console.error("Whisper error:", err);
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    res.status(500).json({ error: "Transcription failed: " + err.message });
  }
});

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

// Start server
app.listen(PORT, () => console.log("SpeakUp server running on port " + PORT));