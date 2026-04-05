# CuraBot · 猫狗治愈平台

信息性教育向的 **PetCheck 式分诊**、**行为与应激提示**、**急诊红线速查** Web 应用。服务端提供静态资源与 `/health` 健康检查，知识内容以 `public/data/knowledge.json` 为单一数据源，便于后续映射到数据库表（`references`、`symptom_nodes`、`rules`、`followup_questions`）。

## 重要声明

本仓库中的临床条目为团队基于公开兽医教育资料整理的 **规则骨架与引用元数据**，**不构成诊疗建议**，不替代执业兽医。不提供药物剂量或处方逻辑。

## 本地运行

需要 **Node.js 22.5+**（内置 `node:sqlite`，用于健康会话快照 `data/curabot.db`；首次启动会把旧的 `data/sessions/*.json` 导入库内）。

```bash
npm install
npm start
```

浏览器访问 `http://localhost:3000`。

## 目录结构

- `public/index.html` — 单页界面
- `public/css/main.css` — 样式
- `public/js/app.js` — 界面与流程
- `public/js/triageEngine.js` — 追问树解释器
- `public/data/knowledge.json` — 参考书元数据、急诊红线、分诊流程、行为提示等

## 部署

支持任意可运行 Node.js 的环境；监听端口由环境变量 `PORT` 指定。

## 许可证

MIT（若你需更换许可证，请修改本文件并保留免责声明与医学相关约束说明。）
