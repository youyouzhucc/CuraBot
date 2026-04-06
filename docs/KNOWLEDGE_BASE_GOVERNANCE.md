# CuraBot 知识库治理与演进（生命相关 · 防幻觉）

本页说明如何在 **补内容、审读引用、结构化决策树、检索增强（RAG）、大模型强约束** 五条线上持续升级，且不把线上对话变成「无出处医学断言」。

## 1. 单一数据源与版本

- **主数据**：`public/data/knowledge.json`（`meta`、`references`、急诊红线、`dailyKnowledge` 等）。
- **治理字段**：`meta.governance`（内容策略、审读说明、RAG 说明、`llmSafetyAppendix` 注入服务端 system）。
- **校验**：`npm run validate:knowledge` — 检查 JSON、**所有 `refIds` 必须存在于 `references`**。

变更流程建议：改 JSON → 跑校验 → 提交说明里写清「审读范围」或「待兽医复核」。

## 2. 补内容与引用

- 每条日常知识主题尽量带 **`refIds`**，指向 `references` 中已有条目（默克手册、指南索引等）。
- **禁止**在正文里写未经验证的剂量、具体手术方案；`meta.noRxNote` 与前端免责声明一致。
- 新增物种相关句：在 **猫/犬** 分栏或 `teaser` / `teaserDog` 上分开展示，避免混种描述。

## 3. 结构化决策树（与 LLM 分工）

- **分诊 / 采集**：`public/data/health-decision-tree.json`、`public/data/intake-flows.json`。
- **自由对话门控**：`public/js/healthBotLocal.js`（泌尿专链、通用五维、运动伤/皮肤/口腔等维度）。
- **原则**：树与规则负责 **「何时追问、何时禁止紧急标签」**；大模型负责 **语气与科普展开**，不得绕开门控下「确诊」或处方。

## 4. 检索增强（RAG）

### 已内置：关键词检索（无向量库）

- **实现**：`kb-retrieval.js` 对 `dailyKnowledge` 各条目的标题与摘要（含 `teaser`/`teaserDog`/`teaserCat`）做关键词重叠打分，取 **top-k** 拼入 `/api/chat` 的 system。
- **环境变量**：`RAG_TOP_K`（默认 3，最大 8）、`RAG_DISABLE=1` 时关闭检索注入。
- **调试**：`GET /api/knowledge/rag-preview?message=...&species=cat|dog&limit=3` 查看命中条目与片段预览（不调用大模型）。

### 后续：向量检索

1. **切块**：按 `dailyKnowledge` 主题、`science`/`vetWhen`、以及 `references` 摘要成短段（每段 200～500 字为宜）。
2. **嵌入**：使用合规的嵌入模型，存入向量库（如 pgvector、Milvus、云厂商检索服务）。
3. **注入**：在现有关键词块之前或之后追加「向量 top-k」，并保留同一套免责声明。

项目内可在 `data/` 下增加 `kb-chunks/`（JSONL）作为切块导出位置，由 CI 生成嵌入。

## 5. 大模型 + 强约束（已实现路径）

- **服务端**：`server.js` 将 `llmSafetyAppendix` 拼入 system，并适度 **降低 temperature**（追问回合更低）。
- **客户端**：`healthBot.js` 对未闭合循证替换「紧急」标签等。
- **人工审读**：临床向改版走 `meta.governance.reviewPolicy`；重大变更建议记录审阅人/日期（可写在提交信息或内部表）。

## 6. 与生命相关的底线表述

- 宁可 **信息不足 → 建议就诊**，也不要编造检查值或病名安慰用户。
- 急症话题以 **尽快联系医院** 为框架，不输出可替代现场处置的细节臆测。

若需对某一专科（如心脏病、肾病）做 **专题子库**，建议新建模块 + 独立 `refIds` 与审读清单，再接入 RAG 切块。
