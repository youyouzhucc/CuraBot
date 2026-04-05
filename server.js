const path = require("path");
const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, "public");

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/api/meta", (_req, res) => {
  res.json({
    name: "CuraBot",
    ok: true,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CuraBot listening on http://0.0.0.0:${PORT}`);
});
