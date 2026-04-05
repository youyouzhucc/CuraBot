/**
 * 猫狗健康机器人：引导选择题收集档案 → 再对话；优先 /api/chat，失败用 CuraHealthBotLocal。
 * 物种等与首页 state.species 解耦，以对话内选择为准（window.__healthChatProfile）。
 */
(function (global) {
  const history = [];
  const BOT_DISCLAIMER_LINE = "建议仅供参考，急症请优先去医院。";

  let chatProfile = {};
  let guidedStepIndex = 0;
  let guidedComplete = false;

  function syncProfileToWindow() {
    if (typeof window !== "undefined") {
      window.__healthChatProfile = chatProfile;
    }
  }

  function stripDisclaimerFromBody(text) {
    let t = String(text || "");
    if (t.includes(BOT_DISCLAIMER_LINE)) {
      t = t.split(BOT_DISCLAIMER_LINE).join("").replace(/\n{3,}/g, "\n\n").trim();
    }
    return t;
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
      const q = String(s.prompt || "").replace(/？$/, "");
      parts.push(`${q}：${lab}`);
    });
    if (!parts.length) return "";
    return "【用户已选档案】" + parts.join("；") + "。\n\n";
  }

  function updateChatInputState() {
    const { input } = getEls();
    if (!input) return;
    input.disabled = !guidedComplete;
    input.placeholder = guidedComplete
      ? "例如：猫一天没尿了、精神很差…"
      : "请先完成上方的选项，再在此描述症状…";
  }

  function appendBubble(role, text, extraHtml) {
    const { log } = getEls();
    if (!log) return;
    const div = document.createElement("div");
    div.className = `health-msg health-msg--${role === "user" ? "user" : "bot"}`;
    div.setAttribute("role", "listitem");
    if (role === "bot") {
      const main = stripDisclaimerFromBody(text);
      const disclaimerHtml = `<p class="health-msg-disclaimer" role="note">${escapeHtml(BOT_DISCLAIMER_LINE)}</p>`;
      div.innerHTML = `<div class="health-msg-inner">${formatRich(main)}</div>${disclaimerHtml}${extraHtml || ""}`;
    } else {
      div.innerHTML = `<div class="health-msg-inner">${formatRich(text)}</div>${extraHtml || ""}`;
    }
    log.appendChild(div);
    scrollLog();
  }

  function appendGuidedStep(step) {
    const { log } = getEls();
    if (!log || !step) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-guided-wrap";
    const btns = (step.options || [])
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-guided-option="1" data-step-id="${escapeHtml(
            step.id
          )}" data-value="${escapeHtml(o.value)}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    wrap.innerHTML = `<div class="health-msg-inner">${formatRich(step.prompt)}</div><p class="health-msg-disclaimer" role="note">${escapeHtml(
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

  async function sendMessage(getSpecies, getKnowledge, opts) {
    const { input, log } = getEls();
    if (!input) return;
    if (!guidedComplete) {
      appendBubble("bot", "请先点选上方的选项，完成基本信息后再描述症状。", "");
      return;
    }
    const raw = input.value.trim();
    if (!raw) return;
    input.value = "";

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const composed = prefix ? prefix + raw : raw;

    appendBubble("user", raw, "");
    history.push({ role: "user", content: composed });
    setLoading(true);

    const species = getChatSpecies(getSpecies);

    let metaHtml = "";
    let replyText = "";
    let localMeta = null;
    let fromLlm = false;

    try {
      const fr = await fetchLlmReply(composed, species);
      if (fr.llm) {
        replyText = fr.llm.text;
        fromLlm = true;
        metaHtml = `<p class="health-msg-source muted">由大模型生成 · 仍不能代替兽医诊断</p>`;
      } else {
        try {
          localMeta = CuraHealthBotLocal.reply({ message: composed, species, knowledge });
        } catch (e2) {
          localMeta = {
            text: "本地知识库暂时无法生成回复，请稍后再试或使用首页分诊流程。",
          };
        }
        replyText = localMeta.text;
        const reason = fr.apiHint ? escapeHtml(fr.apiHint) : "未返回大模型内容";
        metaHtml = `<p class="health-msg-source muted">已用本地知识库回答（原因：${reason}）</p>`;
      }
    } catch (e) {
      try {
        localMeta = CuraHealthBotLocal.reply({ message: composed, species, knowledge });
        replyText = localMeta.text;
      } catch (e2) {
        replyText = "对话出错，请刷新页面后重试。";
        localMeta = { text: replyText };
      }
      metaHtml = `<p class="health-msg-source muted">已使用本地知识库（${escapeHtml(e.message || "请求异常")}）</p>`;
    }

    if (!fromLlm && localMeta) {
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
      if (parts.length) {
        metaHtml += `<div class="health-msg-actions">${parts.join("")}</div>`;
      }
    }

    history.push({ role: "assistant", content: replyText });
    appendBubble("bot", replyText, metaHtml);

    setLoading(false);
    scrollLog();
  }

  function refreshChatStatus() {}

  function advanceGuided(getKnowledge, getSpecies, opts) {
    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    if (guidedStepIndex >= steps.length) {
      guidedComplete = true;
      updateChatInputState();
      const hc = (knowledge && knowledge.healthChat) || {};
      const done =
        hc.guidedDonePrompt ||
        "好的，已记录你的选择。请用自然语言描述最近最担心的症状或变化（不能代替兽医诊断）。";
      appendBubble("bot", done, "");
      const { input } = getEls();
      if (input) setTimeout(() => input.focus(), 120);
      return;
    }
    appendGuidedStep(steps[guidedStepIndex]);
  }

  function onGuidedOptionClick(btn, getKnowledge, getSpecies, opts) {
    if (guidedComplete) return;
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

  function resetConversation(getKnowledge, getSpecies) {
    history.length = 0;
    chatProfile = {};
    guidedStepIndex = 0;
    guidedComplete = false;
    syncProfileToWindow();

    const { log } = getEls();
    if (log) log.innerHTML = "";
    updateChatInputState();
    advanceGuided(getKnowledge, getSpecies, global.__healthChatOpts || {});
    refreshChatStatus();
    scrollLog();
  }

  function openView(getKnowledge, getSpecies, opts) {
    global.__healthChatOpts = opts || {};
    resetConversation(getKnowledge, getSpecies);
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
        const gBtn = e.target && e.target.closest && e.target.closest("[data-guided-option]");
        if (gBtn && !guidedComplete) {
          e.preventDefault();
          onGuidedOptionClick(gBtn, getKnowledge, getSpecies, opts);
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

    global.CuraHealthChat = {
      open: () => openView(getKnowledge, getSpecies, opts),
      reset: () => resetConversation(getKnowledge, getSpecies),
      syncSpecies: function () {
        /* 与首页物种解耦，不再同步 */
      },
    };
  }

  global.CuraHealthChatInit = init;
})(typeof window !== "undefined" ? window : globalThis);
