const express  = require("express");
const cors     = require("cors");
const multer   = require("multer");
const fs       = require("fs");
const path     = require("path");
const OpenAI   = require("openai");
const FormData = require("form-data");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY not set!");
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Paths ──
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

// ── In-memory jobs ──
const jobs = {};

// ── Helpers ──
function readState()   { return JSON.parse(fs.readFileSync(statePath)); }
function writeState(s) { fs.writeFileSync(statePath, JSON.stringify(s, null, 2)); }
function readTopics()  { return JSON.parse(fs.readFileSync(topicsPath)); }
function todayStr()    { return new Date().toISOString().slice(0, 10); }

// ── Auto clear ──
function autoClearIfNeeded() {
  const state = readState(), today = todayStr();
  if (state.lastClearDate === today) return;
  console.log("[AutoClear]", today);
  try { fs.readdirSync(uploadPath).forEach(f => fs.unlinkSync(path.join(uploadPath, f))); } catch {}
  fs.writeFileSync(recordsPath, "[]");
  state.lastClearDate = today;
  writeState(state);
}

// ── Auto topic ──
function autoPickTopicIfNeeded() {
  const state = readState(), topics = readTopics(), today = todayStr();
  if (state.lastTopicDate === today || topics.length === 0) return;
  const idx = state.topicIndex % topics.length;
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ────────────────────────────────
// ROUTES
// ────────────────────────────────

app.post("/upload", upload.single("audio"), (req, res) => {
  try {
    const name = (req.body.name || "student").replace(/[^a-zA-Z0-9]/g, "_");
    const pin  = (req.body.pin  || "0000").replace(/[^a-zA-Z0-9]/g, "_");
    const file = name + "_" + pin + "_" + Date.now() + ".webm";
    fs.writeFileSync(path.join(uploadPath, file), req.file.buffer);
    const records = JSON.parse(fs.readFileSync(recordsPath));
    records.push({ name: req.body.name, pin: req.body.pin, file });
    fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));
    res.json({ message: "Uploaded" });
  } catch (e) { res.status(500).json({ error: "Upload failed" }); }
});

app.get("/audios", (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(recordsPath))); } catch { res.json([]); }
});

app.delete("/clear-all", (req, res) => {
  try {
    fs.readdirSync(uploadPath).forEach(f => fs.unlinkSync(path.join(uploadPath, f)));
    fs.writeFileSync(recordsPath, "[]");
    const state = readState(); state.lastClearDate = todayStr(); writeState(state);
    res.json({ message: "Cleared" });
  } catch { res.status(500).json({ error: "Clear failed" }); }
});

app.use("/uploads", express.static(uploadPath));

app.get("/get-topic",  (req, res) => res.json({ topic: readState().currentTopic }));
app.get("/get-topics", (req, res) => res.json({ topics: readTopics() }));

app.post("/set-topics", (req, res) => {
  const { topics } = req.body;
  if (!Array.isArray(topics)) return res.status(400).json({ error: "array required" });
  const cleaned = topics.map(t => t.trim()).filter(Boolean);
  fs.writeFileSync(topicsPath, JSON.stringify(cleaned, null, 2));
  const state = readState(); state.topicIndex = 0; state.lastTopicDate = ""; writeState(state);
  autoPickTopicIfNeeded();
  res.json({ message: "Saved", count: cleaned.length });
});

app.post("/set-topic", (req, res) => {
  const { topic } = req.body;
  if (!topic || !topic.trim()) return res.status(400).json({ error: "empty" });
  const state = readState(); state.currentTopic = topic.trim(); state.lastTopicDate = todayStr(); writeState(state);
  res.json({ topic: state.currentTopic });
});

app.get("/status", (req, res) => {
  const state = readState(), topics = readTopics();
  res.json({ currentTopic: state.currentTopic, topicIndex: state.topicIndex,
    lastTopicDate: state.lastTopicDate, lastClearDate: state.lastClearDate,
    totalTopics: topics.length, serverTime: new Date().toISOString() });
});

// ────────────────────────────────────────────────────────
// TRANSCRIPTION — Job polling (POST → jobId → GET /job/:id)
// ────────────────────────────────────────────────────────

