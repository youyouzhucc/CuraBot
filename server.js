const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

/** 固定从 server.js 所在目录读 .env，避免从其它 cwd 启动 node 时读不到密钥 */
require("dotenv").config({ path: path.join(__dirname, ".env") });
if (fs.existsSync(path.join(__dirname, ".env.local"))) {
  require("dotenv").config({ path: path.join(__dirname, ".env.local"), override: true });
}

/**
 * 解析 LLM 配置（OpenAI 兼容，含 DeepSeek）
 * - DEEPSEEK_API_KEY：仅填此项时自动使用 https://api.deepseek.com/v1 + deepseek-chat
 * - OPENAI_API_KEY + LLM_PROVIDER=deepseek：同上自动端点
 * - 否则需显式设置 OPENAI_BASE_URL / OPENAI_MODEL
 */
function resolveLlmConfig() {
  const ds = (process.env.DEEPSEEK_API_KEY || "").trim();
  const oa = (process.env.OPENAI_API_KEY || "").trim();
  const key = oa || ds;

  let base = (process.env.OPENAI_BASE_URL || "").trim().replace(/\/$/, "");
  let model = (process.env.OPENAI_MODEL || "").trim();
  const provider = (process.env.LLM_PROVIDER || "").toLowerCase().trim();

  if (!key) {
    return {
      key: "",
      base: base || "https://api.openai.com/v1",
      model: model || "gpt-4o-mini",
    };
  }

  if (!base) {
    if (ds && !oa) {
      base = "https://api.deepseek.com/v1";
    } else if (provider === "deepseek") {
      base = "https://api.deepseek.com/v1";
    } else {
      base = "https://api.openai.com/v1";
    }
  }

  if (!model) {
    model = base.includes("deepseek.com") ? "deepseek-chat" : "gpt-4o-mini";
  }

  return { key, base, model };
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, "public");
const uploadsHealthDir = path.join(publicDir, "uploads", "health");
const dataDir = path.join(__dirname, "data");
const legacySessionsDir = path.join(dataDir, "sessions");

if (!fs.existsSync(uploadsHealthDir)) fs.mkdirSync(uploadsHealthDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

/** 健康会话快照：SQLite（Node 22.5+ 内置 node:sqlite，替代 data/sessions/*.json） */
let healthDb = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  const dbPath = path.join(dataDir, "curabot.db");
  healthDb = new DatabaseSync(dbPath);
  healthDb.exec(`
    CREATE TABLE IF NOT EXISTS health_sessions (
      id TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  if (fs.existsSync(legacySessionsDir)) {
    const files = fs.readdirSync(legacySessionsDir).filter((f) => f.endsWith(".json"));
    const ins = healthDb.prepare(
      "INSERT OR IGNORE INTO health_sessions (id, saved_at, payload) VALUES (?, ?, ?)"
    );
    files.forEach((f) => {
      try {
        const fp = path.join(legacySessionsDir, f);
        const j = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (j && j.id) {
          ins.run(j.id, j.savedAt || new Date().toISOString(), JSON.stringify(j));
        }
      } catch (e) {
        /* skip corrupt */
      }
    });
    if (files.length) {
      console.log(`[health-session] 已从 data/sessions 导入 ${files.length} 条快照（若未重复）`);
    }
  }
} catch (e) {
  console.error(
    "[health-session] SQLite 未初始化（需要 Node.js 22.5+）。请升级 Node 或检查 node:sqlite：",
    e.message || e
  );
}

const storageHealth = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsHealthDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    const safe = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext.toLowerCase()) ? ext : ".jpg";
    cb(null, `${crypto.randomUUID()}${safe}`);
  },
});

const uploadHealth = multer({
  storage: storageHealth,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype || "");
    cb(null, ok);
  },
});

app.use(express.json({ limit: "120kb" }));

/** 允许前端与 API 不同端口时调用（如 Live Server + 本机 node） */
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/**
 * 猫狗健康对话（OpenAI 兼容接口）
 *
 * 环境变量：
 * - OPENAI_API_KEY 或 DEEPSEEK_API_KEY：任填其一（云端回复）
 * - 仅 DEEPSEEK_API_KEY：自动 DeepSeek 端点与 deepseek-chat
 * - OPENAI_BASE_URL：默认 https://api.openai.com/v1；或 DeepSeek：https://api.deepseek.com/v1
 * - LLM_PROVIDER=deepseek：在只设 OPENAI_API_KEY 时也可自动指向 DeepSeek
 * - OPENAI_MODEL：未设时 DeepSeek 用 deepseek-chat，否则 gpt-4o-mini
 * - OPENAI_TIMEOUT_MS：请求超时毫秒，默认 60000
 */
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

/** 自检：若 404 说明当前占端口的不是本仓库最新 server.js，请结束旧进程后重新 npm start */
app.get("/api/capabilities", (_req, res) => {
  res.json({
    name: "CuraBot",
    apiChat: true,
    routes: [
      "GET /api/meta",
      "GET /api/capabilities",
      "GET /api/chat/status",
      "POST /api/chat",
      "POST /api/health-session/snapshot",
      "GET /api/health-session/:id",
      "POST /api/health-upload",
      "POST /api/vision/analyze",
    ],
  });
});

/** 图片上传（供「视觉查房」） */
app.post("/api/health-upload", uploadHealth.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "no_file" });
  }
  const url = `/uploads/health/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.filename });
});

