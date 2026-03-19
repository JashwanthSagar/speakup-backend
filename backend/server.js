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

// ✅ OpenAI Setup (ONLY ONCE)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Create uploads folder if not exists
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

// Multer setup
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const name = req.body.name || "student";
    const pin = req.body.pin || "0000";
    const uniqueName = name + "_" + pin + "_" + Date.now() + ".webm";
    cb(null, uniqueName);
  }
});

const upload = multer({ storage: storage });

// ✅ Upload API
app.post("/upload", upload.single("audio"), (req, res) => {
  res.json({ message: "File uploaded successfully" });
});

// ✅ Get all audios
app.get("/audios", (req, res) => {
  fs.readdir(uploadPath, (err, files) => {
    if (err) return res.json([]);

    res.json(files); // simple array
  });
});

// ✅ Serve uploads
app.use("/uploads", express.static(uploadPath));

// ✅ AI Grammar Correction API
app.post("/correct", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || text.trim() === "") {
      return res.json({ corrected: "No speech detected" });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Correct the grammar and return only corrected sentence."
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    const corrected =
      response.choices?.[0]?.message?.content || "No correction found";

    res.json({ corrected });

  } catch (err) {
    console.log("🔥 AI ERROR FULL:", err);

    // 👇 send actual error message to frontend
    res.json({
      corrected: "AI Error: " + (err.message || "Unknown error")
    });
  }
});

// ✅ Start server
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});