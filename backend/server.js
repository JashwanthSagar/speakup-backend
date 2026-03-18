const express = require("express");
const multer = require("multer");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.static("uploads"));

const storage = multer.diskStorage({
  destination: "uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + ".wav");
  }
});

const upload = multer({ storage });

// Upload API
app.post("/upload", upload.single("audio"), (req, res) => {
  res.json({ message: "Uploaded", file: req.file.filename });
});

// Get all audio files
app.get("/audios", (req, res) => {
  const fs = require("fs");
  const files = fs.readdirSync("uploads");
  res.json(files);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});