/**
 * 视觉辅助分析（OpenAI 兼容 vision；DeepSeek 等纯文本端点会失败并返回本地提示）
 * body: { imageUrl, species?, context? }
 */
app.post("/api/vision/analyze", async (req, res) => {
  try {
    const { imageUrl, species, context } = req.body || {};
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({ ok: false, error: "invalid_imageUrl", text: null });
    }
    const { key, base } = resolveLlmConfig();
    if (!key) {
      return res.json({
        ok: true,
        mode: "no_vision",
        text:
          "未配置 OPENAI_API_KEY / DEEPSEEK_API_KEY 时无法调用云端视觉。请用文字描述颜色、性状、是否带血、频次等，或配置密钥后重试上传。",
        hint: "no_api_key",
      });
    }

    const host = req.get("host") || `127.0.0.1:${PORT}`;
    const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    const absolute = imageUrl.startsWith("http") ? imageUrl : `${proto}://${host}${imageUrl}`;

    const visionModel = (process.env.VISION_MODEL || "gpt-4o-mini").trim();
    const sp = species === "dog" ? "犬" : "猫";
    const userText = [
      `你是兽医助理助手，用简体中文。当前关注：${sp}。`,
      context ? `家长补充背景：${String(context).slice(0, 400)}` : "",
      "请仅根据图像中可见线索，给出简短观察（非诊断）：颜色、性状、是否明显异常；并一句提示何时需要就医。120字以内。",
    ]
      .filter(Boolean)
      .join("\n");

    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS) || 60000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let r;
    try {
      r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: visionModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: absolute } },
              ],
            },
          ],
          max_tokens: 400,
          temperature: 0.3,
        }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err && err.name === "AbortError";
      return res.json({
        ok: true,
        mode: "error",
        text: isAbort ? "视觉请求超时，请稍后重试或改用文字描述。" : "视觉分析请求失败：" + (err.message || "network"),
        hint: isAbort ? "timeout" : "network",
      });
    }
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text();
      return res.json({
        ok: true,
        mode: "unsupported_or_error",
        text:
          "当前配置的模型或接口可能不支持图像输入（部分国内网关仅文本）。请改用文字描述，或更换支持 OpenAI vision 的 OPENAI_BASE_URL / VISION_MODEL。",
        hint: "http_" + r.status,
        detail: errText.slice(0, 400),
      });
    }

    const data = await r.json();
    const reply =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const text = (reply && String(reply).trim()) || "";
    return res.json({
      ok: true,
      mode: "vision",
      text: text || "模型未返回可见描述，请补充文字说明。",
    });
  } catch (e) {
    console.error("[api/vision/analyze]", e);
    return res.status(500).json({ ok: false, error: "server", text: String(e.message || e) });
  }
});

