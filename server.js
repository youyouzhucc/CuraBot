const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const dns = require("dns");
const kbRetrieval = require("./kb-retrieval");
const triageEngine = require("./triage-engine");
const modelRouter = require("./model-router");
const dailyLearner = require("./daily-learner");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");

/** 固定从 server.js 所在目录读 .env，避免从其它 cwd 启动 node 时读不到密钥 */
require("dotenv").config({ path: path.join(__dirname, ".env") });
if (fs.existsSync(path.join(__dirname, ".env.local"))) {
  require("dotenv").config({ path: path.join(__dirname, ".env.local"), override: true });
}

/** 可选：给 Node fetch 配置代理（适用于本机浏览器可访问但 Node fetch failed 的场景） */
try {
  const proxyUrl =
    (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
  if (proxyUrl) {
    let undiciMod = null;
    try {
      undiciMod = require("node:undici");
    } catch (_) {
      try {
        undiciMod = require("undici");
      } catch (_) {
        undiciMod = null;
      }
    }
    if (undiciMod && undiciMod.setGlobalDispatcher && undiciMod.ProxyAgent) {
      undiciMod.setGlobalDispatcher(new undiciMod.ProxyAgent(proxyUrl));
      console.log(`[net] fetch proxy enabled: ${proxyUrl}`);
    } else {
      const envProxy = String(process.env.NODE_USE_ENV_PROXY || "").trim();
      if (envProxy === "1" || envProxy.toLowerCase() === "true") {
        console.log("[net] using NODE_USE_ENV_PROXY=1 (native env proxy mode)");
      } else {
        console.warn("[net] proxy requested but undici unavailable; set NODE_USE_ENV_PROXY=1 and restart");
      }
    }
  }
} catch (e) {
  console.warn("[net] fetch proxy setup skipped:", e && e.message);
}

/** 某些网络环境下 Node fetch 优先 IPv6 会导致外部 LLM 域名连接失败（fetch failed） */
try {
  if (typeof dns.setDefaultResultOrder === "function") {
    dns.setDefaultResultOrder("ipv4first");
  }
} catch (e) {
  /* ignore */
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
const uploadsPetsDir = path.join(publicDir, "uploads", "pets");
const dataDir = path.join(__dirname, "data");
const legacySessionsDir = path.join(dataDir, "sessions");

if (!fs.existsSync(uploadsHealthDir)) fs.mkdirSync(uploadsHealthDir, { recursive: true });
if (!fs.existsSync(uploadsPetsDir)) fs.mkdirSync(uploadsPetsDir, { recursive: true });
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

/** 从 knowledge.json 注入大模型 system 的安全约束（与 meta.governance.llmSafetyAppendix 同步） */
function loadKnowledgeGovernanceAppend() {
  try {
    const p = path.join(publicDir, "data", "knowledge.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const lines = j.meta && j.meta.governance && j.meta.governance.llmSafetyAppendix;
    if (!Array.isArray(lines) || !lines.length) return "";
    return "\n【知识库与安全约束】\n" + lines.map((x) => `· ${String(x)}`).join("\n");
  } catch (e) {
    console.warn("[knowledge] 无法加载 governance 片段：", e && e.message);
    return "";
  }
}
const KNOWLEDGE_GOVERNANCE_APPEND = loadKnowledgeGovernanceAppend();

/**
 * 视觉模型在云端无法访问 http://127.0.0.1/... ；对本地上传路径读取为 data URL 再请求。
 * 公网 http(s) 图片仍直接传 URL。
 */
async function resolveVisionImageUrlForApi(imageUrl, publicDir, uploadsHealthDir) {
  const raw = String(imageUrl || "").trim();
  if (!raw) return { ok: false, reason: "empty" };
  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, url: raw };
  }
  const normalized = raw.replace(/^\/+/, "");
  if (!normalized.startsWith("uploads/health/")) {
    return { ok: false, reason: "invalid_path" };
  }
  const fp = path.resolve(publicDir, normalized);
  const root = path.resolve(uploadsHealthDir);
  const rel = path.relative(root, fp);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: "unsafe_path" };
  }
  let buf;
  try {
    buf = await fsp.readFile(fp);
  } catch (e) {
    return { ok: false, reason: "not_found" };
  }
  const ext = path.extname(fp).toLowerCase();
  const mime =
    ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/jpeg";
  const b64 = buf.toString("base64");
  return { ok: true, url: `data:${mime};base64,${b64}` };
}

/** 健康会话快照：SQLite（优先 node:sqlite，否则 better-sqlite3；替代 data/sessions/*.json） */
const { openDatabaseSync } = require("./open-sqlite");
let healthDb = null;
try {
  const dbPath = path.join(dataDir, "curabot.db");
  healthDb = openDatabaseSync(dbPath);
  healthDb.exec(`
    CREATE TABLE IF NOT EXISTS health_sessions (
      id TEXT PRIMARY KEY,
      saved_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  healthDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pet_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      species TEXT NOT NULL,
      breed TEXT,
      gender TEXT,
      neuter TEXT,
      age_band TEXT,
      weight_kg REAL,
      notes TEXT,
      avatar_url TEXT,
      birth_date TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pets_user ON pet_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_exp ON auth_sessions(expires_at);
  `);
  try {
    const cols = healthDb.prepare("PRAGMA table_info(pet_profiles)").all();
    const set = new Set(cols.map((c) => c.name));
    if (!set.has("avatar_url")) {
      healthDb.exec("ALTER TABLE pet_profiles ADD COLUMN avatar_url TEXT");
    }
    if (!set.has("birth_date")) {
      healthDb.exec("ALTER TABLE pet_profiles ADD COLUMN birth_date TEXT");
    }
  } catch (migErr) {
    console.warn("[pet_profiles migrate]", migErr && migErr.message);
  }
  try {
    const ucols = healthDb.prepare("PRAGMA table_info(users)").all();
    const unames = new Set(ucols.map((c) => c.name));
    if (!unames.has("nickname")) {
      healthDb.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
    }
  } catch (userMigErr) {
    console.warn("[users migrate]", userMigErr && userMigErr.message);
  }
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
    "[health-session] SQLite 未初始化。请执行 npm install（含 better-sqlite3）或将 Node 升级到 22.5+：",
    e.message || e
  );
}

const MAX_PETS_PER_USER = 6;
/** 登录态有效期：365 天（与前端 localStorage 长期保存 token 一致） */
const AUTH_SESSION_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeEmail(e) {
  return String(e || "")
    .trim()
    .toLowerCase();
}

