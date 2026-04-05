/**
 * 猫狗健康机器人：引导选择题收集档案 → 再对话；优先 /api/chat，失败用 CuraHealthBotLocal。
 * 物种等与首页 state.species 解耦，以对话内选择为准（window.__healthChatProfile）。
 */
(function (global) {
  const history = [];
  const BOT_DISCLAIMER_LINE = "建议由大模型生成，不能代替兽医诊断，急症请优先去就医。";

  let chatProfile = {};
  let guidedStepIndex = 0;
  let guidedComplete = false;
  /** 用户最近一次在输入框提交的症状原文（用于追问选项合并上下文） */
  let lastUserPlainInput = "";
  /** 已在会话中回答过的症状追问 id，避免重复弹出同一题 */
  let answeredQuizIds = [];
  /** JSON 决策树会话（HealthCheckSession 结构由 healthDecisionEngine 创建） */
  let decisionSession = null;
  /** 是否处于决策树选择题阶段（此时仍锁定自由输入） */
  let treePhaseActive = false;
  /** 服务端持久化返回的会话 id */
  let persistedHealthSessionId = null;

  function syncProfileToWindow() {
    if (typeof window !== "undefined") {
      window.__healthChatProfile = chatProfile;
    }
  }

  function syncDecisionSessionWindow() {
    if (typeof window !== "undefined") {
      window.__healthDecisionSession = decisionSession;
    }
  }

  function setEmergencyBannerVisible(show, message) {
    const el = document.getElementById("healthEmergencyBanner");
    if (!el) return;
    el.hidden = !show;
    const t = el.querySelector(".health-emergency-banner-text");
    if (t && message) t.textContent = message;
  }

  function stripDisclaimerFromBody(text) {
    let t = String(text || "");
    const legacy = "建议仅供参考，急症请优先去医院。";
    [BOT_DISCLAIMER_LINE, legacy].forEach((line) => {
      if (t.includes(line)) t = t.split(line).join("");
    });
    return t.replace(/\n{3,}/g, "\n\n").trim();
  }

  function getApiBase() {
    if (typeof window === "undefined") return "";
    const manual = window.CURABOT_API_BASE;
    if (manual != null && String(manual).trim() !== "") {
      return String(manual).replace(/\/$/, "");
    }
    try {
      const loc = window.location;
      if (loc.protocol === "file:") return "";
      const host = loc.hostname;
      const port = loc.port || "";
      if (host === "localhost" || host === "127.0.0.1") {
        if (port === "3000" || port === "") return "";
        const devFrontPorts = ["5500", "5173", "4173", "8080", "9527", "5000", "8888"];
        if (devFrontPorts.indexOf(port) !== -1) {
          return "http://127.0.0.1:3000";
        }
      }
    } catch (e) {
      /* ignore */
    }
    return "";
  }

  function apiUrl(path) {
    const base = getApiBase();
    if (!base) return path;
    const p = path.indexOf("/") === 0 ? path : "/" + path;
    return base + p;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatRich(s) {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");
  }

  function getEls() {
    return {
      log: document.getElementById("healthChatMessages"),
      form: document.getElementById("healthChatForm"),
      input: document.getElementById("healthChatInput"),
    };
  }

  function scrollLog() {
    const { log } = getEls();
    if (log) log.scrollTop = log.scrollHeight;
  }

  function defaultGuidedSteps() {
    return [
      {
        id: "species",
        prompt: "你的宠物是？",
        options: [
          { value: "cat", label: "猫猫" },
          { value: "dog", label: "狗狗" },
        ],
      },
      {
        id: "gender",
        prompt: "Ta 的性别是？",
        options: [
          { value: "male", label: "男生" },
          { value: "female", label: "女生" },
        ],
      },
    ];
  }

  function getGuidedSteps(knowledge) {
    const hc = knowledge && knowledge.healthChat;
    const steps = hc && hc.guidedSteps;
    if (Array.isArray(steps) && steps.length) return steps;
    return defaultGuidedSteps();
  }

  function formatProfilePrefix(profile, steps) {
    const parts = [];
    steps.forEach((s) => {
      const v = profile[s.id];
      if (v == null || v === "") return;
      const opt = (s.options || []).find((o) => o.value === v);
      const lab = opt ? opt.label : v;
      let q = String(s.prompt || "").replace(/？$/, "");
      if (s.id === "gender") {
        if (profile.species === "cat") q = "猫猫的性别是";
        else if (profile.species === "dog") q = "狗狗的性别是";
      }
      parts.push(`${q}：${lab}`);
    });
    if (!parts.length) return "";
    return "【用户已选档案】" + parts.join("；") + "。\n\n";
  }

  /** 引导题文案：性别题按已选物种展示「猫猫/狗狗的性别是」 */
  function prepareStepForDisplay(step) {
    if (!step) return step;
    const out = Object.assign({}, step);
    if (step.id === "gender") {
      if (chatProfile.species === "cat") out.prompt = "猫猫的性别是？";
      else if (chatProfile.species === "dog") out.prompt = "狗狗的性别是？";
    }
    return out;
  }

  /** 解析大模型文末分层标记（与 server.js system 提示一致） */
  function extractTierFromText(text) {
    const s = String(text || "");
    const re = /【\s*建议分层\s*[：:]\s*(紧急|中等|正常|不明确)\s*】/;
    const m = s.match(re);
    const map = { 紧急: "emergency", 中等: "moderate", 正常: "normal", 不明确: "unclear" };
    if (!m) return { clean: s.trim(), tier: null };
    const clean = s.replace(re, "").trim();
    return { clean, tier: map[m[1]] || "unclear" };
  }

  function heuristicTierFromLlmText(text) {
    const t = String(text || "");
    if (/(尽快|急诊|立即|立刻|危险|严重|勿等|立刻去医院)/.test(t)) return "emergency";
    if (/(建议就诊|尽快联系兽医|不容忽视|需要检查|预约兽医)/.test(t)) return "moderate";
    if (/(可先观察|一般情况|保持观察|不必过于紧张)/.test(t)) return "normal";
    return "unclear";
  }

  function updateUploadBarVisibility() {
    const bar = document.getElementById("healthChatUploadBar");
    if (!bar) return;
    bar.hidden = !(guidedComplete && !treePhaseActive);
  }

  async function postHealthSessionSnapshot(getKnowledge, getSpecies) {
    try {
      const payload = {
        persistedNote: persistedHealthSessionId ? { previousId: persistedHealthSessionId } : undefined,
        chatProfile,
        species: getChatSpecies(getSpecies),
        decisionPath: decisionSession && decisionSession.path,
        tags: decisionSession && decisionSession.tags,
        closedReason: decisionSession && decisionSession.closedReason,
        historySnippet: history.slice(-16).map((h) => ({
          role: h.role,
          content: String(h.content || "").slice(0, 800),
        })),
      };
      const r = await fetch(apiUrl("/api/health-session/snapshot"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (j && j.id) {
        persistedHealthSessionId = j.id;
        try {
          localStorage.setItem("curabot_health_session_id", j.id);
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  async function handleHealthImageUpload(file, getKnowledge, getSpecies) {
    if (!guidedComplete || treePhaseActive) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(apiUrl("/api/health-upload"), { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error || "上传失败");
      const species = getChatSpecies(getSpecies);
      const vr = await fetch(apiUrl("/api/vision/analyze"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: j.url,
          species,
          context: lastUserPlainInput || "",
        }),
      });
      const vj = await vr.json();
      const text = (vj && vj.text) || "（无分析文本）";
      appendBubble("user", "[已上传图片]", "");
      history.push({ role: "user", content: "[图片] " + j.url });
      history.push({ role: "assistant", content: text });
      appendBubble("bot", "**视觉辅助参考（非诊断）**\n\n" + text, "", { severity: "unclear" });
      await postHealthSessionSnapshot(getKnowledge, getSpecies);
    } catch (e) {
      appendBubble("bot", "上传或分析失败：" + (e.message || e), "", { severity: "unclear" });
    }
    setLoading(false);
    scrollLog();
  }

  function updateChatInputState() {
    const { input } = getEls();
    if (!input) return;
    input.disabled = !guidedComplete;
    input.placeholder = guidedComplete
      ? "例如：猫一天没尿了、精神很差…"
      : "请先完成上方的选项，再在此描述症状…";
    updateUploadBarVisibility();
  }

  function appendBubble(role, text, extraHtml, bubbleOpts) {
    const opts = bubbleOpts || {};
    const tier = opts.severity;
    const tierLabels = {
      emergency: "紧急",
      moderate: "中等",
      normal: "正常",
      unclear: "不明确",
    };
    const { log } = getEls();
    if (!log) return;
    const div = document.createElement("div");
    const tierClass =
      role === "bot" && tier && tierLabels[tier] ? ` health-msg--tier-${tier}` : "";
    div.className = `health-msg health-msg--${role === "user" ? "user" : "bot"}${tierClass}`;
    div.setAttribute("role", "listitem");
    if (role === "bot") {
      const main = stripDisclaimerFromBody(text);
      const disclaimerHtml = `<p class="health-msg-disclaimer" role="note">${escapeHtml(BOT_DISCLAIMER_LINE)}</p>`;
      const tierBadge =
        tier && tierLabels[tier]
          ? `<p class="health-tier-badge health-tier-badge--${tier}" role="status"><span class="health-tier-badge-inner">${escapeHtml(
              tierLabels[tier]
            )}</span></p>`
          : "";
      div.innerHTML = `${tierBadge}<div class="health-msg-inner">${formatRich(main)}</div>${disclaimerHtml}${extraHtml || ""}`;
    } else {
      div.innerHTML = `<div class="health-msg-inner">${formatRich(text)}</div>${extraHtml || ""}`;
    }
    log.appendChild(div);
    scrollLog();
  }

  function appendFollowUpQuiz(quiz) {
    if (!quiz || !quiz.options || !quiz.options.length) return;
    const { log } = getEls();
    if (!log) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-followup-wrap";
    wrap.setAttribute("data-quiz-prompt", quiz.prompt);
    wrap.setAttribute("data-quiz-id", quiz.id || "q");
    const btns = quiz.options
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-followup-option="1" data-value="${escapeHtml(
            o.value
          )}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    wrap.innerHTML = `<div class="health-msg-inner">${formatRich(quiz.prompt)}</div><p class="health-msg-disclaimer" role="note">${escapeHtml(
      BOT_DISCLAIMER_LINE
    )}</p><div class="health-guided-options">${btns}</div>`;
    log.appendChild(wrap);
    scrollLog();
  }

  function appendGuidedStep(step) {
    const displayStep = prepareStepForDisplay(step);
    const { log } = getEls();
    if (!log || !displayStep) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-guided-wrap";
    const btns = (displayStep.options || [])
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-guided-option="1" data-step-id="${escapeHtml(
            displayStep.id
          )}" data-value="${escapeHtml(o.value)}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    wrap.innerHTML = `<div class="health-msg-inner">${formatRich(displayStep.prompt)}</div><p class="health-msg-disclaimer" role="note">${escapeHtml(
      BOT_DISCLAIMER_LINE
    )}</p><div class="health-guided-options">${btns}</div>`;
    log.appendChild(wrap);
    scrollLog();
  }

  function getChatSpecies(getSpecies) {
    const fromProfile = chatProfile.species;
    if (fromProfile === "cat" || fromProfile === "dog") return fromProfile;
    const ext = getSpecies && getSpecies();
    if (ext === "cat" || ext === "dog") return ext;
    return "cat";
  }

  function setLoading(on) {
    const { form, input } = getEls();
    if (input && guidedComplete) input.disabled = on;
    const btn = form && form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = on;
  }

  async function fetchLlmReply(message, species) {
    const payload = {
      message,
      species,
      history: history
        .filter((h) => h.role === "user" || h.role === "assistant")
        .slice(-8)
        .map((h) => ({ role: h.role, content: h.content })),
    };
    let r;
    try {
      r = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
    } catch (e) {
      return {
        llm: null,
        apiHint:
          "无法访问对话接口（网络或跨域）。请用 npm start 打开站点，或与 API 同域；跨端口时设置 window.CURABOT_API_BASE 或 meta.apiBase。",
        mode: "fetch_failed",
      };
    }
    let j = {};
    try {
      j = await r.json();
    } catch (e) {
      const soft =
        r.status === 404
          ? "后端 /api 未找到（404）。常见原因：用 Live Server/Vite 打开前端而 Node 在 3000——已尝试自动指向 3000；若仍失败请直接用 npm start 打开的地址访问整站，或在 meta.apiBase 填写 API 根地址。"
          : `接口返回非 JSON（HTTP ${r.status}）。请确认用 node 启动 server.js 访问页面。`;
      return {
        llm: null,
        apiHint: soft,
        mode: "bad_json",
      };
    }
    const text = j && j.reply && String(j.reply).trim();
    if (text) {
      return { llm: { text, mode: j.mode || "llm" }, apiHint: null, mode: j.mode };
    }
    return {
      llm: null,
      apiHint: j.hint || (r.ok ? "大模型未返回内容。" : `请求失败 HTTP ${r.status}。`),
      mode: j.mode || "no_reply",
    };
  }

  function buildActionMetaHtml(localMeta, opts) {
    if (!localMeta) return "";
    const parts = [];
    if (localMeta.suggestNav === "emergency" && opts.onOpenEmergency) {
      parts.push(`<button type="button" class="btn secondary soft" data-chat-action="emergency">打开急症清单</button>`);
    }
    if (localMeta.suggestNav === "triageMenu" && opts.onOpenTriage) {
      parts.push(`<button type="button" class="btn secondary soft" data-chat-action="triage">打开分诊入口</button>`);
    }
    if (localMeta.suggestTopicId && opts.onOpenDailyTopic) {
      parts.push(
        `<button type="button" class="btn secondary soft" data-chat-action="daily-topic" data-topic-id="${escapeHtml(
          localMeta.suggestTopicId
        )}">打开对应科普条目</button>`
      );
    }
    if (!parts.length) return "";
    return `<div class="health-msg-actions">${parts.join("")}</div>`;
  }

  function onFollowUpOptionClick(btn, getKnowledge, getSpecies, opts) {
    if (!guidedComplete) return;
    const wrap = btn.closest && btn.closest(".health-followup-wrap");
    if (!wrap) return;
    const quizId = wrap.getAttribute("data-quiz-id") || "q";
    const prompt = wrap.getAttribute("data-quiz-prompt") || "补充";
    const label = btn.getAttribute("data-label") || "";
    wrap.querySelectorAll("[data-followup-option]").forEach((b) => {
      b.disabled = true;
    });
    appendBubble("user", label, "");
    const supplement = `（补充）${prompt}：${label}`;
    history.push({ role: "user", content: supplement });
    if (answeredQuizIds.indexOf(quizId) === -1) answeredQuizIds.push(quizId);

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const merged = (lastUserPlainInput || "") + "\n" + supplement;
    const composed = prefix ? prefix + merged : merged;
    const species = getChatSpecies(getSpecies);

    setLoading(true);
    try {
      const localMeta = CuraHealthBotLocal.reply({
        message: composed,
        species,
        knowledge,
        answeredQuizIds,
      });
      const replyText = localMeta.text;
      let metaHtml = `<p class="health-msg-source muted">已结合补充信息（本地知识库）</p>`;
      metaHtml += buildActionMetaHtml(localMeta, opts);
      history.push({ role: "assistant", content: replyText });
      appendBubble("bot", replyText, metaHtml, { severity: localMeta.severity || "unclear" });
      if (localMeta.followUpQuiz) appendFollowUpQuiz(localMeta.followUpQuiz);
      postHealthSessionSnapshot(getKnowledge, getSpecies);
    } catch (e) {
      appendBubble("bot", "处理补充信息时出错，请再试一次。", "", { severity: "unclear" });
    }
    setLoading(false);
    scrollLog();
  }

  function showThinkingIndicator() {
    const { log } = getEls();
    if (!log) return null;
    const div = document.createElement("div");
    div.className = "health-msg health-msg--bot health-msg--thinking";
    div.setAttribute("role", "status");
    div.setAttribute("aria-busy", "true");
    div.innerHTML = `<div class="health-msg-inner">
      <p class="health-thinking-text">CuraBot 正在思考中…</p>
      <p class="muted small health-thinking-sub">请稍候，正在结合你的描述与科普知识整理回复。</p>
    </div>`;
    log.appendChild(div);
    scrollLog();
    return div;
  }

  function removeThinkingIndicator(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  async function sendMessage(getSpecies, getKnowledge, opts) {
    const { input, log } = getEls();
    if (!input) return;
    if (treePhaseActive) {
      appendBubble("bot", "请先完成当前筛查选择题。", "", { severity: "unclear" });
      return;
    }
    if (!guidedComplete) {
      appendBubble("bot", "请先点选上方的选项，完成基本信息后再描述症状。", "", { severity: "unclear" });
      return;
    }
    const raw = input.value.trim();
    if (!raw) return;
    input.value = "";
    lastUserPlainInput = raw;

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const composed = prefix ? prefix + raw : raw;

    appendBubble("user", raw, "");
    history.push({ role: "user", content: composed });
    const thinkingEl = showThinkingIndicator();
    setLoading(true);

    const species = getChatSpecies(getSpecies);

    let metaHtml = "";
    let replyText = "";
    let localMeta = null;
    let fromLlm = false;

    try {
      try {
        const fr = await fetchLlmReply(composed, species);
        if (fr.llm) {
          replyText = fr.llm.text;
          fromLlm = true;
          metaHtml = "";
        } else {
          try {
            localMeta = CuraHealthBotLocal.reply({
              message: composed,
              species,
              knowledge,
              answeredQuizIds,
            });
          } catch (e2) {
            localMeta = {
              text: "本地知识库暂时无法生成回复，请稍后再试或使用首页分诊流程。",
              severity: "unclear",
            };
          }
          replyText = localMeta.text;
          const reason = fr.apiHint ? escapeHtml(fr.apiHint) : "未返回大模型内容";
          metaHtml = `<p class="health-msg-source muted">已用本地知识库回答（原因：${reason}）</p>`;
        }
      } catch (e) {
        try {
          localMeta = CuraHealthBotLocal.reply({
            message: composed,
            species,
            knowledge,
            answeredQuizIds,
          });
          replyText = localMeta.text;
        } catch (e2) {
          replyText = "对话出错，请刷新页面后重试。";
          localMeta = { text: replyText, severity: "unclear" };
        }
        metaHtml = `<p class="health-msg-source muted">已使用本地知识库（${escapeHtml(e.message || "请求异常")}）</p>`;
      }

      if (!fromLlm && localMeta) {
        metaHtml += buildActionMetaHtml(localMeta, opts);
      }

      let displayText = replyText;
      let tier = "unclear";
      if (fromLlm) {
        const ex = extractTierFromText(replyText);
        displayText = ex.clean;
        tier = ex.tier || heuristicTierFromLlmText(displayText);
      } else if (localMeta) {
        tier = localMeta.severity || "unclear";
      }

      history.push({ role: "assistant", content: displayText });
      appendBubble("bot", displayText, metaHtml, { severity: tier });
      if (!fromLlm && localMeta && localMeta.followUpQuiz) {
        appendFollowUpQuiz(localMeta.followUpQuiz);
      }

      postHealthSessionSnapshot(getKnowledge, getSpecies);
    } finally {
      removeThinkingIndicator(thinkingEl);
      setLoading(false);
      scrollLog();
    }
  }

  function refreshChatStatus() {}

  function buildCalmParagraph(isEmergency) {
    if (isEmergency) {
      return "若你已出发或在候诊，可在此补充时间线与细节；**急症仍以尽快到达医院为先**。需要时可用下方「上传照片」辅助说明（需本机 npm start 并配置 API）。约 12 小时后会在页面内温和提醒你回访。";
    }
    return "我理解你会担心——把下面当作「就诊前预演」。需要时可用下方「上传照片」（便便、呕吐物、皮肤等），系统会尝试调用视觉模型生成可见线索（需本机 npm start 并配置 API）。约 12 小时后会在页面内温和提醒你回访。";
  }

  function composeGuidedCompletionBody(knowledge, sessionSnap, options) {
    const opts = options || {};
    const Eng = global.CuraHealthDecisionEngine;
    const plan = Eng && Eng.buildAdvicePlan ? Eng.buildAdvicePlan(sessionSnap, knowledge) : "";
    const hc = (knowledge && knowledge.healthChat) || {};
    const calm = buildCalmParagraph(!!opts.isEmergency);

    if (opts.isEmergency) {
      const em = opts.emergencyMessage || "请尽快就医。";
      return "**急诊提示**\n\n" + em + "\n\n---\n\n" + plan + "\n\n" + calm;
    }

    const parts = [];
    if (opts.closingNote && String(opts.closingNote).trim()) {
      parts.push(String(opts.closingNote).trim());
    }
    const done =
      hc.guidedDonePrompt ||
      "好的，已记录你的选择。请用自然语言描述最近最担心的症状或变化，我会结合这些信息给参考建议（不能代替兽医诊断）。";
    parts.push(done);
    parts.push(plan);
    parts.push(calm);
    return parts.join("\n\n");
  }

  function severityForGuidedCompletion(sessionSnap, options) {
    const opts = options || {};
    if (opts.isEmergency) return "emergency";
    const Eng = global.CuraHealthDecisionEngine;
    if (Eng && Eng.deriveSeverityFromSession) return Eng.deriveSeverityFromSession(sessionSnap);
    return "moderate";
  }

  function completeTreeTransition(knowledge, getKnowledge, getSpecies) {
    guidedComplete = true;
    treePhaseActive = false;
    updateChatInputState();
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem("curabot_followup_dismissed");
        localStorage.setItem("curabot_followup_hint_at", String(Date.now() + 12 * 60 * 60 * 1000));
      }
    } catch (e) {
      /* ignore */
    }
    postHealthSessionSnapshot(getKnowledge, getSpecies);
    const { input } = getEls();
    if (input) setTimeout(() => input.focus(), 120);
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("aria-hidden", "true");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  function appendVisitRecordBubble(fullText, copyOk, recordTitle) {
    const { log } = getEls();
    if (!log) return;
    const title = recordTitle || "就诊记录";
    const div = document.createElement("div");
    div.className = "health-msg health-msg--bot health-msg--visit-record";
    div.setAttribute("role", "listitem");
    const note = copyOk
      ? '<p class="muted health-visit-record-note">已复制到剪贴板，可直接粘贴给医生。</p>'
      : '<p class="muted health-visit-record-note">请使用下方「复制全文」。</p>';
    div.innerHTML = `<div class="health-msg-inner health-visit-record-inner">
      <p class="health-visit-record-title"><strong>${escapeHtml(title)}</strong></p>
      ${note}
      <pre class="health-visit-record-pre">${escapeHtml(fullText)}</pre>
      <button type="button" class="btn secondary soft health-visit-record-copy" data-copy-visit-record="1">复制全文</button>
    </div><p class="health-msg-disclaimer" role="note">${escapeHtml(BOT_DISCLAIMER_LINE)}</p>`;
    log.appendChild(div);
    scrollLog();
  }

  function handleGenerateSoapReport(getKnowledge) {
    const Eng = global.CuraHealthDecisionEngine;
    if (!Eng || !decisionSession) {
      alert("请先完成档案与症状筛查（决策树选择题），再导出就诊简报。");
      return;
    }
    const gloss = Eng.glossForOwnerPhrase(lastUserPlainInput);
    const extra = gloss ? ["口语与可能医学提示（非诊断）：" + gloss + ""] : [];
    const text = Eng.generateSOAP(decisionSession, chatProfile, extra);
    copyTextToClipboard(text).then(
      () => appendVisitRecordBubble(text, true, "给兽医的就诊简报"),
      () => appendVisitRecordBubble(text, false, "给兽医的就诊简报")
    );
  }

  function finalizeGuidedOpenInput(knowledge, getKnowledge, getSpecies) {
    const body = composeGuidedCompletionBody(knowledge, decisionSession, {});
    const sev = severityForGuidedCompletion(decisionSession, {});
    appendBubble("bot", body, "", { severity: sev });
    completeTreeTransition(knowledge, getKnowledge, getSpecies);
  }

  function appendDecisionTreeNode(node) {
    const Eng = global.CuraHealthDecisionEngine;
    if (!node || !Eng) return;
    const { log } = getEls();
    if (!log) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-decision-tree-wrap";
    wrap.setAttribute("data-node-id", node.id || "");
    const support = node.supportMessage
      ? `<p class="health-decision-support muted">${escapeHtml(node.supportMessage)}</p>`
      : "";
    const media = node.mediaHint
      ? `<p class="health-decision-media muted small-intro">${escapeHtml(node.mediaHint)}</p>`
      : "";
    const ill =
      node.illustration && node.illustration.src
        ? `<figure class="health-decision-illustration"><img class="health-decision-illustration-img" src="${escapeHtml(
            node.illustration.src
          )}" alt="${escapeHtml(node.illustration.alt || "")}" loading="lazy"/><figcaption class="muted small health-decision-illustration-cap">${escapeHtml(
            node.illustration.caption || ""
          )}</figcaption></figure>`
        : "";
    const btns = (node.options || [])
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-decision-tree-option="1" data-value="${escapeHtml(
            o.value
          )}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    wrap.innerHTML = `<div class="health-msg-inner">${formatRich(node.prompt)}${ill}</div>${support}${media}<p class="health-msg-disclaimer" role="note">${escapeHtml(
      BOT_DISCLAIMER_LINE
    )}</p><div class="health-guided-options">${btns}</div>`;
    log.appendChild(wrap);
    scrollLog();
  }

  function startDecisionTreeIfNeeded(getKnowledge, getSpecies, opts) {
    const knowledge = getKnowledge();
    const Eng = global.CuraHealthDecisionEngine;
    const tree = knowledge && knowledge.healthDecisionTree;
    const sp = getChatSpecies(getSpecies);
    if (!Eng || !tree || !tree.nodes || !tree.entryBySpecies || !tree.entryBySpecies[sp]) {
      finalizeGuidedOpenInput(knowledge, getKnowledge, getSpecies);
      return;
    }
    decisionSession = Eng.createSession(sp, tree, chatProfile);
    syncDecisionSessionWindow();
    treePhaseActive = true;
    guidedComplete = false;
    updateChatInputState();
    const node = Eng.getCurrentNode(decisionSession);
    if (node) appendDecisionTreeNode(node);
    else finalizeGuidedOpenInput(knowledge, getKnowledge, getSpecies);
  }

  function onDecisionTreeOptionClick(btn, getKnowledge, getSpecies, opts) {
    if (!decisionSession || !treePhaseActive) return;
    const Eng = global.CuraHealthDecisionEngine;
    const wrap = btn.closest && btn.closest(".health-decision-tree-wrap");
    if (!wrap || !Eng) return;
    const nodeId = wrap.getAttribute("data-node-id");
    const value = btn.getAttribute("data-value");
    const tree = getKnowledge().healthDecisionTree;
    const node = tree && tree.nodes && tree.nodes[nodeId];
    if (!node || !node.options) return;
    const opt = node.options.find((o) => o.value === value);
    if (!opt) return;
    wrap.querySelectorAll("[data-decision-tree-option]").forEach((b) => {
      b.disabled = true;
    });
    const label = btn.getAttribute("data-label") || value;
    appendBubble("user", label, "");
    history.push({ role: "user", content: label });
    const result = Eng.applyOption(decisionSession, opt);
    syncDecisionSessionWindow();
    const knowledge = getKnowledge();

    if (result.kind === "emergency") {
      setEmergencyBannerVisible(true, result.message);
      treePhaseActive = false;
      const body = composeGuidedCompletionBody(knowledge, decisionSession, {
        isEmergency: true,
        emergencyMessage: result.message,
      });
      const sev = severityForGuidedCompletion(decisionSession, { isEmergency: true });
      appendBubble("bot", body, "", { severity: sev });
      completeTreeTransition(knowledge, getKnowledge, getSpecies);
      return;
    }
    if (result.kind === "done") {
      treePhaseActive = false;
      const body = composeGuidedCompletionBody(knowledge, decisionSession, {
        closingNote: result.closingNote,
      });
      const sev = severityForGuidedCompletion(decisionSession, {});
      appendBubble("bot", body, "", { severity: sev });
      completeTreeTransition(knowledge, getKnowledge, getSpecies);
      return;
    }
    if (result.kind === "continue" && result.node) {
      appendDecisionTreeNode(result.node);
    }
  }

  function advanceGuided(getKnowledge, getSpecies, opts) {
    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    if (guidedStepIndex >= steps.length) {
      startDecisionTreeIfNeeded(getKnowledge, getSpecies, opts);
      return;
    }
    appendGuidedStep(steps[guidedStepIndex]);
  }

  function onGuidedOptionClick(btn, getKnowledge, getSpecies, opts) {
    if (guidedComplete || treePhaseActive) return;
    const stepId = btn.getAttribute("data-step-id");
    const value = btn.getAttribute("data-value");
    const label = btn.getAttribute("data-label") || value;
    const wrap = btn.closest(".health-guided-wrap");
    if (wrap) {
      wrap.querySelectorAll("[data-guided-option]").forEach((b) => {
        b.disabled = true;
      });
    }
    if (stepId) chatProfile[stepId] = value;
    syncProfileToWindow();

    appendBubble("user", label, "");
    history.push({ role: "user", content: label });

    guidedStepIndex += 1;
    advanceGuided(getKnowledge, getSpecies, opts);
  }

  function resetConversation(getKnowledge, getSpecies, presetProfile) {
    history.length = 0;
    chatProfile = presetProfile && typeof presetProfile === "object" ? { ...presetProfile } : {};
    guidedStepIndex = 0;
    guidedComplete = false;
    lastUserPlainInput = "";
    answeredQuizIds = [];
    decisionSession = null;
    treePhaseActive = false;
    persistedHealthSessionId = null;
    syncProfileToWindow();
    syncDecisionSessionWindow();
    setEmergencyBannerVisible(false, "");

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    while (guidedStepIndex < steps.length) {
      const sid = steps[guidedStepIndex].id;
      const v = chatProfile[sid];
      if (v == null || v === "") break;
      guidedStepIndex += 1;
    }

    const { log } = getEls();
    if (log) log.innerHTML = "";
    updateChatInputState();
    advanceGuided(getKnowledge, getSpecies, global.__healthChatOpts || {});
    refreshChatStatus();
    scrollLog();
  }

  function openView(getKnowledge, getSpecies, opts, presetProfile) {
    global.__healthChatOpts = opts || {};
    resetConversation(getKnowledge, getSpecies, presetProfile);
  }

  function init(options) {
    const getSpecies = options.getSpecies;
    const getKnowledge = options.getKnowledge;
    const opts = {
      onOpenEmergency: options.onOpenEmergency,
      onOpenTriage: options.onOpenTriage,
      onOpenDailyTopic: options.onOpenDailyTopic,
    };
    global.__healthChatOpts = opts;

    const log = document.getElementById("healthChatMessages");
    if (log && !log.dataset.delegateBound) {
      log.dataset.delegateBound = "1";
      log.addEventListener("click", (e) => {
        const copyRec = e.target && e.target.closest && e.target.closest("[data-copy-visit-record]");
        if (copyRec) {
          const wrap = copyRec.closest(".health-msg--visit-record");
          const pre = wrap && wrap.querySelector(".health-visit-record-pre");
          if (pre && pre.textContent) {
            copyTextToClipboard(pre.textContent).then(null, function () {
              try {
                const range = document.createRange();
                range.selectNodeContents(pre);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
              } catch (err) {
                /* ignore */
              }
            });
          }
          return;
        }
        const dTreeBtn = e.target && e.target.closest && e.target.closest("[data-decision-tree-option]");
        if (dTreeBtn && treePhaseActive) {
          e.preventDefault();
          onDecisionTreeOptionClick(dTreeBtn, getKnowledge, getSpecies, opts);
          return;
        }
        const gBtn = e.target && e.target.closest && e.target.closest("[data-guided-option]");
        if (gBtn && !guidedComplete && !treePhaseActive) {
          e.preventDefault();
          onGuidedOptionClick(gBtn, getKnowledge, getSpecies, opts);
          return;
        }
        const fBtn = e.target && e.target.closest && e.target.closest("[data-followup-option]");
        if (fBtn) {
          e.preventDefault();
          onFollowUpOptionClick(fBtn, getKnowledge, getSpecies, opts);
          return;
        }
        const btn = e.target && e.target.closest && e.target.closest("[data-chat-action]");
        if (!btn) return;
        const o = global.__healthChatOpts || {};
        const act = btn.getAttribute("data-chat-action");
        if (act === "emergency" && o.onOpenEmergency) o.onOpenEmergency();
        if (act === "triage" && o.onOpenTriage) o.onOpenTriage();
        if (act === "daily-topic" && o.onOpenDailyTopic) {
          const id = btn.getAttribute("data-topic-id");
          if (id) o.onOpenDailyTopic(id);
        }
      });
    }

    const { form, input } = getEls();
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        sendMessage(getSpecies, getKnowledge, opts);
      });
    }
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage(getSpecies, getKnowledge, opts);
        }
      });
    }

    const btnSoap = document.getElementById("btnSoapReport");
    if (btnSoap) {
      btnSoap.addEventListener("click", () => handleGenerateSoapReport(getKnowledge));
    }
    const fileIn = document.getElementById("healthChatFileInput");
    const btnUp = document.getElementById("btnHealthChatUpload");
    if (btnUp && fileIn) {
      btnUp.addEventListener("click", () => fileIn.click());
      fileIn.addEventListener("change", () => {
        const f = fileIn.files && fileIn.files[0];
        fileIn.value = "";
        if (f) handleHealthImageUpload(f, getKnowledge, getSpecies);
      });
    }

    global.CuraHealthChat = {
      open: (presetProfile) => openView(getKnowledge, getSpecies, opts, presetProfile),
      reset: () => resetConversation(getKnowledge, getSpecies, undefined),
      syncSpecies: function () {
        /* 与首页物种解耦，不再同步 */
      },
    };
  }

  global.CuraHealthChatInit = init;
})(typeof window !== "undefined" ? window : globalThis);