app.post("/transcribe", upload.single("audio"), (req, res) => {
  if (!req.file || req.file.buffer.length < 1000) {
    return res.json({ jobId: null, error: "too_short" });
  }
  const jobId = "j" + Date.now();
  jobs[jobId] = { status: "processing", transcript: "", error: null };
  res.json({ jobId }); // respond immediately — don't block mobile
  runWhisper(jobId, req.file.buffer, req.file.mimetype || "");
});

app.get("/job/:id", (req, res) => {
  res.json(jobs[req.params.id] || { status: "not_found" });
});

// ────────────────────────────────────────────────────────
// runWhisper — uses form-data + raw HTTPS post to OpenAI
// This is the most reliable method — no SDK wrapper issues
// ────────────────────────────────────────────────────────
async function runWhisper(jobId, buffer, mime) {
  // Figure out extension
  let ext = "webm";
  if (mime.includes("mp4") || mime.includes("m4a")) ext = "mp4";
  else if (mime.includes("ogg")) ext = "ogg";
  else if (mime.includes("wav")) ext = "wav";
  else if (mime.includes("mp3") || mime.includes("mpeg")) ext = "mp3";

  // Try formats: detected → mp4 → webm → ogg
  const formats = [...new Set([ext, "mp4", "webm", "ogg"])];
  console.log("[Whisper]", jobId, "size:", buffer.length, "mime:", mime, "formats:", formats);

  for (const fmt of formats) {
    const tempFile = path.join(__dirname, jobId + "." + fmt);
    try {
      fs.writeFileSync(tempFile, buffer);

      const form = new FormData();
      form.append("file", fs.createReadStream(tempFile), {
        filename:    "audio." + fmt,
        contentType: fmt === "mp4" ? "audio/mp4" :
                     fmt === "ogg" ? "audio/ogg" :
                     fmt === "wav" ? "audio/wav" :
                     fmt === "mp3" ? "audio/mpeg" : "audio/webm"
      });
      form.append("model",    "whisper-1");
      form.append("language", "en");

      // Use Node's built-in https to call OpenAI directly
      const transcript = await new Promise((resolve, reject) => {
        const https    = require("https");
        const formBuf  = form.getBuffer();
        const headers  = {
          ...form.getHeaders(),
          "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
          "Content-Length": formBuf.length
        };

        const req = https.request({
          hostname: "api.openai.com",
          path:     "/v1/audio/transcriptions",
          method:   "POST",
          headers
        }, (resp) => {
          let body = "";
          resp.on("data", c => body += c);
          resp.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              console.log("[Whisper]", jobId, fmt, "response:", body.substring(0, 150));
              if (parsed.text)  resolve(parsed.text.trim());
              else reject(new Error(parsed.error?.message || "no text in response"));
            } catch (e) { reject(new Error("parse error: " + body.substring(0, 100))); }
          });
        });

        req.on("error", reject);
        req.write(formBuf);
        req.end();
      });

      try { fs.unlinkSync(tempFile); } catch {}
      console.log("[Whisper]", jobId, fmt, "SUCCESS:", transcript.substring(0, 80));
      jobs[jobId] = { status: "done", transcript, error: null };
      setTimeout(() => delete jobs[jobId], 10 * 60 * 1000);
      return;

    } catch (e) {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch {}
      console.error("[Whisper]", jobId, fmt, "failed:", e.message);
    }
  }

  console.error("[Whisper]", jobId, "ALL FORMATS FAILED");
  jobs[jobId] = { status: "error", transcript: "", error: "Transcription failed for all formats" };
  setTimeout(() => delete jobs[jobId], 10 * 60 * 1000);
}

// ── Grammar correction ──
app.post("/correct", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.json({ corrected: "No speech detected." });
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Correct the English grammar. Return only the corrected sentence." },
        { role: "user",   content: text }
      ]
    });
    res.json({ corrected: r.choices?.[0]?.message?.content || text });
  } catch (e) {
    console.error("[Correct]", e.message);
    res.status(500).json({ corrected: "AI error. Try again." });
  }
});

// ── Start ──
app.listen(PORT, () => {
  console.log("SpeakUp running on port", PORT);
  setInterval(() => {
    require("http").get("http://localhost:" + PORT + "/status",
      r => console.log("[Ping]", r.statusCode)
    ).on("error", e => console.log("[Ping fail]", e.message));
  }, 14 * 60 * 1000);
});