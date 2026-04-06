/**
 * 按邮箱写入用户昵称（本地 data/curabot.db）
 * 用法: node scripts/set-user-nickname.js 邮箱@example.com 新昵称
 */
const path = require("path");
const fs = require("fs");

const emailArg = (process.argv[2] || "").trim().toLowerCase();
const nickArg = (process.argv[3] || "").trim();

if (!emailArg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg)) {
  console.log("用法: node scripts/set-user-nickname.js 邮箱@example.com 新昵称");
  process.exit(1);
}
if (!nickArg || nickArg.length > 20) {
  console.log("昵称需为 1–20 字");
  process.exit(1);
}

const dbPath = path.join(__dirname, "..", "data", "curabot.db");
if (!fs.existsSync(dbPath)) {
  console.log("未找到:", dbPath, "请先 npm start 生成数据库。");
  process.exit(2);
}

try {
  const { openDatabaseSync } = require("../open-sqlite");
  const db = openDatabaseSync(dbPath);
  const row = db.prepare("SELECT id, nickname FROM users WHERE email = ? COLLATE NOCASE").get(emailArg);
  if (!row) {
    console.log("未找到用户:", emailArg);
    process.exit(3);
  }
  const taken = db.prepare("SELECT id FROM users WHERE nickname = ? AND id != ?").get(nickArg, row.id);
  if (taken) {
    console.log("昵称已被占用:", nickArg);
    process.exit(4);
  }
  db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickArg, row.id);
  console.log("已更新", emailArg, "昵称:", nickArg, "（原:", row.nickname, "）");
} catch (e) {
  console.error(e.message || e);
  process.exit(5);
}