/** HealthCheckSession 快照：SQLite（data/curabot.db） */
app.post("/api/health-session/snapshot", (req, res) => {
  if (!healthDb) {
    return res.status(503).json({ ok: false, error: "sqlite_unavailable", hint: "需要 Node.js 22.5+ 与 node:sqlite" });
  }
  try {
    const id = crypto.randomUUID();
    const body = req.body && typeof req.body === "object" ? { ...req.body } : {};
    delete body.id;
    const payload = {
      id,
      savedAt: new Date().toISOString(),
      ...body,
    };
    const stmt = healthDb.prepare(
      "INSERT INTO health_sessions (id, saved_at, payload) VALUES (?, ?, ?)"
    );
    stmt.run(id, payload.savedAt, JSON.stringify(payload));
    return res.json({ ok: true, id, mode: "persisted", path: `/api/health-session/${id}` });
  } catch (e) {
    console.error("[api/health-session/snapshot]", e);
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/api/health-session/:id", (req, res) => {
  const raw = path.basename(String(req.params.id || ""), ".json").replace(/[^a-f0-9-]/gi, "");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  if (!healthDb) {
    const fp = path.resolve(legacySessionsDir, `${raw}.json`);
    if (!fp.startsWith(path.resolve(legacySessionsDir)) || !fs.existsSync(fp)) {
      return res.status(404).json({ error: "not_found" });
    }
    try {
      return res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
    } catch (e) {
      return res.status(500).json({ error: "read_failed" });
    }
  }
  try {
    const row = healthDb.prepare("SELECT payload FROM health_sessions WHERE id = ?").get(raw);
    if (!row || row.payload == null) {
      const fp = path.resolve(legacySessionsDir, `${raw}.json`);
      if (fs.existsSync(fp) && fp.startsWith(path.resolve(legacySessionsDir))) {
        return res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
      }
      return res.status(404).json({ error: "not_found" });
    }
    res.json(JSON.parse(String(row.payload)));
  } catch (e) {
    res.status(500).json({ error: "read_failed" });
  }
});

/** 前端用于显示「云端是否可用」提示（不泄露密钥） */
app.get("/api/chat/status", (_req, res) => {
  const { key, base, model } = resolveLlmConfig();
  let host = "";
  try {
    const u = base.startsWith("http") ? base : `https://${base}`;
    host = new URL(u).host;
  } catch (e) {
    host = "";
  }
  res.json({
    openaiConfigured: Boolean(key),
    baseHost: host,
    model,
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { key, base, model } = resolveLlmConfig();
    const { message, species, history } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "invalid_message", reply: null, mode: "error" });
    }
    if (!key) {
      return res.json({
        mode: "no_llm",
        reply: null,
        hint: "未设置 OPENAI_API_KEY 或 DEEPSEEK_API_KEY，请配置 .env 或使用本地知识库。",
      });
    }

    const sp = species === "dog" ? "犬" : "猫";
    const system = [
      "你是「CuraBot」猫狗健康科普助手，用简体中文回答，语气像兽医门诊里给家长解释病情那样专业、温和。",
      `用户当前关注的是：${sp}。`,
      "你只能提供科普、家庭观察与就医时机类建议，不能给出确诊病名、不能开具药物或具体剂量。",
      "若描述符合急症（呼吸困难、尿闭、大出血、抽搐、中毒可疑等），应明确建议尽快或立即就医。",
      "在家长描述症状时，若信息不足，可在回复中提出 1～2 个关键追问（用短句列出即可）。",
      "回答分段简短，避免恐吓性措辞，但涉及安全不要含糊。",
      "在回复正文结束后，必须单独另起一行，严格使用以下格式之一（四选一）：",
      "【建议分层：紧急】或【建议分层：中等】或【建议分层：正常】或【建议分层：不明确】。",
      "分层含义：紧急=需尽快/立即就医；中等=建议尽快就诊或当日门诊；正常=可先观察但说明观察要点；不明确=信息不足需线下检查。",
    ].join("");

    const msgs = [{ role: "system", content: system }];
    if (Array.isArray(history)) {
      history.slice(-10).forEach((h) => {
        const role = h.role === "assistant" ? "assistant" : "user";
        const c = String(h.content || "").slice(0, 6000);
        if (c) msgs.push({ role, content: c });
      });
    }
    msgs.push({ role: "user", content: message.slice(0, 6000) });

    const timeoutMs = Number(process.env.OPENAI_TIMEOUT_MS) || 60000;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let r;
    try {
      r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: msgs,
          temperature: 0.4,
          max_tokens: 900,
        }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const name = err && err.name;
      const isAbort = name === "AbortError";
      console.error("[api/chat] fetch failed:", isAbort ? "timeout" : err.message || err);
      return res.json({
        mode: "error",
        reply: null,
        hint: isAbort
          ? `请求超时（>${timeoutMs}ms）。可增大 OPENAI_TIMEOUT_MS 或检查网络。`
          : "无法连接大模型服务（常见于国内网络无法直连 OpenAI）。请设置 OPENAI_BASE_URL 为国内可访问的兼容接口，或使用本地知识库。",
        error: isAbort ? "timeout" : "network",
      });
    }
    clearTimeout(timer);

    if (!r.ok) {
      const errText = await r.text();
      console.error("[api/chat] openai http", r.status, errText.slice(0, 800));
      let hint = `大模型接口返回 ${r.status}。请检查 API Key、模型名与 OPENAI_BASE_URL。`;
      if (r.status === 401) hint = "API Key 无效或未授权，请检查 OPENAI_API_KEY / DEEPSEEK_API_KEY。";
      if (r.status === 429) hint = "请求过于频繁或额度不足，请稍后重试。";
      return res.json({
        mode: "error",
        reply: null,
        hint,
        error: "http_" + r.status,
      });
    }

    const data = await r.json();
    const reply =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const text = (reply && String(reply).trim()) || "";
    return res.json({ mode: "llm", reply: text || null, hint: text ? null : "模型返回空内容。" });
  } catch (e) {
    console.error("[api/chat]", e);
    return res.json({
      mode: "error",
      reply: null,
      hint: "服务器处理对话时出错，请查看终端日志。",
      error: "server",
    });
  }
});

