const path = require("path");
const fs = require("fs");
const express = require("express");

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
    routes: ["GET /api/meta", "GET /api/capabilities", "GET /api/chat/status", "POST /api/chat"],
  });
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
      "你是「CuraBot」猫狗健康科普助手，用简体中文回答。",
      `用户当前关注的是：${sp}。`,
      "你只能提供科普、家庭观察与就医时机类建议，不能给出确诊病名、不能开具药物或具体剂量。",
      "若描述符合急症（呼吸困难、尿闭、大出血、抽搐、中毒可疑等），应明确建议尽快或立即就医。",
      "回答分段简短，避免恐吓性措辞，但涉及安全不要含糊。",
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CuraBot listening on http://0.0.0.0:${PORT}`);
  console.log("[API] GET /api/capabilities · GET /api/chat/status · POST /api/chat");
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