function parseBearer(req) {
  const h = req.headers && req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function verifyPassword(password, saltHex, hashHex) {
  try {
    const h = hashPassword(password, saltHex);
    const a = Buffer.from(h, "hex");
    const b = Buffer.from(hashHex, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/** 选填昵称：1–20 字，去首尾空白；非法返回 false */
function normalizeOptionalNickname(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 20) return false;
  if (s.length < 1) return null;
  return s;
}

function generateUniqueNickname() {
  const pool = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  if (!healthDb) return "萌友" + crypto.randomBytes(4).toString("hex");
  for (let attempt = 0; attempt < 120; attempt++) {
    let s = "萌友";
    for (let j = 0; j < 5; j++) {
      s += pool[crypto.randomInt(0, pool.length)];
    }
    const row = healthDb.prepare("SELECT id FROM users WHERE nickname = ?").get(s);
    if (!row) return s;
  }
  return "萌友" + crypto.randomBytes(5).toString("hex");
}

function ensureUserNickname(userId) {
  if (!healthDb || !userId) return "访客";
  const row = healthDb.prepare("SELECT nickname FROM users WHERE id = ?").get(userId);
  if (!row) return "访客";
  const n = row.nickname != null ? String(row.nickname).trim() : "";
  if (n) return n;
  const nn = generateUniqueNickname();
  healthDb.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nn, userId);
  return nn;
}

function requireAuth(req, res, next) {
  if (!healthDb) {
    return res.status(503).json({
      ok: false,
      error: "sqlite_unavailable",
      hint: "需要 SQLite：请 npm install（better-sqlite3）或升级 Node 至 22.5+",
    });
  }
  const tok = parseBearer(req);
  if (!tok) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  const row = healthDb
    .prepare("SELECT user_id FROM auth_sessions WHERE token = ? AND expires_at > ?")
    .get(tok, Date.now());
  if (!row || !row.user_id) {
    return res.status(401).json({ ok: false, error: "invalid_session" });
  }
  req.userId = row.user_id;
  req.authToken = tok;
  next();
}

function rowToPet(row) {
  if (!row) return null;
  return {
    id: row.id,
    nickname: row.nickname,
    species: row.species,
    breed: row.breed || "",
    gender: row.gender || null,
    neuter: row.neuter || null,
    age_band: row.age_band || null,
    weight_kg: row.weight_kg != null ? row.weight_kg : null,
    notes: row.notes || "",
    avatar_url: row.avatar_url || "",
    birth_date: row.birth_date || null,
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

const storagePetAvatar = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsPetsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    const safe = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext.toLowerCase()) ? ext : ".jpg";
    cb(null, `${crypto.randomUUID()}${safe}`);
  },
});

const uploadPetAvatar = multer({
  storage: storagePetAvatar,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype || "");
    cb(null, ok);
  },
});

app.use(express.json({ limit: "120kb" }));

/** 允许前端与 API 不同端口时调用（如 Live Server + 本机 node） */
app.use("/api", (req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
 * - VISION_MODEL：视觉模型（需支持 image_url；默认 gpt-4o-mini）。纯文本接口（如 deepseek-chat）会返回不支持图像的提示。
 */
app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

/** —— 账号与毛孩子档案（需 SQLite） —— */
app.post("/api/auth/register", (req, res) => {
  if (!healthDb) {
    return res.status(503).json({ ok: false, error: "sqlite_unavailable" });
  }
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "invalid_email" });
  }
  if (!password || typeof password !== "string" || password.length < 8 || password.length > 128) {
    return res.status(400).json({ ok: false, error: "invalid_password", hint: "密码至少 8 位" });
  }
  const nickRaw = normalizeOptionalNickname(req.body && req.body.nickname);
  if (nickRaw === false) {
    return res.status(400).json({ ok: false, error: "invalid_nickname", hint: "昵称 1–20 字" });
  }
  try {
    const exists = healthDb.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (exists) {
      return res.status(409).json({ ok: false, error: "email_taken" });
    }
    let nickname = nickRaw || generateUniqueNickname();
    if (nickRaw) {
      const taken = healthDb.prepare("SELECT id FROM users WHERE nickname = ?").get(nickname);
      if (taken) {
        return res.status(409).json({ ok: false, error: "nickname_taken" });
      }
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const password_hash = hashPassword(password, salt);
    const id = crypto.randomUUID();
    const created_at = new Date().toISOString();
    healthDb
      .prepare("INSERT INTO users (id, email, password_hash, salt, created_at, nickname) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, email, password_hash, salt, created_at, nickname);
    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = Date.now() + AUTH_SESSION_MS;
    healthDb.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, id, expires_at);
    return res.json({ ok: true, token, user: { id, email, nickname } });
  } catch (e) {
    console.error("[api/auth/register]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.post("/api/auth/login", (req, res) => {
  if (!healthDb) {
    return res.status(503).json({ ok: false, error: "sqlite_unavailable" });
  }
  const email = normalizeEmail(req.body && req.body.email);
  const password = req.body && req.body.password;
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "invalid_credentials" });
  }
  try {
    const row = healthDb
      .prepare("SELECT id, email, password_hash, salt, nickname FROM users WHERE email = ?")
      .get(email);
    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }
    const nickname = ensureUserNickname(row.id);
    const token = crypto.randomBytes(32).toString("hex");
    const expires_at = Date.now() + AUTH_SESSION_MS;
    healthDb.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, row.id, expires_at);
    return res.json({
      ok: true,
      token,
      user: { id: row.id, email: row.email, nickname: String(nickname || "") },
    });
  } catch (e) {
    console.error("[api/auth/login]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  try {
    healthDb.prepare("DELETE FROM auth_sessions WHERE token = ?").run(req.authToken);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server" });
  }
});

