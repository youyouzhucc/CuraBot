/**
 * 猫狗健康机器人：优先调用服务端 /api/chat（可选 OpenAI），失败则用 CuraHealthBotLocal。
 */
(function (global) {
  const history = [];
  /** 每条机器人回复末尾展示（若正文中已含该句则不再重复追加） */
  const BOT_DISCLAIMER_LINE = "建议仅供参考，急症请优先去医院。";

  function withBotDisclaimer(text) {
    const t = String(text || "").trim();
    if (!t) return BOT_DISCLAIMER_LINE;
    if (t.includes(BOT_DISCLAIMER_LINE)) return t;
    return t + "\n\n" + BOT_DISCLAIMER_LINE;
  }

  /**
   * 后端 API 根地址（与页面不同端口时必须配置，否则会请求到错误主机导致 404）。
   * 优先级：window.CURABOT_API_BASE（可在 index.html 里写死）> 本机常见开发端口自动指向 3000 > 空（同域相对路径）。
   */
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
      badge: document.getElementById("healthChatSpeciesBadge"),
    };
  }

  function scrollLog() {
    const { log } = getEls();
    if (log) log.scrollTop = log.scrollHeight;
  }

  function appendBubble(role, text, extraHtml) {
    const { log } = getEls();
    if (!log) return;
    const div = document.createElement("div");
    div.className = `health-msg health-msg--${role === "user" ? "user" : "bot"}`;
    div.setAttribute("role", role === "user" ? "listitem" : "listitem");
    const body = role === "bot" ? withBotDisclaimer(text) : text;
    div.innerHTML = `<div class="health-msg-inner">${formatRich(body)}</div>${extraHtml || ""}`;
    log.appendChild(div);
    scrollLog();
  }

  function setLoading(on) {
    const { form, input } = getEls();
    if (input) input.disabled = on;
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
    const raw = input.value.trim();
    if (!raw) return;
    input.value = "";
    appendBubble("user", raw, "");
    history.push({ role: "user", content: raw });
    setLoading(true);

    const species = getSpecies();
    const knowledge = getKnowledge();

    let metaHtml = "";
    let replyText = "";
    let localMeta = null;
    let fromLlm = false;

    try {
      const fr = await fetchLlmReply(raw, species);
      if (fr.llm) {
        replyText = fr.llm.text;
        fromLlm = true;
        metaHtml = `<p class="health-msg-source muted">由大模型生成 · 仍不能代替兽医诊断</p>`;
      } else {
        try {
          localMeta = CuraHealthBotLocal.reply({ message: raw, species, knowledge });
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
        localMeta = CuraHealthBotLocal.reply({ message: raw, species, knowledge });
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

  function refreshChatStatus() {
    /* 已移除页眉云端状态区；若需排查可打开开发者工具查看 /api/chat/status */
  }

  function syncBadge(getSpecies) {
    const { badge } = getEls();
    if (badge) {
      const sp = getSpecies();
      badge.textContent = sp === "dog" ? "当前：狗狗" : "当前：猫咪";
    }
  }

  function resetConversation(getKnowledge, getSpecies) {
    history.length = 0;
    const { log } = getEls();
    if (log) log.innerHTML = "";
    const k = getKnowledge();
    const hc = (k && k.healthChat) || {};
    const welcome =
      hc.welcome ||
      "你好，我是 CuraBot 健康机器人。告诉我毛孩子的情况，我会帮你尽可能识别问题，有紧急问题请赶紧送ta去医院就诊哦~";
    appendBubble("bot", welcome, "");
    const chips = hc.quickChips || ["猫尿很少怎么办", "狗吃了巧克力", "急症有哪些"];
    const sp = getSpecies();
    const chipRow = chips
      .map(
        (c) =>
          `<button type="button" class="btn secondary soft health-chip" data-chip="${escapeHtml(c)}">${escapeHtml(
            c
          )}</button>`
      )
      .join("");
    if (log) {
      const wrap = document.createElement("div");
      wrap.className = "health-chips-wrap";
      wrap.innerHTML = `<p class="muted health-chips-label">试试问：</p><div class="health-chips">${chipRow}</div>`;
      log.appendChild(wrap);
      wrap.querySelectorAll("[data-chip]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const { input } = getEls();
          if (input) input.value = btn.getAttribute("data-chip") || "";
          sendMessage(getSpecies, getKnowledge, global.__healthChatOpts || {});
        });
      });
    }
    refreshChatStatus();
    syncBadge(getSpecies);
    scrollLog();
  }

  function openView(getKnowledge, getSpecies, opts) {
    global.__healthChatOpts = opts || {};
    resetConversation(getKnowledge, getSpecies);
    const { input } = getEls();
    if (input) setTimeout(() => input.focus(), 200);
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
      syncSpecies: () => syncBadge(getSpecies),
    };
  }

  global.CuraHealthChatInit = init;
})(typeof window !== "undefined" ? window : globalThis);