app.use(express.static(publicDir));

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({ ok: false, error: "file_too_large", max: "5MB" });
  }
  if (err.message && /multer|Unexpected field/i.test(err.message)) {
    return res.status(400).json({ ok: false, error: "upload_rejected", message: err.message });
  }
  console.error("[express]", err);
  res.status(500).json({ ok: false, error: "server" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CuraBot listening on http://0.0.0.0:${PORT}`);
  console.log("[API] GET /api/capabilities · GET /api/chat/status · POST /api/chat · POST /api/health-upload · POST /api/vision/analyze · health-session");
  const envFile = path.join(__dirname, ".env");
  const hasKey = Boolean(resolveLlmConfig().key);
  if (!fs.existsSync(envFile)) {
    console.log(
      `[配置] 未找到 ${envFile}。需要云端对话时请在项目根目录新建 .env（可复制 .env.example），一行：DEEPSEEK_API_KEY=你的密钥`
    );
  } else if (!hasKey) {
    console.log(
      "[配置] 已存在 .env，但未解析出 DEEPSEEK_API_KEY / OPENAI_API_KEY。请检查变量名、使用 KEY=value 格式、勿加引号或中文标点；记事本请另存为 UTF-8。"
    );
  } else {
    console.log("[配置] 已从 .env 加载 LLM 密钥");
  }
  if (!hasKey) {
    console.log("[提示] 未配置密钥时对话接口返回 no_llm，前端会使用本地知识库。");
  }
});
