/**
 * 打开 SQLite 数据库（同步 API，与 node:sqlite 的 DatabaseSync 用法一致）。
 * 优先使用 Node 22.5+ 内置 `node:sqlite`；否则使用 `better-sqlite3`，便于 LTS 与云端未升级 Node 的环境。
 */
function openDatabaseSync(dbPath) {
  let builtinErr;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath);
    console.log("[sqlite] 使用 Node 内置 node:sqlite");
    return db;
  } catch (e) {
    builtinErr = e;
  }
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath);
    console.log("[sqlite] 使用依赖 better-sqlite3（内置 node:sqlite 不可用:", (builtinErr && builtinErr.message) || builtinErr, ")");
    return db;
  } catch (e) {
    const hint =
      "请安装依赖 npm install（含 better-sqlite3），或将 Node 升级到 22.5+。原始错误: " +
      ((e && e.message) || e) +
      "；内置模块错误: " +
      ((builtinErr && builtinErr.message) || builtinErr);
    const err = new Error(hint);
    err.cause = e;
    throw err;
  }
}

module.exports = { openDatabaseSync };
