/**
 * 查询本地 SQLite 中是否已存在某邮箱（需已运行过 server 生成 data/curabot.db）
 * 用法：node scripts/check-user.js your@email.com
 */
const path = require("path");
const fs = require("fs");

const emailArg = process.argv[2] || "";
const dbPath = path.join(__dirname, "..", "data", "curabot.db");

if (!emailArg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg)) {
  console.log("用法: node scripts/check-user.js 邮箱@example.com");
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.log("未找到数据库文件:", dbPath);
  console.log("说明：请先在本机运行 npm start（或 node server.js）并成功注册过一次，才会生成 data/curabot.db。");
  process.exit(2);
}

try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db
    .prepare("SELECT id, email, nickname, created_at FROM users WHERE email = ? COLLATE NOCASE")
    .get(emailArg.trim().toLowerCase());
  if (row) {
    console.log("已注册:", row.email);
    console.log("用户 id:", row.id);
    console.log("昵称 nickname:", row.nickname != null && String(row.nickname).trim() !== "" ? row.nickname : "(空，接口会分配默认昵称)");
    console.log("创建时间:", row.created_at);
  } else {
    console.log("未找到该邮箱记录:", emailArg);
  }
} catch (e) {
  console.error("查询失败（需 Node.js 22.5+ 与 node:sqlite）:", e.message || e);
  process.exit(3);
}
