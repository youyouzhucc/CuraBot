const express = require("express");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Hello from Aliyun",
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${PORT}`);
});
