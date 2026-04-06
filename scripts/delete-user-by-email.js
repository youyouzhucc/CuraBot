/**
 * 按邮箱删除用户及其会话、毛孩子档案（便于本地重新注册测试）。
 * 用法：node scripts/delete-user-by-email.js [email]
 */
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const dbPath = path.join(__dirname, "..", "data", "curabot.db");
const email = String(process.argv[2] || "nianqingchenjc@163.com")
  .trim()
  .toLowerCase();

const db = new DatabaseSync(dbPath);
const row = db.prepare("SELECT id FROM users WHERE email = ? COLLATE NOCASE").get(email);
if (!row) {
  console.log("未找到用户:", email);
  process.exit(0);
}
const id = row.id;
db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(id);
db.prepare("DELETE FROM pet_profiles WHERE user_id = ?").run(id);
db.prepare("DELETE FROM users WHERE id = ?").run(id);
console.log("已删除用户及关联数据:", email);
