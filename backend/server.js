const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Startup check for API key
if (!process.env.OPENAI_API_KEY) {
  console.error("WARNING: OPENAI_API_KEY is not set in environment variables!");
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Create uploads folder if not exists
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

// records.json path — stores student metadata
const recordsPath = path.join(__dirname, "records.json");
if (!fs.existsSync(recordsPath)) {
  fs.writeFileSync(recordsPath, "[]");
}

// In-memory topic store
let currentTopic = "No topic assigned yet";

// -------------------
// Multer setup — fixed: use memoryStorage so req.body is available
// -------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("Only audio files are allowed"), false);
    }
  }
});

// -------------------
// POST /upload — save audio + metadata
// -------------------
app.post("/upload", upload.single("audio"), (req, res) => {
  try {
    const name = (req.body.name || "student").replace(/[^a-zA-Z0-9]/g, "_");
    const pin  = (req.body.pin  || "0000").replace(/[^a-zA-Z0-9]/g, "_");
    const fileName = name + "_" + pin + "_" + Date.now() + ".webm";
    const filePath = path.join(uploadPath, fileName);

    // Write buffer to disk
    fs.writeFileSync(filePath, req.file.buffer);

    // Save metadata to records.json
    const records = JSON.parse(fs.readFileSync(recordsPath));
    records.push({ name: req.body.name, pin: req.body.pin, file: fileName });
    fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

    res.json({ message: "Uploaded successfully" });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// -------------------
// GET /audios — return all student recordings
// -------------------
app.get("/audios", (req, res) => {
  try {
    const records = JSON.parse(fs.readFileSync(recordsPath));
    res.json(records);
  } catch {
    res.json([]);
  }
});

// -------------------
// Serve uploaded audio files
// -------------------
app.use("/uploads", express.static(uploadPath));

// -------------------
// POST /set-topic — teacher sets the topic
// -------------------
app.post("/set-topic", (req, res) => {
  const { topic } = req.body;
  if (!topic || topic.trim() === "") {
    return res.status(400).json({ error: "Topic cannot be empty" });
  }
  currentTopic = topic.trim();
  res.json({ message: "Topic saved", topic: currentTopic });
});

// -------------------
// GET /get-topic — student fetches the topic
// -------------------
app.get("/get-topic", (req, res) => {
  res.json({ topic: currentTopic });
});

// -------------------
// POST /correct — AI grammar correction
// -------------------
app.post("/correct", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.json({ corrected: "No speech detected." });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an English grammar correction assistant. Correct the grammar of the given text and return only the corrected sentence. Do not add any explanation."
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    const corrected = response.choices?.[0]?.message?.content || "No correction found";
    res.json({ corrected });

  } catch (err) {
    console.error("AI Error:", err);
    res.status(500).json({ corrected: "AI Error: " + (err.message || "Unknown error") });
  }
});

// -------------------
// Start server
// -------------------
app.listen(PORT, () => {
  console.log("SpeakUp server running on port " + PORT);
});