/** 修改当前用户昵称（1–20 字、全站唯一） */
app.put("/api/auth/profile", requireAuth, (req, res) => {
  if (!healthDb) {
    return res.status(503).json({ ok: false, error: "sqlite_unavailable" });
  }
  const nickRaw = normalizeOptionalNickname(req.body && req.body.nickname);
  if (nickRaw === false) {
    return res.status(400).json({ ok: false, error: "invalid_nickname", hint: "昵称 1–20 字" });
  }
  if (!nickRaw) {
    return res.status(400).json({ ok: false, error: "nickname_required", hint: "请填写昵称" });
  }
  try {
    const taken = healthDb
      .prepare("SELECT id FROM users WHERE nickname = ? AND id != ?")
      .get(nickRaw, req.userId);
    if (taken) {
      return res.status(409).json({ ok: false, error: "nickname_taken" });
    }
    healthDb.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickRaw, req.userId);
    const u = healthDb.prepare("SELECT id, email, nickname FROM users WHERE id = ?").get(req.userId);
    const nn = u && u.nickname != null ? String(u.nickname).trim() : "";
    return res.json({ ok: true, user: { id: u.id, email: u.email, nickname: nn } });
  } catch (e) {
    console.error("[api/auth/profile]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.get("/api/auth/me", (req, res) => {
  if (!healthDb) {
    return res.status(503).json({ ok: false, error: "sqlite_unavailable" });
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  const tok = parseBearer(req);
  if (!tok) {
    return res.json({ ok: true, loggedIn: false });
  }
  const row = healthDb
    .prepare(
      `SELECT u.id, u.email, u.nickname FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(tok, Date.now());
  if (!row) {
    return res.json({ ok: true, loggedIn: false });
  }
  /* 返回值即库中最终昵称，避免先读后写不一致 */
  const nickname = ensureUserNickname(row.id);
  return res.json({
    ok: true,
    loggedIn: true,
    user: { id: row.id, email: row.email, nickname: String(nickname || "") },
  });
});

function validatePetBody(body, partial) {
  const out = {};
  const b = body && typeof body === "object" ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (!partial || has("nickname")) {
    const n = String(b.nickname || "").trim();
    if (!n || n.length > 32) return { error: "invalid_nickname" };
    out.nickname = n;
  }
  if (!partial || has("species")) {
    const sp = b.species === "dog" ? "dog" : b.species === "cat" ? "cat" : null;
    if (!sp) return { error: "invalid_species" };
    out.species = sp;
  }
  if (has("breed")) out.breed = String(b.breed || "").trim().slice(0, 64);
  else if (!partial) out.breed = "";

  if (has("gender")) {
    const g = b.gender;
    if (g === "" || g == null) out.gender = null;
    else if (g === "male" || g === "female") out.gender = g;
    else return { error: "invalid_gender" };
  } else if (!partial) out.gender = null;

  if (has("neuter")) {
    const n = b.neuter;
    if (n === "" || n == null) out.neuter = null;
    else if (n === "yes" || n === "no" || n === "unknown") out.neuter = n;
    else return { error: "invalid_neuter" };
  } else if (!partial) out.neuter = null;

  if (has("age_band")) {
    const a = b.age_band;
    if (a === "" || a == null) out.age_band = null;
    else if (a === "young" || a === "adult" || a === "senior") out.age_band = a;
    else return { error: "invalid_age_band" };
  } else if (!partial) out.age_band = null;

  if (has("weight_kg")) {
    if (b.weight_kg === "" || b.weight_kg == null) out.weight_kg = null;
    else {
      const w = Number(b.weight_kg);
      if (Number.isNaN(w) || w < 0 || w > 99) return { error: "invalid_weight" };
      out.weight_kg = w;
    }
  } else if (!partial) out.weight_kg = null;

  if (has("notes")) out.notes = String(b.notes || "").trim().slice(0, 500);
  else if (!partial) out.notes = "";

  if (has("avatar_url")) {
    const u = String(b.avatar_url || "").trim();
    if (!u) out.avatar_url = null;
    else if (u.length > 512) return { error: "invalid_avatar_url" };
    else if (!/^\/uploads\/pets\/[^/]+$/.test(u)) return { error: "invalid_avatar_url" };
    else out.avatar_url = u;
  } else if (!partial) out.avatar_url = null;

  if (has("birth_date")) {
    const d = b.birth_date;
    if (d === "" || d == null) out.birth_date = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) out.birth_date = String(d);
    else return { error: "invalid_birth_date" };
  } else if (!partial) out.birth_date = null;

  return { pet: out };
}

app.post("/api/pets/avatar", requireAuth, uploadPetAvatar.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: "no_file" });
  }
  const url = `/uploads/pets/${req.file.filename}`;
  return res.json({ ok: true, url });
});

app.get("/api/pets", requireAuth, (req, res) => {
  try {
    const rows = healthDb
      .prepare(
        "SELECT * FROM pet_profiles WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC"
      )
      .all(req.userId);
    return res.json({ ok: true, pets: rows.map(rowToPet) });
  } catch (e) {
    console.error("[api/pets]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.post("/api/pets", requireAuth, (req, res) => {
  try {
    const n = healthDb.prepare("SELECT COUNT(*) AS c FROM pet_profiles WHERE user_id = ?").get(req.userId);
    if (n && n.c >= MAX_PETS_PER_USER) {
      return res.status(400).json({ ok: false, error: "pet_limit", max: MAX_PETS_PER_USER });
    }
    const v = validatePetBody(req.body, false);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    const p = v.pet;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sort = healthDb.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM pet_profiles WHERE user_id = ?").get(req.userId);
    const sort_order = sort && sort.n != null ? sort.n : 0;
    healthDb
      .prepare(
        `INSERT INTO pet_profiles (id, user_id, nickname, species, breed, gender, neuter, age_band, weight_kg, notes, avatar_url, birth_date, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        req.userId,
        p.nickname,
        p.species,
        p.breed || null,
        p.gender,
        p.neuter,
        p.age_band,
        p.weight_kg,
        p.notes || "",
        p.avatar_url || null,
        p.birth_date || null,
        sort_order,
        now,
        now
      );
    const row = healthDb.prepare("SELECT * FROM pet_profiles WHERE id = ?").get(id);
    return res.json({ ok: true, pet: rowToPet(row) });
  } catch (e) {
    console.error("[api/pets POST]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.put("/api/pets/:id", requireAuth, (req, res) => {
  const pid = String(req.params.id || "");
  if (!/^[a-f0-9-]{36}$/i.test(pid)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }
  try {
    const row = healthDb.prepare("SELECT * FROM pet_profiles WHERE id = ? AND user_id = ?").get(pid, req.userId);
    if (!row) return res.status(404).json({ ok: false, error: "not_found" });
    const v = validatePetBody(req.body, true);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    const p = v.pet;
    const now = new Date().toISOString();
    const merged = {
      nickname: p.nickname != null ? p.nickname : row.nickname,
      species: p.species != null ? p.species : row.species,
      breed: Object.prototype.hasOwnProperty.call(p, "breed") ? p.breed : row.breed,
      gender: Object.prototype.hasOwnProperty.call(p, "gender") ? p.gender : row.gender,
      neuter: Object.prototype.hasOwnProperty.call(p, "neuter") ? p.neuter : row.neuter,
      age_band: Object.prototype.hasOwnProperty.call(p, "age_band") ? p.age_band : row.age_band,
      weight_kg: Object.prototype.hasOwnProperty.call(p, "weight_kg") ? p.weight_kg : row.weight_kg,
      notes: Object.prototype.hasOwnProperty.call(p, "notes") ? p.notes : row.notes,
      avatar_url: Object.prototype.hasOwnProperty.call(p, "avatar_url") ? p.avatar_url : row.avatar_url,
      birth_date: Object.prototype.hasOwnProperty.call(p, "birth_date") ? p.birth_date : row.birth_date,
    };
    healthDb
      .prepare(
        `UPDATE pet_profiles SET nickname=?, species=?, breed=?, gender=?, neuter=?, age_band=?, weight_kg=?, notes=?, avatar_url=?, birth_date=?, updated_at=? WHERE id=? AND user_id=?`
      )
      .run(
        merged.nickname,
        merged.species,
        merged.breed,
        merged.gender,
        merged.neuter,
        merged.age_band,
        merged.weight_kg,
        merged.notes,
        merged.avatar_url || null,
        merged.birth_date || null,
        now,
        pid,
        req.userId
      );
    const out = healthDb.prepare("SELECT * FROM pet_profiles WHERE id = ?").get(pid);
    return res.json({ ok: true, pet: rowToPet(out) });
  } catch (e) {
    console.error("[api/pets PUT]", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
});

app.delete("/api/pets/:id", requireAuth, (req, res) => {
  const pid = String(req.params.id || "");
  if (!/^[a-f0-9-]{36}$/i.test(pid)) {
    return res.status(400).json({ ok: false, error: "invalid_id" });
  }
  try {
    const r = healthDb.prepare("DELETE FROM pet_profiles WHERE id = ? AND user_id = ?").run(pid, req.userId);
    if (r.changes === 0) return res.status(404).json({ ok: false, error: "not_found" });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "server" });
  }
});

function isLocalhostRequest(req) {
  const h = String(req.headers.host || "")
    .split(":")[0]
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

app.get("/api/meta", (req, res) => {
  const out = {
    name: "CuraBot",
    ok: true,
    time: new Date().toISOString(),
  };
  const seed = String(process.env.ADMIN_CLIENT_SEED || "").trim() === "1";
  const key = (process.env.ADMIN_KEY || process.env.CURABOT_ADMIN_KEY || "").trim();
  if (seed && key && isLocalhostRequest(req)) {
    out.adminKeyForBrunch = key;
  }
  res.json(out);
});

/** 自检：若 404 说明当前占端口的不是本仓库最新 server.js，请结束旧进程后重新 npm start */
app.get("/api/capabilities", (_req, res) => {
  res.json({
    name: "CuraBot",
    apiChat: true,
    /** 供前端判断是否为含账号/宠物的完整后端；旧进程仅有 chat 时无法注册 */
    apiAuth: true,
    routes: [
      "GET /api/meta",
      "GET /api/capabilities",
      "GET /api/chat/status",
      "POST /api/chat",
      "POST /api/triage/consult",
      "POST /api/auth/register",
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "PUT /api/auth/profile",
      "GET /api/auth/me",
      "GET /api/pets",
      "POST /api/pets/avatar",
      "POST /api/pets",
      "PUT /api/pets/:id",
      "DELETE /api/pets/:id",
      "POST /api/health-session/snapshot",
      "GET /api/health-session/:id",
      "POST /api/health-upload",
      "POST /api/vision/analyze",
      "POST /api/admin/knowledge/reload",
      "POST /api/knowledge/ingest",
      "POST /api/feedback/chat",
    ],
  });
});

function requireAdminKey(req, res, next) {
  const k = (process.env.ADMIN_KEY || process.env.CURABOT_ADMIN_KEY || "").trim();
  if (!k) {
    return res.status(503).json({ ok: false, error: "admin_disabled", hint: "在 .env 设置 ADMIN_KEY 后启用知识喂养与重载" });
  }
  const h = String(req.headers["x-admin-key"] || req.query.key || "").trim();
  if (h !== k) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

/** 热重载知识检索缓存（更新 knowledge.json / private-knowledge.json 后调用） */
app.post("/api/admin/knowledge/reload", requireAdminKey, (_req, res) => {
  try {
    kbRetrieval.reloadKnowledgeCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 追加一条私人笔记到 public/data/private-knowledge.json（参与 RAG，权重略高于公共卡片） */
app.post("/api/knowledge/ingest", requireAdminKey, (req, res) => {
  try {
    const { text, title } = req.body || {};
    const t = String(text || "").trim();
    if (t.length < 12) {
      return res.status(400).json({ ok: false, error: "text_too_short", min: 12 });
    }
    const pfp = path.join(publicDir, "data", "private-knowledge.json");
    let root = { version: 1, modules: [{ title: "私人笔记", topics: [] }] };
    if (fs.existsSync(pfp)) {
      try {
        root = JSON.parse(fs.readFileSync(pfp, "utf8"));
      } catch (e) {
        /* keep default */
      }
    }
    if (!Array.isArray(root.modules) || !root.modules.length) {
      root.modules = [{ title: "私人笔记", topics: [] }];
    }
    const mod = root.modules[0];
    if (!Array.isArray(mod.topics)) mod.topics = [];
    const id = "pv_" + crypto.randomBytes(8).toString("hex");
    const day = new Date().toISOString().slice(0, 10);
    mod.topics.push({
      id,
      title: String(title || "").trim() || `笔记 ${day}`,
      sourceLevel: "C",
      species: ["cat", "dog"],
      teaser: t.slice(0, 160),
      science: t.slice(0, 2000),
      vetWhen: "",
    });
    fs.writeFileSync(pfp, JSON.stringify(root, null, 2), "utf8");
    kbRetrieval.reloadKnowledgeCache();
    res.json({ ok: true, id, path: "/data/private-knowledge.json" });
  } catch (e) {
    console.error("[api/knowledge/ingest]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* ───────────────────────────────────────────────────────
 * 每日自动学习管理端点
 * ─────────────────────────────────────────────────────── */

/** 查看草稿列表 */
app.get("/api/admin/learning/drafts", requireAdminKey, (_req, res) => {
  try {
    const data = dailyLearner.readDrafts();
    res.json({ ok: true, count: data.drafts.length, lastRun: data.lastRun, drafts: data.drafts });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 手动触发一次学习 */
app.post("/api/admin/learning/trigger", requireAdminKey, async (_req, res) => {
  try {
    const result = await dailyLearner.run();
    res.json(result);
  } catch (e) {
    console.error("[learning/trigger]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 批准草稿合入正式知识库 */
app.post("/api/admin/learning/approve", requireAdminKey, (req, res) => {
  try {
    const { draftId } = req.body || {};
    const draftsData = dailyLearner.readDrafts();
    const idx = draftsData.drafts.findIndex((d) => d.draftId === draftId);
    if (idx === -1) return res.status(404).json({ ok: false, error: "draft_not_found" });

    const draft = draftsData.drafts[idx];
    const topic = draft.topic;

    // 读取 knowledge.json 并追加
    const kPath = path.join(publicDir, "data", "knowledge.json");
    const knowledge = JSON.parse(fs.readFileSync(kPath, "utf8"));

    // 检查 ID 重复
    const existingIds = dailyLearner.getExistingTopicIds();
    if (existingIds.has(topic.id)) {
      return res.status(409).json({ ok: false, error: "duplicate_id", id: topic.id });
    }

    // 找到目标 module 并追加
    const targetMod = draft.targetModule || "diet";
    let mod = knowledge.dailyKnowledge.modules.find((m) => m.id === targetMod);
    if (!mod) mod = knowledge.dailyKnowledge.modules[0];
    if (!Array.isArray(mod.topics)) mod.topics = [];
    mod.topics.push(topic);

    fs.writeFileSync(kPath, JSON.stringify(knowledge, null, 2), "utf8");
    kbRetrieval.reloadKnowledgeCache();

    // 从草稿移除
    draftsData.drafts.splice(idx, 1);
    dailyLearner.writeDrafts(draftsData);

    dailyLearner.auditLog("approved", { draftId, topicId: topic.id, title: topic.title });
    res.json({ ok: true, topicId: topic.id, title: topic.title });
  } catch (e) {
    console.error("[learning/approve]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 批准全部草稿 */
app.post("/api/admin/learning/approve-all", requireAdminKey, (req, res) => {
  try {
    const draftsData = dailyLearner.readDrafts();
    if (draftsData.drafts.length === 0) {
      return res.json({ ok: true, approved: 0, message: "no_drafts" });
    }

    const kPath = path.join(publicDir, "data", "knowledge.json");
    const knowledge = JSON.parse(fs.readFileSync(kPath, "utf8"));
    const existingIds = dailyLearner.getExistingTopicIds();
    let approved = 0;

    for (const draft of draftsData.drafts) {
      const topic = draft.topic;
      if (existingIds.has(topic.id)) continue;

      const targetMod = draft.targetModule || "diet";
      let mod = knowledge.dailyKnowledge.modules.find((m) => m.id === targetMod);
      if (!mod) mod = knowledge.dailyKnowledge.modules[0];
      if (!Array.isArray(mod.topics)) mod.topics = [];
      mod.topics.push(topic);
      existingIds.add(topic.id);
      approved++;

      dailyLearner.auditLog("approved", { draftId: draft.draftId, topicId: topic.id, title: topic.title });
    }

    fs.writeFileSync(kPath, JSON.stringify(knowledge, null, 2), "utf8");
    kbRetrieval.reloadKnowledgeCache();
    draftsData.drafts = [];
    dailyLearner.writeDrafts(draftsData);

    res.json({ ok: true, approved });
  } catch (e) {
    console.error("[learning/approve-all]", e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 拒绝/删除指定草稿 */
app.post("/api/admin/learning/reject", requireAdminKey, (req, res) => {
  try {
    const { draftId } = req.body || {};
    const draftsData = dailyLearner.readDrafts();
    const idx = draftsData.drafts.findIndex((d) => d.draftId === draftId);
    if (idx === -1) return res.status(404).json({ ok: false, error: "draft_not_found" });

    const removed = draftsData.drafts.splice(idx, 1)[0];
    dailyLearner.writeDrafts(draftsData);
    dailyLearner.auditLog("rejected", { draftId, topicId: removed.topic.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 查看待学习主题列表 */
app.get("/api/admin/learning/topics", requireAdminKey, (_req, res) => {
  try {
    const topicsPath = path.join(__dirname, "data", "learning-topics.json");
    const data = JSON.parse(fs.readFileSync(topicsPath, "utf8"));
    const pending = data.topics.filter((t) => !t.done).length;
    const done = data.topics.filter((t) => t.done).length;
    res.json({ ok: true, pending, done, total: data.topics.length, topics: data.topics });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 添加新的待学习主题 */
app.post("/api/admin/learning/topics", requireAdminKey, (req, res) => {
  try {
    const { query, species, module: mod } = req.body || {};
    if (!query || String(query).trim().length < 4) {
      return res.status(400).json({ ok: false, error: "query 至少 4 个字符" });
    }
    const topicsPath = path.join(__dirname, "data", "learning-topics.json");
    let data;
    try {
      data = JSON.parse(fs.readFileSync(topicsPath, "utf8"));
    } catch (_) {
      data = { topics: [] };
    }
    data.topics.push({
      query: String(query).trim(),
      species: Array.isArray(species) ? species : ["cat", "dog"],
      module: mod || "diet",
      done: false,
    });
    fs.writeFileSync(topicsPath, JSON.stringify(data, null, 2), "utf8");
    res.json({ ok: true, total: data.topics.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** 对话反馈（没用/有帮助）→ 追加写入 data/knowledge-feedback.jsonl 供后续人工筛补 */
app.post("/api/feedback/chat", (req, res) => {
  try {
    const { helpful, snippet, topic } = req.body || {};
    const line =
      JSON.stringify({
        t: new Date().toISOString(),
        helpful: helpful === true || helpful === "yes" || helpful === 1,
        snippet: String(snippet || "").slice(0, 600),
        topic: String(topic || "").slice(0, 120),
      }) + "\n";
    const fp = path.join(dataDir, "knowledge-feedback.jsonl");
    fs.appendFileSync(fp, line, "utf8");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
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

    const resolved = await resolveVisionImageUrlForApi(imageUrl, publicDir, uploadsHealthDir);
    if (!resolved.ok) {
      const msg =
        resolved.reason === "not_found"
          ? "找不到刚上传的图片文件，请重新上传后再试。"
          : "图片地址无效，请重新上传。";
      return res.json({ ok: true, mode: "error", text: msg, hint: resolved.reason });
    }
    const absolute = resolved.url;

    const visionModel = (process.env.VISION_MODEL || "gpt-4o-mini").trim();
    const sp = species === "dog" ? "犬" : species === "cat" ? "猫" : "宠物";
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
    return res.status(503).json({
      ok: false,
      error: "sqlite_unavailable",
      hint: "需要 SQLite：请 npm install（better-sqlite3）或升级 Node 至 22.5+",
    });
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

/** 调试用：查看当前用户句命中哪些日常知识片段（不调用大模型） */
app.get("/api/knowledge/rag-preview", (req, res) => {
  try {
    const message = String(req.query.message || "");
    const species = req.query.species === "dog" ? "dog" : "cat";
    const r = kbRetrieval.retrieveDailyKnowledgeSnippets(message, species, publicDir, {
      limit: Math.min(8, Math.max(1, Number(req.query.limit) || Number(process.env.RAG_TOP_K) || 3)),
    });
    res.json({
      ok: true,
      hit: r.hit,
      topScore: r.topScore,
      snippets: r.snippets.map((s) => ({ topicId: s.topicId, score: s.score, preview: s.text.slice(0, 200) })),
      blockPreview: kbRetrieval.formatRagSystemBlock(r).slice(0, 2500),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
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

/** 猫排尿追问回合：去掉模型偶发的「循证 UI」噪声行 */
function stripCatUrinaryFluffLines(t) {
  if (!t || typeof t !== "string") return t;
  return t
    .split("\n")
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/循证进度|关注指数|非诊断|第\s*\d+\s*\/\s*5\s*项/.test(s)) return false;
      if (/^#{1,6}\s*(循证|说明|现状)/.test(s)) return false;
      if (/^\*\*说明\*\*：|^说明：/.test(s)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

app.post("/api/chat", async (req, res) => {
  try {
    const { key, base, model } = resolveLlmConfig();
    const { message, species, history, inquiryHint, evidenceMeta, antiRepeatDigest, conversationTriage } =
      req.body || {};
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

    function detectSpeciesFromText(text) {
      const t = String(text || "");
      const hitDog = /(狗狗|小狗|狗子|犬|汪)/.test(t);
      const hitCat = /(猫猫|小猫|猫咪|猫子|喵)/.test(t);
      if (hitDog && !hitCat) return "dog";
      if (hitCat && !hitDog) return "cat";
      return null;
    }
    const speciesFromMsg = detectSpeciesFromText(message);
    const speciesFromHist = Array.isArray(history)
      ? [...history]
          .reverse()
          .map((h) => detectSpeciesFromText(h && h.role === "user" ? h.content : ""))
          .find((x) => x === "cat" || x === "dog") || null
      : null;
    const speciesResolved =
      speciesFromMsg || (species === "dog" || species === "cat" ? species : null) || speciesFromHist || "cat";
    const sp = speciesResolved === "dog" ? "犬" : speciesResolved === "cat" ? "猫" : "宠物";

    const hintExtra =
      inquiryHint === "general_mandatory_probing"
        ? [
            "",
            "【本回合：健康咨询 — 五维信息未满】",
            "先安抚 1 句，再**只问 1～2 个关键点**；可给 **A/B/C** 短选项。禁止循证进度/关注指数/长说明框/多级小标题；正文约 8 行内。",
            "开场必须引用用户**已写出的具体词**（症状/时间/部位），禁止万能模板句。",
            "文末【建议分层】在信息不足时只能「不明确」或「中等」，禁止「紧急」；不写确诊病名。",
          ].join("\n")
        : inquiryHint === "cat_urinary_mandatory_probing"
        ? [
            "",
            "【本回合：猫·排尿 — 信息补全】",
            "语气像朋友陪诊：先一句安抚，再**只问 1～2 个最关键的问题**；可给 **A/B/C** 简短选项方便用户直接回。",
            "承接用户已说的排尿细节，不要重复问同一要点。",
            "禁止：输出「循证进度」「关注指数」「说明：」长段、### 小标题堆砌、或像病历一样的列表；正文控制在约 8 行内。",
            "不得仅凭「一天没尿」或档案标签下「立即急诊」式结论；不写尿闭/FLUTD 为确诊。文末【建议分层】在证据不足时只能「不明确」或「中等」，禁止「紧急」。",
            "若用户已写精神尚可、能吃能玩，语气要更稳，避免恐吓。",
          ].join("\n")
        : inquiryHint === "cat_urinary_heuristic"
          ? [
              "",
              "【本回合：猫·排尿 — 信息不足】",
              "硬性要求：① 文末【建议分层】只能「不明确」或「中等」，禁止「紧急」「正常」。② 正文禁止把尿闭/FLUTD 当确诊；禁止「请立即急诊」式命令句。",
              "禁止输出「循证进度」「关注指数」「说明」长框或 ### 多级标题；用短段落 + 可选 A/B/C 选项。",
              "先 1 句共情，再追问：砂盆/隐蔽处是否看过、排尿姿势（滴尿/蹲很久）、距上次正常排尿多久、精神食欲、呕吐腹痛等——每次最多 2 问，别一次塞满。",
            ].join("\n")
          : inquiryHint === "dog_urinary_mandatory_probing"
          ? [
              "",
              "【本回合：犬·排尿 — 信息补全】",
              "语气像朋友陪诊：先一句安抚，再**只问 1～2 个最关键的问题**；可给 **A/B/C** 简短选项方便用户直接回。",
              "承接用户已说的排尿细节，不要重复问同一要点。注意是狗狗，不要提及猫砂盆、尿团等猫特有概念。",
              "禁止：输出「循证进度」「关注指数」长段、### 小标题堆砌；正文控制在约 8 行内。",
              "不得仅凭单一关键词下「立即急诊」式结论。文末【建议分层】在证据不足时只能「不明确」或「中等」，禁止「紧急」。",
            ].join("\n")
          : inquiryHint === "dog_urinary_heuristic"
          ? [
              "",
              "【本回合：犬·排尿相关·信息不足】",
              "注意是狗狗，不要提及猫砂盆、尿团等猫特有概念。",
              "禁止编造未提及细节；先追问排尿姿势（蹲/抬腿/费力）、尿量与颜色、血尿、腹痛、呕吐、饮水量、精神食欲，再分层。",
              "文末【建议分层】在信息不足时只能「不明确」或「中等」，禁止「紧急」「正常」。",
            ].join("\n")
          : inquiryHint === "vague_concern"
            ? [
                "",
                "【本回合：描述模糊】",
                "先温和共情，再追问具体系统症状（吃喝拉撒吐、精神、持续时间），不要猜测诊断。",
              ].join("\n")
            : inquiryHint === "symptom_followup_heuristic"
              ? [
                  "",
                  "【本回合：症状相关但缺少时间线/程度】",
                  "禁止：① 直接下诊断或写死「就是某某病」；② 编造未提及细节。",
                  "若用户已描述症状性质（如湿咳、黄水呕吐），不要回头再问「是不是呕吐」这类低级重复；只补时间线/程度/关联症状。",
                  "必须先追问：持续多久、一天发生几次、精神食欲、有无呕吐/腹泻/发热等，再给分层；单句输入时【建议分层】多为「不明确」。",
                ].join("\n")
              : "";

    const evidenceBlock =
      evidenceMeta && evidenceMeta.allowEmergencyTag === false
        ? `\n【约束】信息仍不完整：禁止文末【建议分层：紧急】与「请立即急诊」式绝对化指令；用条件句（若…则…）。不要在正文里写「临床维度得分/循证进度」等字样。`
        : evidenceMeta && evidenceMeta.allowEmergencyTag === true
          ? `\n【约束】可讨论更高就医优先级；仍不得写确诊病名，「紧急」仅表示需尽快线下评估。`
          : "";

    const digestStr = antiRepeatDigest != null ? String(antiRepeatDigest).trim() : "";
    const antiRepeatBlock =
      digestStr.length > 0
        ? `\n【用户近期已说过的内容摘要（防重复追问）】\n${digestStr.slice(0, 1800)}\n请先扫一遍：若用户已在上面回答过你本想追问的要点（时间线、次数、精神食欲、二便等），**直接确认并推进**，不要再用同一模板重复提问；若用户表达了担心，先用不超过一句的共情再追问。`
        : "";

    const tri = conversationTriage && typeof conversationTriage === "object" ? conversationTriage : null;
    const triUserFeeling = tri && String(tri.userFeeling || "").trim();
    const triPace = tri && String(tri.pace || "").trim();
    const conversationTriageBlock =
      triUserFeeling === "impatient" || triPace === "brief"
        ? [
            "",
            "【本回合：对话节奏】",
            "用户显得急躁、回复很短，或多次表达「已经说过/别问了」：先**用两三句复述你已掌握的关键信息**，再只给**一个**清晰的下一步（观察点或就医阈值），减少连环追问；仍须遵守安全边界与文末【建议分层】格式。",
          ].join("\n")
        : "";

    const speciesNorm = speciesResolved === "dog" ? "dog" : "cat";
    const ragDisabled = String(process.env.RAG_DISABLE || "").trim() === "1";
    const ragAppend = ragDisabled
      ? ""
      : kbRetrieval.formatRagSystemBlock(
          kbRetrieval.retrieveDailyKnowledgeSnippets(message, speciesNorm, publicDir, {
            limit: Math.min(8, Math.max(1, Number(process.env.RAG_TOP_K) || 3)),
          })
        );

    const system = [
      "你是「CuraBot」：请把自己当成在上海宠物医院工作多年、**温和且高效**的资深门诊助理（科普向），不是冷冰冰的问卷程序。用简体中文。",
      "【语义分诊】在写下一句回复前，先通读用户消息与历史：用户若已说明症状性质、部位、时间线或次数，**禁止**再用同义模板重复追问同一维度；应像真人对话那样承接，例如「收到，你提到湿咳/黄水呕吐…那我想再确认…」。",
      "【禁止机械套话】不要反复使用同一句开场（如「先把关键点对齐一下」「先抱抱你」若与上一轮雷同）；若需安抚，**换措辞**且不超过一句。不要像体检表一样一次性罗列吐/拉/咳/瘸等全部选项，除非用户本身描述非常笼统。",
      "【追问策略】每次优先只问 **1～2 个**最关键的问题；沿用户**已提及的主诉系统**深入（如呼吸道→呼吸频率/是否费力；消化道→频次与脱水风险），避免无关联跳跃。",
      `用户当前关注的是：${sp}。请严格围绕该物种回复，不要混用另一物种的特有概念（如对狗不要提猫砂盆/尿团，对猫不要提遛弯/抬腿排尿）。`,
      `若用户本轮明确说“狗狗/猫猫”，以本轮为最高优先级覆盖历史上下文，禁止继续沿用旧物种称呼。`,
      "你只能提供科普、家庭观察与就医时机类建议，不能给出确诊病名、不能开具药物或具体剂量。",
      "【严禁】编造用户未说过的症状、年龄、性别、绝育情况、化验结果或病史；只能依据用户本次输入，以及消息前缀「【用户已选档案】」里已写明的档案项。若档案未出现某项，不要假设（例如未写性别就不要写「公猫/母猫」）。",
      "若知识库片段来自私人笔记（若有标注），可视为家长既往记录，纳入语气上的连续性，但仍不得编造未出现的细节。",
      "若用户只做了模糊描述（如仅说一天没尿、不舒服），必须先提出关键追问，再分层；不要替用户补全细节。",
      "若用户在同一条消息里已同时写出多项明确高危表现（如长时间完全无尿、精神极差、呕吐、腹部胀硬等），可建议尽快或急诊，但仍不写确诊病名；若本回合附加了「猫·排尿·信息不足」专段，则以专段硬性要求为准。",
      "回答分段简短，避免恐吓性措辞，但涉及安全不要含糊。",
      "【输出格式】回复控制在 6-10 行内。短段落，每段不超过 2-3 句。必要时用「·」列点而非长段落。禁止 ### 小标题堆砌。语气温暖但高效——像资深兽医助理简洁回答，不像论文解释。",
      "在回复正文结束后，必须单独另起一行，严格使用以下格式之一（四选一）：",
      "【建议分层：紧急】或【建议分层：中等】或【建议分层：正常】或【建议分层：不明确】。",
      "分层含义：紧急=需尽快/立即就医；中等=建议尽快就诊或当日门诊；正常=可先观察但说明观察要点；不明确=信息不足需线下检查。",
      KNOWLEDGE_GOVERNANCE_APPEND,
      ragAppend,
      hintExtra,
      evidenceBlock,
      antiRepeatBlock,
      conversationTriageBlock,
    ].join("\n");

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
          temperature: inquiryHint ? 0.22 : 0.32,
          max_tokens: inquiryHint ? 1100 : 900,
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
    let text = (reply && String(reply).trim()) || "";
    /** 弱信号 / 循证未满：强制分层不为紧急 */
    if (
      (inquiryHint === "cat_urinary_heuristic" ||
        inquiryHint === "cat_urinary_mandatory_probing" ||
        inquiryHint === "general_mandatory_probing") &&
      text
    ) {
      text = stripCatUrinaryFluffLines(text);
      text = text
        .replace(/【\s*建议分层\s*[：:]\s*紧急\s*】/g, "【建议分层：不明确】")
        .replace(/【\s*建议分层\s*[：:]\s*正常\s*】/g, "【建议分层：不明确】");
      if (inquiryHint === "cat_urinary_heuristic" && !/【\s*建议分层\s*[：:]/.test(text)) {
        text += "\n\n【建议分层：不明确】";
      }
    }
    if (evidenceMeta && evidenceMeta.allowEmergencyTag === false && text) {
      text = text.replace(/【\s*建议分层\s*[：:]\s*紧急\s*】/g, "【建议分层：不明确】");
    }
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

function sanitizeClinicalReply(text) {
  let t = String(text || "");
  // Guardrail：去除潜在剂量表达（例如 x mg/kg、每次 x mg）
  t = t.replace(/\b\d+(\.\d+)?\s*(mg|ml|片|粒)\s*\/?\s*(kg|次|天|d)\b/gi, "（剂量信息已省略）");
  t = t.replace(/(处方|剂量|每次用量|按体重给药).*/g, "如需用药请由执业兽医当面评估后开具。");
  return t.trim();
}

/** 双脑协同分诊：DeepSeek 结构化 + Gemini 视觉/润色 + 加权评分 + SOAP */
app.post("/api/triage/consult", async (req, res) => {
  try {
    const startedAt = Date.now();
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const userInput = String(body.message || "").trim();
    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const images = Array.isArray(body.images) ? body.images.slice(0, 4) : [];
    const explicitSpecies = body.species === "dog" || body.species === "cat" ? body.species : null;
    if (!userInput) {
      return res.status(400).json({ ok: false, error: "invalid_message", hint: "message 必填" });
    }

    const species =
      triageEngine.detectSpeciesFromText(userInput) ||
      explicitSpecies ||
      history
        .slice()
        .reverse()
        .map((h) => triageEngine.detectSpeciesFromText((h && h.role === "user" && h.content) || ""))
        .find((x) => x === "cat" || x === "dog") ||
      "cat";

    const schema = triageEngine.REQUIRED_SLOTS;
    const deepseekResult = await modelRouter.deepseekAnalyzeClinical({
      userInput,
      species,
      history,
      schema,
    });

    const structured = triageEngine.normalizeStructured(deepseekResult.structured || {});
    const vision = await modelRouter.geminiAnalyzeImage({
      images,
      species,
      context: userInput,
    });
    const visionStructured = triageEngine.structuredFromVisionSummary(vision.summary || "");
    const structuredWithVision = triageEngine.mergeStructured(
      triageEngine.mergeStructured(structured, visionStructured),
      {
        chief_complaint: structured.chief_complaint || (vision.summary ? "含视觉线索待结合评估" : ""),
      }
    );

    const triage = triageEngine.scoreRisk(
      structuredWithVision,
      [userInput, vision.summary || ""].filter(Boolean).join("\n")
    );
    const followUpQuestions = triageEngine.buildFollowUpQuestions(structuredWithVision, 2);

    const ragResult = kbRetrieval.retrieveDailyKnowledgeSnippets(
      [userInput, vision.summary || ""].filter(Boolean).join("\n"),
      species,
      publicDir,
      { limit: 3, maxSnippetLen: 360 }
    );
    const ragBlock = kbRetrieval.formatRagSystemBlock(ragResult);

    const soap = triageEngine.buildSoap({
      species,
      userMessage: userInput,
      structured: structuredWithVision,
      visionSummary: vision.summary,
      triage,
      planText: followUpQuestions.length
        ? "请先补齐关键病史，再决定观察或就医优先级。"
        : "依据当前风险分层执行下一步（急诊/尽快门诊/观察复评）。",
    });

    const geminiFinal = await modelRouter.geminiComposeReport({
      species,
      structured: structuredWithVision,
      triage,
      followUpQuestions,
      ragText: ragBlock,
      soap,
    });

    const missing = triageEngine.missingSlots(structuredWithVision);
    let reply = String(geminiFinal.text || "").trim();
    const usedReplyFallback = !reply;
    if (!reply) {
      const triLabel =
        triage.level === "emergency" ? "紧急" : triage.level === "moderate" ? "中等" : triage.level === "normal" ? "正常" : "不明确";
      const qText = followUpQuestions.length
        ? `我还需要你补充这两点：\n- ${followUpQuestions.join("\n- ")}`
        : "已具备基础信息，建议按当前分层尽快联系线下兽医完成面诊。";
      reply = `我先把你提供的信息整理好了，会按${species === "dog" ? "狗狗" : "猫猫"}路径继续判断。\n\n${qText}\n\n【建议分层：${triLabel}】`;
    }
    reply = sanitizeClinicalReply(reply);
    reply = triageEngine.enforceClinicalGuardrail({
      reply,
      triageLevel: triage.level,
      missingSlots: missing,
      userInput,
    });

    const llmTrace = {
      deepseekMode: deepseekResult.mode || "unknown",
      geminiVisionMode: vision.mode || "unknown",
      geminiFinalMode: geminiFinal.mode || "unknown",
      geminiVisionRetryCount: Number(vision.retryCount || 0),
      geminiFinalRetryCount: Number(geminiFinal.retryCount || 0),
      geminiVisionLastHttpStatus: Number(vision.lastHttpStatus || 0),
      geminiFinalLastHttpStatus: Number(geminiFinal.lastHttpStatus || 0),
      usedReplyFallback,
      hasVisionInput: images.length > 0,
      visionSummaryLength: String(vision.summary || "").length,
      geminiReplyLength: String(geminiFinal.text || "").length,
      errorHints: [deepseekResult.mode, vision.mode, geminiFinal.mode]
        .filter((x) => /failed|error|timeout|unsupported|invalid/i.test(String(x || "")))
        .map(String),
      elapsedMs: Date.now() - startedAt,
    };

    return res.json({
      ok: true,
      mode: "triage_orchestrated",
      providerModes: {
        deepseek: deepseekResult.mode || "unknown",
        geminiVision: vision.mode || "unknown",
        geminiFinal: geminiFinal.mode || "unknown",
      },
      species,
      structured: structuredWithVision,
      missingSlots: missing,
      followUpQuestions,
      triage,
      soap,
      rag: {
        hit: ragResult.hit,
        topScore: ragResult.topScore,
        snippets: ragResult.snippets.map((s) => ({
          topicId: s.topicId,
          score: s.score,
          sourceLevel: s.sourceLevel || "C",
        })),
      },
      visionSummary: vision.summary || "",
      reply,
      meta: {
        llmTrace,
      },
    });
  } catch (e) {
    console.error("[api/triage/consult]", e);
    return res.status(500).json({ ok: false, error: "server", hint: String(e.message || e) });
  }
});

/* ───────────────────────────────────────────────────────
 * /api/chat-local  —— 轻量 LLM 润色端点
 *   - healthBotLocal.js 中的"可委托"分支调用
 *   - system prompt 极短、max_tokens 低、超时 8 秒
 *   - 失败时 reply: null，前端 fallback 到硬编码模板
 * ─────────────────────────────────────────────────────── */
app.post("/api/chat-local", async (req, res) => {
  try {
    const { key, base, model } = resolveLlmConfig();
    if (!key) return res.json({ reply: null, reason: "no_api_key" });

    const { message, species, context, style } = req.body || {};
    const sp = species === "dog" ? "狗狗" : species === "cat" ? "猫猫" : "宠物";

    const styleGuides = {
      greeting:
        `用户刚打招呼。用一句话温暖欢迎，说明能做科普不能诊断。不超过 2 句。不要使用 markdown 标题。`,
      acknowledgment:
        `用户表达了感谢/确认。一句话自然回应，温和提醒"症状变化时联系兽医"。不要使用 markdown 标题。`,
      topic_explain:
        `你在帮助用户了解宠物健康知识。根据下方 context 提供的知识条目标题和科学摘要，用口语化的方式向用户解释，保持温暖但专业。结尾提醒何时该看兽医。不超过 150 字。`,
      followup:
        `用户的描述信息不足，请温和地引导用户补充：品种年龄、具体症状、持续时间、食欲精神等。不要一次问太多，只问最关键的 1-2 个问题。语气像朋友聊天。`,
      synthesis:
        `根据 context 提供的结构化信息（严重程度、标签等），用自然口语写一段综合性回复。保持科普定位，不诊断不开药。`,
    };

    const systemPrompt = [
      `你是 CuraBot 宠物健康科普助手，简体中文，温暖简洁。当前物种：${sp}。`,
      `严禁：确诊病名、开药、编造症状、使用「确诊」「一定是」等断言。`,
      styleGuides[style] || styleGuides.followup,
      context ? `\n【参考信息】${typeof context === "string" ? context : JSON.stringify(context)}` : "",
    ].filter(Boolean).join("\n");

    const msgs = [
      { role: "system", content: systemPrompt },
      { role: "user", content: String(message || "").slice(0, 2000) },
    ];

    const timeoutMs = 8000;
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
          temperature: 0.5,
          max_tokens: 280,
        }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      console.warn("[api/chat-local] fetch failed:", err && err.message);
      return res.json({ reply: null, reason: "network" });
    }
    clearTimeout(timer);

    if (!r.ok) {
      console.warn("[api/chat-local] http", r.status);
      return res.json({ reply: null, reason: "http_" + r.status });
    }

    const data = await r.json();
    const text =
      data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const reply = (text && String(text).trim()) || null;
    return res.json({ reply });
  } catch (e) {
    console.error("[api/chat-local]", e);
    return res.json({ reply: null, reason: "server" });
  }
});

/** 显式挂载 /images，避免个别环境下静态资源解析异常 */
app.use("/images", express.static(path.join(publicDir, "images"), { index: false }));
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

/* ── 每日自动学习定时器 ── */
const LEARN_HOUR = Number(process.env.LEARN_HOUR) || 3; // 默认凌晨 3:00
let _lastLearnDate = "";
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === LEARN_HOUR && now.getMinutes() === 0 && _lastLearnDate !== today) {
    _lastLearnDate = today;
    console.log("[daily-learner] 定时触发自动学习...");
    dailyLearner.run().then(r => {
      console.log("[daily-learner] 定时学习完成:", JSON.stringify(r));
    }).catch(e => {
      console.error("[daily-learner] 定时学习失败:", e.message);
    });
  }
}, 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CuraBot listening on http://0.0.0.0:${PORT}`);
  console.log(`[daily-learner] 定时器已注册，每天 ${LEARN_HOUR}:00 自动学习`);
  console.log(
    "[API] capabilities · chat · knowledge ingest/reload · feedback · auth/pets · health-upload · vision · health-session"
  );
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
