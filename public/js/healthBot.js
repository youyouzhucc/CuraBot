/**
 * 猫狗健康机器人：引导选择题收集档案 → 再对话；优先 /api/chat，失败用 CuraHealthBotLocal。
 * 物种优先与首页入口 state.species 一致；档案见 window.__healthChatProfile。
 */
(function (global) {
  const history = [];
  const BOT_DISCLAIMER_LINE = "建议由大模型生成，不能代替兽医诊断，急症请优先去就医。";
  const CHAT_STORE_PREFIX = "curabot_health_chat_v2:";
  const CHAT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
  const CHAT_MAX_MESSAGES = 5000;
  /** 单条消息纯文本与 HTML 快照上限（localStorage 有总配额，但长选项/决策树需完整保留） */
  const CHAT_MAX_CONTENT_CHARS = 500000;
  const CHAT_MAX_HTML_CHARS = 450000;

  let chatProfile = {};
  let guidedStepIndex = 0;
  let guidedComplete = false;
  /** 用户最近一次在输入框提交的症状原文（用于追问选项合并上下文） */
  let lastUserPlainInput = "";
  /** 症状追问里用户点选的「（补充）…」行，按顺序累积，供本地分层与 LLM 历史对齐 */
  let quizSupplementLines = [];
  /** 已在会话中回答过的症状追问 id，避免重复弹出同一题 */
  let answeredQuizIds = [];
  /** JSON 决策树会话（HealthCheckSession 结构由 healthDecisionEngine 创建） */
  let decisionSession = null;
  /** 是否处于决策树选择题阶段（此时仍锁定自由输入） */
  let treePhaseActive = false;
  /** 服务端持久化返回的会话 id */
  let persistedHealthSessionId = null;
  /** 当前会话 id（按账号隔离） */
  let currentSessionId = null;

  const MAX_CHAT_IMAGES = 9;
  /** 待发送的图片（在输入框旁预览，与文字一并发送） */
  let pendingChatImages = [];
  /** 强制追问开场白轮换，避免连续重复同一句 */
  let lastMandatoryOpenerIndex = -1;

  /** 近期用户原文合并（含补充行），供语境开场白 */
  function getRecentUserBlobForOpeners() {
    const parts = [];
    history
      .filter((h) => h.role === "user")
      .slice(-8)
      .forEach((h) => {
        let c = String(h.content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim();
        if (c) parts.push(c);
      });
    if (quizSupplementLines.length) parts.push(quizSupplementLines.join("\n"));
    return parts.join("\n");
  }

  /** 从用户发言中提取已陈述维度，供摘要防重复追问 */
  function extractStatedDimensionsFromBlob(blob) {
    const b = String(blob || "");
    const out = [];
    if (/(湿咳|水声|咳|喘|呼吸|呼噜)/.test(b)) out.push("呼吸道/咳嗽或呼吸");
    if (/(黄水|胆汁|吐|呕|反流|毛球)/.test(b)) out.push("呕吐或反流");
    if (/(拉|泻|腹泻|软便|便血|便)/.test(b)) out.push("排便");
    if (/(尿|砂盆|排尿|没尿|尿频|尿急|尿血)/.test(b)) out.push("排尿");
    if (/(精神|食欲|不吃|不喝)/.test(b)) out.push("精神或食欲");
    if (/(疼|痛|跛|瘸|扭|骨折)/.test(b)) out.push("疼痛或行动");
    if (/(今天|昨天|前天|天前|小时|次|多久|第|一周)/.test(b)) out.push("时间线或频次");
    return out;
  }

  /** 检测用户是否急躁或重复表示「已说过」——服务端可缩短追问路径 */
  function computeConversationTriage(hist) {
    const h = hist || history;
    const hu = h.filter((x) => x.role === "user").slice(-5);
    if (!hu.length) return { userFeeling: "calm", pace: "standard" };
    const strip = (s) => String(s || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim();
    const last = strip(hu[hu.length - 1].content);
    const frustration = /别问了|说过|不是说过了|刚说了|你都说了|重复问|烦了|直接说|别废话/.test(last);
    const short = last.length > 0 && last.length < 18;
    const lastThree = hu.slice(-3).map((x) => strip(x.content));
    const shortStreak = lastThree.filter((s) => s.length > 0 && s.length < 14).length >= 2;
    if (frustration || (short && shortStreak)) {
      return { userFeeling: "impatient", pace: "brief" };
    }
    return { userFeeling: "calm", pace: "standard" };
  }

  /** 供未来 UI（如身体图谱高亮）读取：关键词粗分身体关注区 */
  function publishSymptomZonesHint(text) {
    if (typeof window === "undefined") return;
    const t = String(text || "");
    const zones = [];
    if (/(吐|呕|胃|黄水|吃|食欲)/.test(t)) zones.push("digestive");
    if (/(咳|喘|呼吸|湿|鼻)/.test(t)) zones.push("respiratory");
    if (/(尿|砂盆|排尿|膀胱)/.test(t)) zones.push("urinary");
    if (/(皮肤|痒|红|疹)/.test(t)) zones.push("skin");
    try {
      window.__curabotLastSymptomZones = zones;
      window.dispatchEvent(new CustomEvent("curabot-symptom-zones", { detail: { zones } }));
    } catch (e) {
      /* ignore */
    }
  }
  /** 当前结构化追问轨道：泌尿专链与通用五维互斥，便于短句补充仍续接同一轨道 */
  let mandatoryThreadKind = null;

  function evidenceCtx() {
    return { mandatoryThreadKind };
  }

  function maybeClearUrinaryTrackOnChiefShift(plainText) {
    const CR = global.CuraChiefRouting;
    if (!CR || plainText == null) return;
    const t = String(plainText).replace(/^【用户已选档案】[\s\S]*?\n\n/, "");
    if (CR.nonUrinaryChiefMessage(t) && !CR.urinaryIntentIn(t) && mandatoryThreadKind === "urinary") {
      mandatoryThreadKind = null;
    }
  }

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

  function healthMsgAvatarHtml(role) {
    if (role === "bot") {
      return `<div class="health-msg-avatar health-msg-avatar--bot" aria-hidden="true"><img class="health-msg-avatar-img" src="/images/brand-logo.png" alt="" width="40" height="40" loading="lazy" decoding="async" /></div>`;
    }
    const gs = typeof global.__healthGetSpecies === "function" ? global.__healthGetSpecies : null;
    const sp = getChatSpecies(gs);
    const src = sp === "dog" ? "/images/hero-dog.png" : "/images/hero-cat.png";
    return `<div class="health-msg-avatar health-msg-avatar--user" aria-hidden="true"><img class="health-msg-avatar-img" src="${escapeHtml(src)}" alt="" width="40" height="40" loading="lazy" decoding="async" /></div>`;
  }

  /** role: bot | user；DOM 顺序均为 [头像][body]，用户行用 CSS row-reverse 把头像放到右侧 */
  function wrapHealthMsgRow(role, bodyHtml) {
    return `<div class="health-msg-row">${healthMsgAvatarHtml(role)}<div class="health-msg-body">${bodyHtml}</div></div>`;
  }

  function getEls() {
    return {
      log: document.getElementById("healthChatMessages"),
      form: document.getElementById("healthChatForm"),
      input: document.getElementById("healthChatInput"),
    };
  }

  function safeNow() {
    return Date.now();
  }

  function newSessionId() {
    return "s_" + safeNow().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function simpleHash(s) {
    const t = String(s || "");
    let h = 2166136261;
    for (let i = 0; i < t.length; i++) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  function getAuthTokenBestEffort() {
    try {
      return localStorage.getItem("curabot_auth_token") || "";
    } catch (e) {
      return "";
    }
  }

  function getAccountScopedKey() {
    let who = "guest";
    const tok = getAuthTokenBestEffort();
    if (tok) {
      who = "tok:" + simpleHash(tok);
    }
    try {
      const acc = global.CuraAccount;
      const st = acc && acc.state;
      const u = st && st.user;
      if (u) {
        const uid = u.id != null && String(u.id).trim() ? String(u.id).trim() : "";
        const em = u.email != null && String(u.email).trim() ? String(u.email).trim().toLowerCase() : "";
        if (uid) who = "uid:" + uid;
        else if (em) who = "email:" + em;
      }
    } catch (e) {
      /* ignore */
    }
    return CHAT_STORE_PREFIX + who;
  }

  function pruneByDays(items, nowTs) {
    const now = nowTs || safeNow();
    return (items || []).filter((x) => {
      const ts = Number(x && x.ts) || 0;
      return ts > 0 && now - ts <= CHAT_RETENTION_MS;
    });
  }

  function safeSessionTitle(s) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    return t.length > 26 ? t.slice(0, 26) + "…" : t;
  }

  function stripProfilePrefix(s) {
    return String(s || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim();
  }

  function stripScriptsFromHtml(html) {
    return String(html || "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
  }

  function cloneJsonSafe(obj) {
    if (obj == null) return null;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      return null;
    }
  }

  function roleFromHealthMsgEl(el) {
    if (!el || !el.classList) return "assistant";
    if (el.classList.contains("health-msg--user")) return "user";
    return "assistant";
  }

  function bubblePlainTextFallback(el) {
    const inner = el.querySelector(".health-msg-inner");
    const t = (inner && inner.innerText) || el.innerText || "";
    return t.replace(/\s+/g, " ").trim().slice(0, CHAT_MAX_CONTENT_CHARS);
  }

  /** 与 #healthChatMessages 子节点对齐，写入完整气泡 HTML，便于切换会话/隔日恢复样式与选项 */
  function buildPersistedHistoryRowsFromDom(domNodes, historyRows, nowTs) {
    const now = nowTs || safeNow();
    const maxLen = Math.max(domNodes.length, historyRows.length);
    const rows = [];
    for (let i = 0; i < maxLen; i++) {
      const el = domNodes[i];
      const h = historyRows[i];
      if (el) {
        const roleHist = roleFromHealthMsgEl(el) === "user" ? "user" : "assistant";
        let content = h ? String(h.content || "") : bubblePlainTextFallback(el);
        if (content.length > CHAT_MAX_CONTENT_CHARS) content = content.slice(0, CHAT_MAX_CONTENT_CHARS);
        let html = stripScriptsFromHtml(el.outerHTML);
        if (html.length > CHAT_MAX_HTML_CHARS) html = html.slice(0, CHAT_MAX_HTML_CHARS);
        rows.push({
          role: roleHist,
          content,
          ts: h ? Number(h.ts) || now : now,
          html,
        });
      } else if (h) {
        rows.push({
          role: h.role === "assistant" ? "assistant" : "user",
          content: String(h.content || "").slice(0, CHAT_MAX_CONTENT_CHARS),
          ts: Number(h.ts) || now,
        });
      }
    }
    return pruneByDays(rows, now);
  }

  function restoreInteractiveStateForHistory(log) {
    if (!log) return;
    const sel =
      "[data-decision-tree-option], [data-guided-option], [data-mandatory-option], [data-followup-option], [data-start-guided-intake]";
    log.querySelectorAll(sel).forEach((b) => {
      b.disabled = true;
    });
    if (treePhaseActive && decisionSession) {
      const wraps = log.querySelectorAll(".health-decision-tree-wrap");
      const last = wraps[wraps.length - 1];
      if (last) {
        last.querySelectorAll("[data-decision-tree-option]").forEach((b) => {
          b.disabled = false;
        });
      }
      return;
    }
    if (!guidedComplete && !treePhaseActive) {
      const wraps = log.querySelectorAll(".health-guided-wrap");
      const last = wraps[wraps.length - 1];
      if (last) {
        last.querySelectorAll("[data-guided-option]").forEach((b) => {
          b.disabled = false;
        });
      }
      return;
    }
    const msgs = log.querySelectorAll(".health-msg--bot");
    const lastBot = msgs.length ? msgs[msgs.length - 1] : null;
    if (lastBot && lastBot.classList.contains("health-mandatory-wrap")) {
      lastBot.querySelectorAll("[data-mandatory-option]").forEach((b) => {
        b.disabled = false;
      });
      return;
    }
    if (lastBot && lastBot.classList.contains("health-followup-wrap")) {
      const qid = lastBot.getAttribute("data-quiz-id") || "q";
      if (answeredQuizIds.indexOf(qid) === -1) {
        lastBot.querySelectorAll("[data-followup-option]").forEach((b) => {
          b.disabled = false;
        });
      }
    }
  }

  function deriveDefaultTitleFromHistory(items) {
    const hs = Array.isArray(items) ? items : [];
    for (let i = 0; i < hs.length; i++) {
      const row = hs[i];
      if (!row || row.role !== "user") continue;
      const c = stripProfilePrefix(row.content);
      if (!c) continue;
      return safeSessionTitle(c);
    }
    return "新会话";
  }

  function normalizeSessionRecord(raw, nowTs) {
    const now = nowTs || safeNow();
    const h = pruneByDays(
      (raw && Array.isArray(raw.history) ? raw.history : []).map((x) => ({
        role: x && x.role === "assistant" ? "assistant" : "user",
        content: String((x && x.content) || "").slice(0, CHAT_MAX_CONTENT_CHARS),
        ts: Number(x && x.ts) || now,
        html:
          x && typeof x.html === "string" && x.html.length
            ? x.html.slice(0, CHAT_MAX_HTML_CHARS)
            : undefined,
      })),
      now
    );
    let title = safeSessionTitle(raw && raw.title);
    if (!title || title === "历史会话" || title === "新会话") {
      title = deriveDefaultTitleFromHistory(h);
    }
    return {
      id: (raw && raw.id) || newSessionId(),
      title,
      createdAt: Number((raw && raw.createdAt) || now),
      updatedAt: Number((raw && raw.updatedAt) || now),
      history: h,
      chatProfile: raw && raw.chatProfile && typeof raw.chatProfile === "object" ? raw.chatProfile : {},
      lastUserPlainInput: String((raw && raw.lastUserPlainInput) || ""),
      decisionSession: raw && raw.decisionSession != null ? cloneJsonSafe(raw.decisionSession) : null,
      treePhaseActive: !!(raw && raw.treePhaseActive),
      guidedStepIndex: Number(raw && raw.guidedStepIndex) || 0,
      guidedComplete: raw == null || raw.guidedComplete !== false,
      quizSupplementLines: Array.isArray(raw && raw.quizSupplementLines) ? raw.quizSupplementLines.slice(0, 400) : [],
      answeredQuizIds: Array.isArray(raw && raw.answeredQuizIds) ? raw.answeredQuizIds.slice(0, 400) : [],
      mandatoryThreadKind: raw && raw.mandatoryThreadKind != null ? String(raw.mandatoryThreadKind) : null,
    };
  }

  function newBlankSessionRecord(presetProfile) {
    const now = safeNow();
    return {
      id: newSessionId(),
      title: "新会话",
      createdAt: now,
      updatedAt: now,
      history: [],
      chatProfile: presetProfile && typeof presetProfile === "object" ? { ...presetProfile } : {},
      lastUserPlainInput: "",
      decisionSession: null,
      treePhaseActive: false,
      guidedStepIndex: 0,
      guidedComplete: true,
      quizSupplementLines: [],
      answeredQuizIds: [],
      mandatoryThreadKind: null,
    };
  }

  function normalizeStore(raw) {
    const now = safeNow();
    const src = raw && typeof raw === "object" ? raw : {};
    const sessionsRaw = Array.isArray(src.sessions)
      ? src.sessions
      : Array.isArray(src.history)
        ? [
            {
              id: src.currentSessionId || newSessionId(),
              title: src.title || "",
              createdAt: src.savedAt || now,
              updatedAt: src.savedAt || now,
              history: src.history,
              chatProfile: src.chatProfile || {},
              lastUserPlainInput: src.lastUserPlainInput || "",
            },
          ]
        : [];
    const sessions = sessionsRaw.map((s) => normalizeSessionRecord(s, now)).filter((s) => s.history.length || s.chatProfile);
    return {
      version: 4,
      savedAt: now,
      currentSessionId: src.currentSessionId || (sessions[0] && sessions[0].id) || null,
      sessions: sessions.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)),
    };
  }

  function safeReadChatStore() {
    try {
      const key = getAccountScopedKey();
      const raw = localStorage.getItem(key);
      if (raw) return normalizeStore(JSON.parse(raw));
      // 兼容：登录后若之前写在 guest，先兜底读取并迁移，避免“切换会话后消失”
      if (key !== CHAT_STORE_PREFIX + "guest") {
        const guestRaw = localStorage.getItem(CHAT_STORE_PREFIX + "guest");
        if (guestRaw) {
          const guestStore = normalizeStore(JSON.parse(guestRaw));
          if ((guestStore.sessions || []).length) {
            localStorage.setItem(key, JSON.stringify(guestStore));
            return guestStore;
          }
        }
      }
      return normalizeStore({});
    } catch (e) {
      return normalizeStore({});
    }
  }

  function safeWriteChatStore(store) {
    try {
      const s = normalizeStore(store);
      localStorage.setItem(getAccountScopedKey(), JSON.stringify(s));
    } catch (e) {
      /* ignore */
    }
  }

  function getSessionById(store, id) {
    const arr = (store && store.sessions) || [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === id) return arr[i];
    }
    return null;
  }

  function ensureCurrentSession(store, presetProfile) {
    let s = getSessionById(store, store.currentSessionId);
    if (!s) {
      s = newBlankSessionRecord(presetProfile);
      store.sessions.unshift(s);
      store.currentSessionId = s.id;
    }
    return s;
  }

  function formatSessionTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return "";
    const d = new Date(t);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${dd} ${hh}:${mm}`;
  }

  function renderSessionListUi() {
    const host = document.getElementById("healthSessionList");
    if (!host) return;
    const store = safeReadChatStore();
    const html = (store.sessions || [])
      .slice()
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
      .map((s) => {
        const active = s.id === store.currentSessionId ? " is-active" : "";
        return `<div class="health-session-item${active}" data-session-id="${escapeHtml(s.id)}">
          <button type="button" class="health-session-open" data-session-open="${escapeHtml(s.id)}">
            <span class="health-session-title">${escapeHtml(s.title || "新会话")}</span>
            <span class="health-session-time">${escapeHtml(formatSessionTime(s.createdAt || s.updatedAt))}</span>
          </button>
          <div class="health-session-actions">
            <button type="button" class="health-session-rename" data-session-rename="${escapeHtml(s.id)}" title="改名" aria-label="改名">✎</button>
            <button type="button" class="health-session-delete" data-session-delete="${escapeHtml(s.id)}" title="删除" aria-label="删除">×</button>
          </div>
        </div>`;
      })
      .join("");
    host.innerHTML = html || `<p class="muted small">暂无会话</p>`;
  }

  function switchSessionById(targetId, getKnowledge, getSpecies, presetProfile) {
    const store = safeReadChatStore();
    if (!getSessionById(store, targetId)) return;
    store.currentSessionId = targetId;
    safeWriteChatStore(store);
    resetConversation(getKnowledge, getSpecies, presetProfile, { forceNew: false });
  }

  function openSessionRenameDialog(currentTitle) {
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "health-session-modal-mask";
      const safeTitle = escapeHtml(currentTitle || "新会话");
      mask.innerHTML = `
        <div class="health-session-modal" role="dialog" aria-modal="true" aria-label="编辑会话名称">
          <p class="health-session-modal-title">编辑会话名称</p>
          <input type="text" class="health-session-modal-input" value="${safeTitle}" maxlength="26" />
          <div class="health-session-modal-actions">
            <button type="button" class="btn secondary soft" data-session-modal-cancel="1">取消</button>
            <button type="button" class="btn" data-session-modal-ok="1">确认</button>
          </div>
        </div>
      `;
      document.body.appendChild(mask);
      const input = mask.querySelector(".health-session-modal-input");
      const close = (val) => {
        if (mask && mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(val);
      };
      mask.addEventListener("click", (e) => {
        if (e.target === mask) close(null);
      });
      const cancelBtn = mask.querySelector("[data-session-modal-cancel]");
      const okBtn = mask.querySelector("[data-session-modal-ok]");
      if (cancelBtn) cancelBtn.addEventListener("click", () => close(null));
      if (okBtn)
        okBtn.addEventListener("click", () => {
          close(input ? input.value : "");
        });
      if (input) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 10);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            close(input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close(null);
          }
        });
      }
    });
  }

  async function renameSessionById(targetId) {
    const store = safeReadChatStore();
    const s = getSessionById(store, targetId);
    if (!s) return;
    const next = await openSessionRenameDialog(s.title || "新会话");
    if (next == null) return;
    const title = safeSessionTitle(next) || deriveDefaultTitleFromHistory(s.history);
    s.title = title;
    s.updatedAt = safeNow();
    safeWriteChatStore(store);
    renderSessionListUi();
  }

  function deleteSessionById(targetId, getKnowledge, getSpecies) {
    const store = safeReadChatStore();
    const arr = (store.sessions || []).slice();
    const idx = arr.findIndex((x) => x.id === targetId);
    if (idx < 0) return;
    if (!window.confirm("确认删除该会话？删除后不可恢复。")) return;
    arr.splice(idx, 1);
    if (!arr.length) {
      const ns = newBlankSessionRecord({});
      arr.push(ns);
      store.currentSessionId = ns.id;
    } else if (store.currentSessionId === targetId) {
      arr.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      store.currentSessionId = arr[0].id;
    }
    store.sessions = arr;
    safeWriteChatStore(store);
    resetConversation(getKnowledge, getSpecies, undefined, { forceNew: false });
  }

  function persistConversationSnapshot() {
    try {
      const now = safeNow();
      const store = safeReadChatStore();
      const current = ensureCurrentSession(store, chatProfile);
      currentSessionId = current.id;
      const { log } = getEls();
      const domNodes = log
        ? Array.from(log.children).filter((el) => el.classList && el.classList.contains("health-msg"))
        : [];
      current.history = buildPersistedHistoryRowsFromDom(domNodes, history, now);
      current.chatProfile = chatProfile && typeof chatProfile === "object" ? { ...chatProfile } : {};
      current.lastUserPlainInput = String(lastUserPlainInput || "");
      current.decisionSession = cloneJsonSafe(decisionSession);
      current.treePhaseActive = !!treePhaseActive;
      current.guidedStepIndex = guidedStepIndex;
      current.guidedComplete = !!guidedComplete;
      current.quizSupplementLines = quizSupplementLines.slice();
      current.answeredQuizIds = answeredQuizIds.slice();
      current.mandatoryThreadKind = mandatoryThreadKind || null;
      current.updatedAt = now;
      current.title = safeSessionTitle(current.title);
      if (!current.title || current.title === "新会话") {
        current.title = deriveDefaultTitleFromHistory(current.history);
      }
      store.currentSessionId = current.id;
      store.savedAt = now;
      store.sessions = (store.sessions || []).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      safeWriteChatStore(store);
      renderSessionListUi();
    } catch (e) {
      /* ignore */
    }
  }

  function clearExpiredStoresBestEffort() {
    try {
      const now = safeNow();
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || k.indexOf(CHAT_STORE_PREFIX) !== 0) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        let j = null;
        try {
          j = JSON.parse(raw);
        } catch (e) {
          localStorage.removeItem(k);
          continue;
        }
        const savedAt = Number(j && j.savedAt) || 0;
        if (!savedAt || now - savedAt > CHAT_RETENTION_MS * 2) {
          localStorage.removeItem(k);
          continue;
        }
        if (j && Array.isArray(j.sessions)) {
          const cleaned = normalizeStore(j);
          if (!cleaned.sessions.length) localStorage.removeItem(k);
          else localStorage.setItem(k, JSON.stringify(cleaned));
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  /** 将聊天区滚动到新消息顶部，便于先看到结论开头（避免停在气泡底部） */
  function scrollLogToElement(el) {
    const { log } = getEls();
    if (!log || !el) return;
    requestAnimationFrame(() => {
      const lr = log.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const delta = er.top - lr.top + log.scrollTop;
      log.scrollTop = Math.max(0, delta - 6);
    });
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
    const extras = [];
    if (profile.petNickname) extras.push(`昵称：${profile.petNickname}`);
    if (profile.petBreed) extras.push(`品种：${profile.petBreed}`);
    if (profile.weightKg != null && profile.weightKg !== "") extras.push(`体重约 ${profile.weightKg} kg`);
    if (profile.petNotes) extras.push(`备注：${profile.petNotes}`);
    if (extras.length) {
      parts.unshift(extras.join("；"));
    }
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

  function updateHealthImageControlsVisibility() {
    const pending = document.getElementById("healthChatPending");
    if (pending) {
      pending.hidden = true;
      pending.innerHTML = "";
    }
  }

  function addPendingChatFiles(_fileList) {
    /* 图片上传已关闭：避免未完成依赖链时误导用户 */
  }

  function renderPendingChatPreviews() {
    const wrap = document.getElementById("healthChatPending");
    if (!wrap) return;
    wrap.innerHTML = "";
    wrap.hidden = true;
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

  async function uploadHealthImageGetUrl(file) {
    if (typeof window !== "undefined" && window.location && window.location.protocol === "file:") {
      const manual = window.CURABOT_API_BASE;
      if (manual == null || String(manual).trim() === "") {
        throw new Error(
          "当前为本地文件方式打开页面，无法上传。请在本项目目录运行 npm start 后打开站点，或设置 window.CURABOT_API_BASE 指向 API 根地址。"
        );
      }
    }
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(apiUrl("/api/health-upload"), { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.url) throw new Error((j && j.message) || (j && j.error) || "上传失败");
    return j.url;
  }

  async function analyzeHealthImageUrl(imageUrl, species) {
    const vr = await fetch(apiUrl("/api/vision/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageUrl,
        species,
        context: lastUserPlainInput || "",
      }),
    });
    const vj = await vr.json().catch(() => ({}));
    let text = vj && vj.text != null ? String(vj.text).trim() : "";
    if (text) return text;
    if (!vr.ok) {
      return "视觉分析失败（HTTP " + vr.status + "）。" + (vj && vj.error ? String(vj.error) : "");
    }
    return "（无分析文本）";
  }

  /**
   * 批量处理图片：合并视觉说明（需 API）。
   * @param {{ skipUserBubble?: boolean }} opts 与文字同发时跳过第二条用户气泡，仅追加附图与助手说明
   */
  async function processChatImageFiles(files, getKnowledge, getSpecies, opts) {
    if (!files || !files.length) return;
    const optsIn = opts || {};
    const skipUserBubble = !!optsIn.skipUserBubble;
    const species = getChatSpecies(getSpecies);
    const n = files.length;
    if (!skipUserBubble) {
      appendBubble("user", "📷 已发送 " + n + " 张图片", "");
    }
    const blocks = [];
    const urls = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const url = await uploadHealthImageGetUrl(files[i]);
        urls.push(url);
        const text = await analyzeHealthImageUrl(url, species);
        blocks.push("**图片 " + (i + 1) + " / " + n + "**\n" + text);
      } catch (e) {
        blocks.push("**图片 " + (i + 1) + " / " + n + "**\n处理失败：" + (e.message || e));
      }
    }
    history.push({
      role: "user",
      content: "[附图 " + n + " 张]" + (urls.length ? " " + urls.join(" ") : ""),
    });
    const body = "**视觉辅助参考（非诊断）**\n\n" + blocks.join("\n\n---\n\n");
    history.push({ role: "assistant", content: blocks.join("\n---\n"), ts: safeNow() });
    appendBubble("bot", body, "", { severity: "unclear" });
    persistConversationSnapshot();
    await postHealthSessionSnapshot(getKnowledge, getSpecies);
  }

  function updateChatInputState() {
    const { input } = getEls();
    if (!input) return;
    pendingChatImages = [];
    renderPendingChatPreviews();
    input.disabled = false;
    const gs = typeof global.__healthGetSpecies === "function" ? global.__healthGetSpecies : null;
    const sp = gs ? getChatSpecies(gs) : chatProfile.species || null;
    if (treePhaseActive) {
      input.placeholder = "（可选）在此补充描述；完成上方选择题后系统会一并参考。";
    } else if (sp === "dog") {
      input.placeholder = "例如：拉肚子、呕吐、精神很差、跛行…";
    } else {
      input.placeholder = "例如：一天没尿了、精神很差、呕吐…";
    }
    updateHealthImageControlsVisibility();
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
    const hideTierBadge = opts.hideTierBadge === true;
    const { log } = getEls();
    if (!log) return;
    const div = document.createElement("div");
    const tierClass =
      role === "bot" && !hideTierBadge && tier && tierLabels[tier] ? ` health-msg--tier-${tier}` : "";
    div.className = `health-msg health-msg--${role === "user" ? "user" : "bot"}${tierClass}`;
    div.setAttribute("role", "listitem");
    if (role === "bot") {
      const showDisclaimer = opts.showDisclaimer !== false;
      const main = stripDisclaimerFromBody(text);
      const disclaimerHtml = showDisclaimer
        ? `<p class="health-msg-disclaimer" role="note">${escapeHtml(BOT_DISCLAIMER_LINE)}</p>`
        : "";
      const tierBadge =
        !hideTierBadge && tier && tierLabels[tier]
          ? `<p class="health-tier-badge health-tier-badge--${tier}" role="status"><span class="health-tier-badge-inner">${escapeHtml(
              tierLabels[tier]
            )}</span></p>`
          : "";
      const bodyInner = `${tierBadge}<div class="health-msg-inner">${formatRich(main)}</div>${disclaimerHtml}${extraHtml || ""}`;
      div.innerHTML = wrapHealthMsgRow("bot", bodyInner);
    } else {
      const bodyInner = `<div class="health-msg-inner">${formatRich(text)}</div>${extraHtml || ""}`;
      div.innerHTML = wrapHealthMsgRow("user", bodyInner);
    }
    log.appendChild(div);
    scrollLogToElement(div);
  }

  function persistAssistantPromptLine(text) {
    const line = String(text || "").trim();
    if (!line) return;
    const last = history.length ? history[history.length - 1] : null;
    if (last && last.role === "assistant" && String(last.content || "").trim() === line) return;
    history.push({ role: "assistant", content: line, ts: safeNow() });
    persistConversationSnapshot();
  }

  function optionsDigest(options) {
    const arr = Array.isArray(options) ? options : [];
    const labels = arr
      .map((o) => String((o && o.label) || "").trim())
      .filter(Boolean);
    if (!labels.length) return "";
    return "选项：" + labels.join(" / ");
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
    wrap.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">${formatRich(quiz.prompt)}</div><div class="health-guided-options">${btns}</div>`
    );
    log.appendChild(wrap);
    scrollLogToElement(wrap);
    const digest = optionsDigest(quiz.options);
    persistAssistantPromptLine([quiz.prompt, digest].filter(Boolean).join("\n"));
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
    wrap.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">${formatRich(displayStep.prompt)}</div><div class="health-guided-options">${btns}</div>`
    );
    log.appendChild(wrap);
    scrollLogToElement(wrap);
    const digest = optionsDigest(displayStep.options);
    persistAssistantPromptLine([displayStep.prompt, digest].filter(Boolean).join("\n"));
  }

  /**
   * 当前咨询物种：优先与首页入口一致（app.state.species），避免档案/缓存里的猫狗与本次点击不一致。
   */
  function getChatSpecies(getSpecies) {
    const ext = getSpecies && getSpecies();
    if (ext === "cat" || ext === "dog") return ext;
    const fromProfile = chatProfile.species;
    if (fromProfile === "cat" || fromProfile === "dog") return fromProfile;
    return null;
  }

  function setLoading(on) {
    const { form, input } = getEls();
    if (input) input.disabled = on;
    const btn = form && form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = on;
    const soap = document.getElementById("btnSoapReport");
    if (soap) soap.disabled = on;
  }

  /** 自由对话：对高风险但信息不足的描述附加后端 system 片段，强制启发式问诊 */
  function inferInquiryHint(composedMessage, species) {
    const t = String(composedMessage || "");
    const strip = t.replace(/^【用户已选档案】[\s\S]*?\n\n/, "");
    const sp = species || "cat";

    /** 近期用户发言合并（用于识别「上一句说没尿、这句只说男生」仍处同一线程） */
    const recentUserBlob = history
      .filter((h) => h.role === "user")
      .slice(-10)
      .map((h) => String(h.content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, ""))
      .join("\n");

    const ctx = evidenceCtx();
    const Eng = global.CuraCatUroEvidence;
    const uroEv = Eng && Eng.compute ? Eng.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    if (uroEv && uroEv.threadActive) {
      if (uroEv.immediateDanger) return null;
      if (!uroEv.allowEmergencyTag) {
        return sp === "dog" ? "dog_urinary_mandatory_probing" : "cat_urinary_mandatory_probing";
      }
      return null;
    }

    const Gen = global.CuraGeneralClinicalEvidence;
    const genEv = Gen && Gen.compute ? Gen.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    if (genEv && genEv.threadActive) {
      if (genEv.immediateDanger) return null;
      if (!genEv.allowEmergencyTag) return "general_mandatory_probing";
    }

    const catUrinaryInThread =
      sp === "cat" &&
      !/(狗|犬)/.test(strip + recentUserBlob) &&
      /(没尿|无尿|不尿|尿不出|尿团|排尿|少尿|尿频|尿急|尿闭|蹲盆|砂盆|滴尿|一天.*尿|整天.*尿|很久.*尿)/.test(recentUserBlob + "\n" + strip);

    const dogUrinaryInThread =
      sp === "dog" &&
      !/(猫|喵)/.test(strip + recentUserBlob) &&
      /(没尿|无尿|不尿|尿不出|排尿|少尿|尿频|尿急|尿闭|滴尿|尿血|血尿|一天.*尿|整天.*尿|很久.*尿)/.test(recentUserBlob + "\n" + strip);

    /** 本条仅为性别/绝育/年龄段等短补充，未新增排尿细节时，模型易结合历史误判急诊，须继续走启发式 */
    function isShortDemographicsOnly(s) {
      const x = String(s || "").trim();
      if (x.length >= 56) return false;
      if (/(吐|呕|腹|胀|血|滴尿|尿血|精神|不吃|疼痛|呕吐|尿频|无尿|没尿|不尿)/.test(x)) return false;
      return /^(他是|她是|公猫|母猫|公狗|母狗|男生|女生|雄性|雌性|已绝育|未绝育|绝育|不清楚|幼年|成年|老年)/.test(x) || /^(他|她)(是|的)/.test(x);
    }

    if (catUrinaryInThread && isShortDemographicsOnly(strip)) {
      return "cat_urinary_heuristic";
    }
    if (dogUrinaryInThread && isShortDemographicsOnly(strip)) {
      return "dog_urinary_heuristic";
    }

    if (
      sp === "cat" &&
      !/(狗|犬)/.test(strip) &&
      /(尿|排尿|尿团|砂盆)/.test(strip) &&
      /(没|无|不|少|一天|整天|小时|很久|担心|着急)/.test(strip)
    ) {
      if (!/(滴尿|频尿|尿血|粉红|呕|吐|精神差|不吃|疼|痛|尿闭|绝育|公猫|母猫|腹部|胀|血尿|蹲盆|舔尿道)/.test(strip)) {
        return "cat_urinary_heuristic";
      }
    }
    if (sp === "dog" && /(尿|排尿)/.test(strip) && /(没|无|少|不|血|费力)/.test(strip) && !/(精神|呕|吐|胀|疼)/.test(strip)) {
      return "dog_urinary_heuristic";
    }
    if (strip.length < 48 && /(不舒服|难受|怪怪的|担心|反常)/.test(strip) && !/(吐|泻|尿|喘|瘸|拉|吃|喝)/.test(strip)) {
      return "vague_concern";
    }
    const compact = strip.replace(/\s/g, "");
    if (
      compact.length < 96 &&
      /(吐|呕|腹泻|拉稀|软便|咳|喘|瘸|跛|骨折|骨裂|扭伤|脱臼|外伤|尿血|尿频|尿急|精神差|不吃|食欲|发烧|体温|抽搐|皮肤|痒|红肿)/.test(strip) &&
      !/(今天|昨日|昨天|前天|天前|小时|多天|三天|两天|一周|一直|从小|多久|几次|第|约|大概)/.test(strip)
    ) {
      return "symptom_followup_heuristic";
    }
    return null;
  }

  /** 去掉模型偶发的「循证 UI」噪声行，便于家长扫读 */
  function stripCatUrinaryLlmFluff(text) {
    let t = String(text || "");
    t = t
      .split("\n")
      .filter((line) => {
        const s = line.trim();
        if (!s) return true;
        if (/循证进度|关注指数|非诊断|第\s*\d+\s*\/\s*5\s*项/.test(s)) return false;
        if (/^#{1,6}\s*(循证|说明|现状)/.test(s)) return false;
        if (/^\*\*说明\*\*：|^说明：/.test(s)) return false;
        return true;
      })
      .join("\n");
    t = t.replace(/\n{3,}/g, "\n\n").trim();
    return t;
  }

  /** 排尿/通用引导：循证未满时与 server 一致，禁止单句判「紧急」 */
  function sanitizeCatUrinaryHeuristicReply(text, inquiryHint) {
    if (!text) return text;
    if (
      inquiryHint !== "cat_urinary_heuristic" &&
      inquiryHint !== "cat_urinary_mandatory_probing" &&
      inquiryHint !== "general_mandatory_probing"
    )
      return text;
    let t = stripCatUrinaryLlmFluff(text);
    t = t
      .replace(/【\s*建议分层\s*[：:]\s*紧急\s*】/g, "【建议分层：不明确】")
      .replace(/【\s*建议分层\s*[：:]\s*正常\s*】/g, "【建议分层：不明确】");
    if (inquiryHint === "cat_urinary_heuristic" && !/【\s*建议分层\s*[：:]/.test(t)) {
      t += "\n\n【建议分层：不明确】";
    }
    return t;
  }

  async function fetchLlmReply(message, species, inquiryHint) {
    const ctx = evidenceCtx();
    const Eng = global.CuraCatUroEvidence;
    const Gen = global.CuraGeneralClinicalEvidence;
    const uroEv = Eng && Eng.compute ? Eng.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    const genEv = Gen && Gen.compute ? Gen.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    const payload = {
      message,
      species,
      history: history
        .filter((h) => h.role === "user" || h.role === "assistant")
        .slice(-8)
        .map((h) => ({ role: h.role, content: h.content })),
    };
    const digest = buildAntiRepeatDigest(history);
    if (digest) payload.antiRepeatDigest = digest;
    payload.conversationTriage = computeConversationTriage(history);
    if (inquiryHint) payload.inquiryHint = inquiryHint;
    if (uroEv && uroEv.threadActive) {
      payload.evidenceMeta = {
        clinicalScore: uroEv.clinicalScore,
        allowEmergencyTag: uroEv.allowEmergencyTag,
        immediateDanger: uroEv.immediateDanger,
        strongNegative: uroEv.strongNegative,
      };
    } else if (genEv && genEv.threadActive) {
      payload.evidenceMeta = {
        clinicalScore: genEv.clinicalScore,
        allowEmergencyTag: genEv.allowEmergencyTag,
        immediateDanger: genEv.immediateDanger,
        guideMode: "general",
      };
    }
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
    history.push({ role: "user", content: supplement, ts: safeNow() });
    if (answeredQuizIds.indexOf(quizId) === -1) answeredQuizIds.push(quizId);
    quizSupplementLines.push(supplement);
    persistConversationSnapshot();

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const merged =
      (lastUserPlainInput || "") +
      (quizSupplementLines.length ? "\n" + quizSupplementLines.join("\n") : "");
    const composed = prefix ? prefix + merged : merged;
    const species = getChatSpecies(getSpecies);

    const thinkingEl = showThinkingIndicator();
    setLoading(true);
    void (async () => {
      try {
        const assistantResult = await executeAssistantTurn(composed, species, getKnowledge, opts);
        applyAssistantResultToUi(assistantResult, getKnowledge, getSpecies, opts);
        postHealthSessionSnapshot(getKnowledge, getSpecies);
      } catch (e) {
        appendBubble("bot", "处理补充信息时出错，请再试一次。", "", { severity: "unclear", showDisclaimer: false });
      } finally {
        removeThinkingIndicator(thinkingEl);
        setLoading(false);
      }
    })();
  }

  function onMandatoryOptionClick(btn, getKnowledge, getSpecies, opts) {
    const wrap = btn.closest && btn.closest(".health-mandatory-wrap");
    if (!wrap) return;
    const prompt = wrap.getAttribute("data-mandatory-prompt") || "";
    const label = btn.getAttribute("data-label") || "";
    wrap.querySelectorAll("[data-mandatory-option]").forEach((b) => {
      b.disabled = true;
    });
    appendBubble("user", label, "");
    const supplement = `（补充）${prompt}：${label}`;
    history.push({ role: "user", content: supplement, ts: safeNow() });
    quizSupplementLines.push(supplement);
    persistConversationSnapshot();

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const merged =
      (lastUserPlainInput || "") +
      (quizSupplementLines.length ? "\n" + quizSupplementLines.join("\n") : "");
    const composed = prefix ? prefix + merged : merged;
    const species = getChatSpecies(getSpecies);

    const thinkingEl = showThinkingIndicator();
    setLoading(true);
    void (async () => {
      try {
        const assistantResult = await executeAssistantTurn(composed, species, getKnowledge, opts);
        applyAssistantResultToUi(assistantResult, getKnowledge, getSpecies, opts);
        postHealthSessionSnapshot(getKnowledge, getSpecies);
      } catch (e) {
        appendBubble("bot", "处理选项时出错，请再试一次。", "", { severity: "unclear", showDisclaimer: false });
      } finally {
        removeThinkingIndicator(thinkingEl);
        setLoading(false);
      }
    })();
  }

  function showThinkingIndicator() {
    const { log } = getEls();
    if (!log) return null;
    const div = document.createElement("div");
    div.className = "health-msg health-msg--bot health-msg--thinking";
    div.setAttribute("role", "status");
    div.setAttribute("aria-busy", "true");
    div.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">
      <p class="health-thinking-text" data-thinking-anim="1">CuraBot 正在思考中…</p>
      <p class="muted small health-thinking-sub">请稍候，正在结合你的描述与科普知识整理回复。</p>
    </div>`
    );
    log.appendChild(div);
    const textEl = div.querySelector("[data-thinking-anim='1']");
    if (textEl) {
      const frames = ["CuraBot 正在思考中", "CuraBot 正在思考中.", "CuraBot 正在思考中..", "CuraBot 正在思考中..."];
      let idx = 0;
      const timer = setInterval(() => {
        idx = (idx + 1) % frames.length;
        textEl.textContent = frames[idx];
      }, 420);
      div.__thinkingTimer = timer;
    }
    scrollLogToElement(div);
    return div;
  }

  function removeThinkingIndicator(el) {
    if (el && el.__thinkingTimer) {
      clearInterval(el.__thinkingTimer);
      el.__thinkingTimer = null;
    }
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  /** 与主诉关键词挂钩的语境开场（优先于通用池） */
  const CONTEXTUAL_MANDATORY_OPENERS = [
    {
      test: /湿咳|水声|咳|喘|呼吸|呼噜/,
      lines: ["收到，你提到咳嗽或呼吸相关，我想再确认一点：", "明白了，我们先顺着呼吸道问清楚："],
    },
    {
      test: /黄水|胆汁|吐|呕|反流|毛球/,
      lines: ["收到，你提到呕吐或消化不适，我想再确认一个关键点：", "听你说到肠胃这边，我们补一条就好："],
    },
    {
      test: /尿|砂盆|没尿|排尿|尿频|尿急|尿血|滴尿/,
      lines: ["我明白你很担心排尿这块，先把这点问清楚：", "关于排尿，我想再确认一件最重要的事："],
    },
    {
      test: /拉|泻|腹泻|软便|便血/,
      lines: ["收到，你提到排便异常，我想再确认一点：", "我们先围绕肠道状况问清楚："],
    },
    {
      test: /跛|瘸|疼|痛|扭|摔/,
      lines: ["收到，你提到行动或疼痛，我想再确认一点：", "我们先顺着运动系统问清楚："],
    },
  ];

  const MANDATORY_OPENERS_FALLBACK = [
    "我想再确认一个小细节，会更准：",
    "你愿意说这么多已经很细心了，再帮我补一条就好。",
    "线上只能做参考，多问一句就更安心。",
    "我们不急着下结论，先把关键信息补全一点：",
    "为了后面建议更稳，我想确认一件事：",
    "不吓你，只问关键的一点：",
    "我这边不着急下结论，想先把这点问清楚。",
  ];

  function pickMandatoryOpenerFallback() {
    const n = MANDATORY_OPENERS_FALLBACK.length;
    if (n <= 0) return "";
    let idx = Math.floor(Math.random() * n);
    if (n > 1 && idx === lastMandatoryOpenerIndex) idx = (idx + 1) % n;
    lastMandatoryOpenerIndex = idx;
    return MANDATORY_OPENERS_FALLBACK[idx];
  }

  function pickContextualMandatoryOpener(recentBlob) {
    const t = String(recentBlob || "");
    for (let i = 0; i < CONTEXTUAL_MANDATORY_OPENERS.length; i++) {
      const row = CONTEXTUAL_MANDATORY_OPENERS[i];
      if (row.test.test(t)) {
        const lines = row.lines;
        let idx = Math.floor(Math.random() * lines.length);
        if (lines.length > 1 && idx === lastMandatoryOpenerIndex) idx = (idx + 1) % lines.length;
        lastMandatoryOpenerIndex = idx;
        return lines[idx];
      }
    }
    return pickMandatoryOpenerFallback();
  }

  function pickMandatoryOpener() {
    return pickContextualMandatoryOpener(getRecentUserBlobForOpeners());
  }

  function buildMandatoryGatePayload(next, ev, trackKind) {
    const opener = pickMandatoryOpener();
    let tail = "";
    if (ev && ev.strongNegative) tail = "\n\n听你说 ta 状态还行，我们再把这点对齐一下。";
    const historyText = opener + "\n\n**" + next.text + "**" + tail;
    const options = (next.options || []).map((label, i) => ({
      label,
      value: String.fromCharCode(65 + i),
    }));
    return {
      opener,
      question: next.text,
      options,
      historyText,
      strongNegative: !!(ev && ev.strongNegative),
      promptForContext: next.text.slice(0, 120),
      trackKind: trackKind || null,
    };
  }

  function getMandatoryGatePayload() {
    const ctx = evidenceCtx();
    const Eng = global.CuraCatUroEvidence;
    const Gen = global.CuraGeneralClinicalEvidence;
    const uroEvPre = Eng && Eng.compute ? Eng.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    const forcedUroQ =
      Eng && Eng.getNextMandatoryQuestion && uroEvPre && uroEvPre.threadActive && !uroEvPre.immediateDanger
        ? Eng.getNextMandatoryQuestion(uroEvPre)
        : null;
    if (uroEvPre && uroEvPre.threadActive && !uroEvPre.immediateDanger && uroEvPre.clinicalScore < 5 && forcedUroQ) {
      return buildMandatoryGatePayload(forcedUroQ, uroEvPre, "urinary");
    }
    const genEvPre = Gen && Gen.compute ? Gen.compute(history, chatProfile, quizSupplementLines, ctx) : null;
    const forcedGenQ =
      Gen && Gen.getNextMandatoryQuestion && genEvPre && genEvPre.threadActive && !genEvPre.immediateDanger
        ? Gen.getNextMandatoryQuestion(genEvPre, history)
        : null;
    if (genEvPre && genEvPre.threadActive && !genEvPre.immediateDanger && genEvPre.clinicalScore < 5 && forcedGenQ) {
      return buildMandatoryGatePayload(forcedGenQ, genEvPre, "general");
    }
    return null;
  }

  function appendMandatoryGateBubble(payload) {
    const { log } = getEls();
    if (!log || !payload) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-mandatory-wrap";
    const promptShort = payload.promptForContext || payload.question || "";
    wrap.setAttribute("data-mandatory-prompt", String(promptShort).slice(0, 120));
    const opener = payload.opener ? String(payload.opener).trim() : "";
    const qBlock = formatRich("**" + payload.question + "**");
    const openerPart = opener ? `<span class="health-mandatory-lead">${escapeHtml(opener)}</span> ` : "";
    const btns = (payload.options || [])
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-mandatory-option="1" data-value="${escapeHtml(
            o.value
          )}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    const neg = payload.strongNegative
      ? `<p class="muted small health-mandatory-neg">听你说 ta 状态还行，我们再把这点对齐一下。</p>`
      : "";
    wrap.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">${openerPart}${qBlock}</div>${neg}<div class="health-guided-options health-mandatory-options">${btns}</div>`
    );
    log.appendChild(wrap);
    scrollLogToElement(wrap);
    const digest = optionsDigest(payload.options);
    const summary = [opener, payload.question, digest].filter(Boolean).join("\n");
    persistAssistantPromptLine(summary || payload.question || "");
  }

  function computeAssistantBubbleOpts(result) {
    const ctx = evidenceCtx();
    const uroCap = global.CuraCatUroEvidence && global.CuraCatUroEvidence.compute(history, chatProfile, quizSupplementLines, ctx);
    const genCap =
      global.CuraGeneralClinicalEvidence &&
      global.CuraGeneralClinicalEvidence.compute(history, chatProfile, quizSupplementLines, ctx);
    if (result.mandatoryGateHandled) {
      return {
        displayText: result.replyText,
        bubbleOpts: { severity: undefined, hideTierBadge: true, showDisclaimer: false },
      };
    }
    let displayText = result.replyText;
    let tier = "unclear";
    let bubbleOpts = { severity: tier };
    if (result.fromLlm) {
      const ex = extractTierFromText(result.replyText);
      displayText = ex.clean;
      tier = ex.tier || heuristicTierFromLlmText(displayText);
      if (uroCap && uroCap.threadActive && !uroCap.allowEmergencyTag && tier === "emergency") {
        tier = uroCap.strongNegative ? "moderate" : "unclear";
      }
      const mandatoryProbingUi =
        (uroCap && uroCap.threadActive && !uroCap.immediateDanger && uroCap.clinicalScore < 5) ||
        (genCap && genCap.threadActive && !genCap.immediateDanger && genCap.clinicalScore < 5);
      bubbleOpts = mandatoryProbingUi
        ? { severity: undefined, hideTierBadge: true, showDisclaimer: false }
        : { severity: tier };
    } else if (result.localMeta) {
      tier = result.localMeta.severity || "unclear";
      if (uroCap && uroCap.threadActive && !uroCap.allowEmergencyTag && tier === "emergency") {
        tier = uroCap.strongNegative ? "moderate" : "unclear";
      }
      const mandatoryProbingUiLocal =
        (uroCap && uroCap.threadActive && !uroCap.immediateDanger && uroCap.clinicalScore < 5) ||
        (genCap && genCap.threadActive && !genCap.immediateDanger && genCap.clinicalScore < 5);
      bubbleOpts = mandatoryProbingUiLocal
        ? { severity: undefined, hideTierBadge: true, showDisclaimer: false }
        : { severity: tier };
    }
    return { displayText, bubbleOpts };
  }

  async function executeAssistantTurn(composedForLlm, species, getKnowledge, opts) {
    const gatedPayload = getMandatoryGatePayload();
    if (gatedPayload) {
      return {
        mandatoryGateHandled: true,
        gatedPayload,
        replyText: gatedPayload.historyText,
        fromLlm: false,
        localMeta: null,
        metaHtml: "",
        inquiryHint: null,
      };
    }
    let inquiryHint = inferInquiryHint(composedForLlm, species);
    let replyText = "";
    let fromLlm = false;
    let localMeta = null;
    let metaHtml = "";
    try {
      const fr = await fetchLlmReply(composedForLlm, species, inquiryHint);
      if (fr.llm) {
        replyText = sanitizeCatUrinaryHeuristicReply(fr.llm.text, inquiryHint);
        fromLlm = true;
        metaHtml = "";
      } else {
        try {
          localMeta = CuraHealthBotLocal.reply({
            message: composedForLlm,
            species,
            knowledge: getKnowledge(),
            answeredQuizIds,
            history,
            chatProfile,
            quizSupplementLines,
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
          message: composedForLlm,
          species,
          knowledge: getKnowledge(),
          answeredQuizIds,
          history,
          chatProfile,
          quizSupplementLines,
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
    return {
      mandatoryGateHandled: false,
      gatedPayload: null,
      replyText,
      fromLlm,
      localMeta,
      metaHtml,
      inquiryHint,
    };
  }

  function applyAssistantResultToUi(result, getKnowledge, getSpecies, opts) {
    if (result.mandatoryGateHandled && result.gatedPayload) {
      if (result.gatedPayload.trackKind === "urinary" || result.gatedPayload.trackKind === "general") {
        mandatoryThreadKind = result.gatedPayload.trackKind;
      }
      history.push({ role: "assistant", content: result.gatedPayload.historyText, ts: safeNow() });
      appendMandatoryGateBubble(result.gatedPayload);
      persistConversationSnapshot();
      return;
    }
    mandatoryThreadKind = null;
    const { displayText, bubbleOpts } = computeAssistantBubbleOpts(
      Object.assign({}, result, { mandatoryGateHandled: false })
    );
    history.push({ role: "assistant", content: displayText, ts: safeNow() });
    appendBubble("bot", displayText, result.metaHtml, bubbleOpts);
    persistConversationSnapshot();
    if (!result.fromLlm && result.localMeta && result.localMeta.followUpQuiz) {
      appendFollowUpQuiz(result.localMeta.followUpQuiz);
    }
  }

  async function sendMessage(getSpecies, getKnowledge, opts) {
    const { input } = getEls();
    if (!input) return;
    const raw = input.value.trim();
    const files = pendingChatImages.slice();
    if (!raw && !files.length) return;
    input.value = "";
    pendingChatImages = [];
    renderPendingChatPreviews();

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const prefix = formatProfilePrefix(chatProfile, steps);
    const species = getChatSpecies(getSpecies);

    let composedForLlm = "";
    if (raw) {
      lastUserPlainInput = raw;
      publishSymptomZonesHint(raw);
      composedForLlm = prefix ? prefix + raw : raw;
      const udisplay = files.length ? raw + " · 「附图 " + files.length + " 张」" : raw;
      appendBubble("user", udisplay, "");
      history.push({ role: "user", content: composedForLlm, ts: safeNow() });
      maybeClearUrinaryTrackOnChiefShift(raw);
      persistConversationSnapshot();
    }

    const thinkingEl = raw ? showThinkingIndicator() : null;
    setLoading(true);

    try {
      if (raw) {
        if (tryAdvanceDecisionTreeFromText(raw, getKnowledge, getSpecies, opts)) {
          if (!files.length) postHealthSessionSnapshot(getKnowledge, getSpecies);
          return;
        }
        const assistantResult = await executeAssistantTurn(composedForLlm, species, getKnowledge, opts);
        applyAssistantResultToUi(assistantResult, getKnowledge, getSpecies, opts);

        if (!files.length) {
          postHealthSessionSnapshot(getKnowledge, getSpecies);
        }
      }

      if (files.length) {
        await processChatImageFiles(files, getKnowledge, getSpecies, { skipUserBubble: !!raw });
      }
    } finally {
      removeThinkingIndicator(thinkingEl);
      setLoading(false);
    }
  }

  function refreshChatStatus() {}

  function buildCalmParagraph(isEmergency) {
    if (isEmergency) {
      return "若你已出发或在候诊，可在此补充时间线与细节；**急症仍以尽快到达医院为先**。约 12 小时后会在页面内温和提醒你回访。";
    }
    return "我理解你会担心——把下面当作「就诊前预演」。可把关键时间线、频次与照片（就诊时给兽医看）记在手机备忘录。约 12 小时后会在页面内温和提醒你回访。";
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
    const chiefTags = sessionSnap && sessionSnap.tags && sessionSnap.tags.chief;
    const triageIncomplete =
      chiefTags &&
      (chiefTags.system === "待分诊" || /主诉不明确/.test(String(chiefTags.sign || "")));
    if (triageIncomplete) {
      parts.push(
        "**重要**：你刚才在筛查里选了「说不清」或主诉仍不明确——**在你说清楚具体状况前，我不会给出「正常」或「可以放心」的结论。** 请在下框**自由描述**：最担心什么、何时开始、吃喝拉撒与精神如何、是否越来越重。"
      );
    }
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
    div.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner health-visit-record-inner">
      <p class="health-visit-record-title"><strong>${escapeHtml(title)}</strong></p>
      ${note}
      <pre class="health-visit-record-pre">${escapeHtml(fullText)}</pre>
      <button type="button" class="btn secondary soft health-visit-record-copy" data-copy-visit-record="1">复制全文</button>
    </div><p class="health-msg-disclaimer" role="note">${escapeHtml(BOT_DISCLAIMER_LINE)}</p>`
    );
    log.appendChild(div);
    scrollLogToElement(div);
  }

  function formatHistoryForExport(items) {
    const lines = [];
    (items || []).forEach((h) => {
      const c = String(h.content || "").trim();
      if (!c) return;
      const label = h.role === "user" ? "【家长/用户】" : "【CuraBot】";
      lines.push(label + c);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  function handleGenerateSoapReport(getKnowledge) {
    const Eng = global.CuraHealthDecisionEngine;
    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    const species = getChatSpecies(global.__healthGetSpecies || (() => chatProfile.species));
    const label = species === "dog" ? "狗狗" : "猫猫";
    const parts = [];
    parts.push(`【${label}就诊简报】（科普整理，非诊断、不开药）`);
    parts.push("");
    parts.push("一、基本信息");
    const profileLines = [];
    steps.forEach((s) => {
      const v = chatProfile[s.id];
      if (v == null || v === "") return;
      const opt = (s.options || []).find((o) => o.value === v);
      const lab = opt ? opt.label : v;
      let q = String(s.prompt || "").replace(/？$/, "");
      if (s.id === "gender") q = species === "dog" ? "狗狗性别" : "猫猫性别";
      profileLines.push(`- ${q}：${lab}`);
    });
    parts.push(profileLines.length ? profileLines.join("\n") : "- （未填档案项，以对话为准）");
    parts.push("");
    parts.push(`二、身体状况与主诉`);
    const userLines = history
      .filter((h) => h.role === "user")
      .slice(-8)
      .map((h) => String(h.content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim())
      .filter(Boolean);
    if (userLines.length) {
      userLines.forEach((t) => parts.push(`- ${t}`));
    } else {
      parts.push("- （暂无文字描述）");
    }
    if (decisionSession && decisionSession.tags && decisionSession.tags.chief) {
      const ch = decisionSession.tags.chief;
      if (ch.system || ch.sign) {
        parts.push(`- 筛查标签：${[ch.system, ch.sign].filter(Boolean).join(" · ")}`);
      }
    }
    parts.push("");
    parts.push("三、可能原因与建议（非诊断）");
    if (decisionSession && Eng && Eng.buildAdvicePlan) {
      const raw = Eng.buildAdvicePlan(decisionSession, knowledge);
      const keep = raw
        .split("\n")
        .filter((line) => {
          const l = line.trim();
          if (!l) return false;
          if (/^\*\*[1-2]\./.test(l)) return true;
          if (l.startsWith("- ") && /就医|急诊|红旗|不宜|观察|联系|医院|准备/.test(l)) return true;
          return false;
        })
        .slice(0, 14);
      parts.push(keep.length ? keep.join("\n") : raw.slice(0, 900));
    } else {
      parts.push("- 本次主要为自由对话；具体原因需兽医体格检查与化验后确定。");
    }
    parts.push("");
    parts.push("四、对话摘录");
    parts.push(formatHistoryForExport(history.slice(-16)) || "（无）");
    parts.push("");
    parts.push("—— 导出结束 ——");

    const text = parts.join("\n");
    copyTextToClipboard(text).then(
      () => appendVisitRecordBubble(text, true, `${label}就诊简报`),
      () => appendVisitRecordBubble(text, false, `${label}就诊简报`)
    );
  }

  /** 健康咨询页标题/副标题与所选物种一致 */
  function updateHealthChatChrome(getSpecies) {
    const hero = document.querySelector('[data-view="healthChat"] .health-chat-hero');
    if (!hero) return;
    const rest = hero.querySelector(".curabot-title-rest");
    if (rest) rest.textContent = "聊聊毛孩子的健康";
    const lead = hero.querySelector(".health-chat-lead");
    if (lead) {
      lead.textContent = "CuraBot 会结合毛孩子的具体情况，用温和的方式给你可参考的建议（科普，不能代替兽医当面诊断）。";
    }
  }

  function appendFreeChatWelcome(knowledge, getSpecies) {
    const { log } = getEls();
    if (!log) return null;
    updateHealthChatChrome(getSpecies);
    const hc = (knowledge && knowledge.healthChat) || {};
    const base =
      hc.freeWelcomeText ||
      "你好，我是 CuraBot。**你可以直接在下框打字**，描述食欲、精神、呕吐、大小便等你最担心的情况（科普参考，不能代替兽医诊断）。\n\n先和我说一下你在咨询猫猫还是狗狗，我会按对应方向继续追问。";
    let dietHint = "";
    try {
      if (
        localStorage.getItem("curabot_quiz_weak_diet") === "1" &&
        !sessionStorage.getItem("curabot_quiz_diet_hint_shown")
      ) {
        sessionStorage.setItem("curabot_quiz_diet_hint_shown", "1");
        dietHint =
          "\n\n（小提示：你在首页「趣味闯关」里饮食相关题目若曾选错，我们可以多聊聊喂食与安全食物——仍属科普参考。）";
      }
    } catch (e) {
      /* ignore */
    }
    const text = `**欢迎来到健康咨询。**\n\n${base}${dietHint}`;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-welcome-free";
    wrap.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">${formatRich(text)}</div><div class="health-guided-options"><button type="button" class="btn secondary soft" data-start-guided-intake="1">可选：填写档案与症状筛查</button></div>`
    );
    log.appendChild(wrap);
    const digest = "选项：可选：填写档案与症状筛查";
    persistAssistantPromptLine([text.replace(/\s+/g, " ").trim(), digest].join("\n"));
    scrollLogToElement(wrap);
    return wrap;
  }

  function startOptionalGuidedIntake(getKnowledge, getSpecies, opts) {
    if (treePhaseActive) return;
    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);
    guidedComplete = false;
    guidedStepIndex = 0;
    while (guidedStepIndex < steps.length) {
      const sid = steps[guidedStepIndex].id;
      const v = chatProfile[sid];
      if (v == null || v === "") break;
      guidedStepIndex += 1;
    }
    if (guidedStepIndex >= steps.length) {
      startDecisionTreeIfNeeded(getKnowledge, getSpecies, opts);
      return;
    }
    updateChatInputState();
    advanceGuided(getKnowledge, getSpecies, opts);
  }

  function finalizeGuidedOpenInput(knowledge, getKnowledge, getSpecies) {
    const body = composeGuidedCompletionBody(knowledge, decisionSession, {});
    const sev = severityForGuidedCompletion(decisionSession, {});
    appendBubble("bot", body, "", { severity: sev });
    completeTreeTransition(knowledge, getKnowledge, getSpecies);
  }

  /** 决策树题图相关性兜底：避免误配图造成“题图不对应” */
  function isDecisionIllustrationRelevant(node) {
    if (!node || !node.illustration || !node.illustration.src) return false;
    const ill = node.illustration;
    const blob = [node.prompt, ill.alt, ill.caption, ill.topic, ill.src, node.mediaHint].filter(Boolean).join(" ");
    const topicHint = String(ill.topic || "").trim().toLowerCase();
    const text = String(blob || "").toLowerCase();

    const stoolLike = /(便|黑便|血便|粪|腹泻|拉稀|stool|feces|melena|diarrhea)/i.test(blob);
    const bcsLike = /(体况|bcs|肥胖|偏瘦|理想体重|body condition)/i.test(blob);

    if (topicHint === "stool") return stoolLike;
    if (topicHint === "bcs") return bcsLike;
    if (stoolLike && bcsLike) return false;
    return true;
  }

  function normalizeDecisionImageSrc(src) {
    const s = String(src || "").trim();
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf("/") === 0) return s;
    return "/" + s.replace(/^\.?\//, "");
  }

  function buildDecisionMediaBlock(node) {
    const mediaText = String((node && node.mediaHint) || "").trim();
    const hasIll = !!(node && node.illustration && node.illustration.src && isDecisionIllustrationRelevant(node));
    if (!hasIll) {
      return mediaText ? `<p class="health-decision-media muted small-intro">${escapeHtml(mediaText)}</p>` : "";
    }
    const src = normalizeDecisionImageSrc(node.illustration.src);
    const alt = String(node.illustration.alt || "").trim();
    const capRaw = String(node.illustration.caption || "").trim();
    const cap = capRaw && capRaw !== mediaText ? capRaw : "";
    const mediaLead = mediaText ? `<p class="health-decision-media muted small-intro">${escapeHtml(mediaText)}</p>` : "";
    return `${mediaLead}<figure class="health-decision-illustration"><img class="health-decision-illustration-img" src="${escapeHtml(
      src
    )}" alt="${escapeHtml(alt)}" loading="lazy" onerror="this.closest('figure').style.display='none'"/>${
      cap ? `<figcaption class="muted small health-decision-illustration-cap">${escapeHtml(cap)}</figcaption>` : ""
    }</figure>`;
  }

  function appendDecisionTreeNode(node) {
    const Eng = global.CuraHealthDecisionEngine;
    if (!node || !Eng) return;
    const { log } = getEls();
    if (!log) return;
    const wrap = document.createElement("div");
    wrap.className = "health-msg health-msg--bot health-decision-tree-wrap";
    wrap.setAttribute("data-node-id", node.id || "");
    const supportLead = node.supportMessage
      ? `<span class="health-decision-lead">${escapeHtml(node.supportMessage)}</span> `
      : "";
    const media = buildDecisionMediaBlock(node);
    const btns = (node.options || [])
      .map(
        (o) =>
          `<button type="button" class="btn secondary soft" data-decision-tree-option="1" data-value="${escapeHtml(
            o.value
          )}" data-label="${escapeHtml(o.label)}">${escapeHtml(o.label)}</button>`
      )
      .join("");
    wrap.innerHTML = wrapHealthMsgRow(
      "bot",
      `<div class="health-msg-inner">${supportLead}${formatRich(node.prompt)}${media}<div class="health-guided-options">${btns}</div></div>`
    );
    log.appendChild(wrap);
    scrollLogToElement(wrap);
    const digest = optionsDigest(node.options);
    const summary = [node.supportMessage || "", node.prompt || "", digest].filter(Boolean).join("\n");
    persistAssistantPromptLine(summary || node.prompt || "");
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

  /** 近期用户发言摘要，供大模型避免重复追问同类信息 */
  function buildAntiRepeatDigest(hist) {
    const h = hist || history;
    const us = h.filter((x) => x.role === "user").slice(-8);
    const lines = [];
    for (let i = 0; i < us.length; i++) {
      let c = String(us[i].content || "").replace(/^【用户已选档案】[\s\S]*?\n\n/, "").trim();
      if (!c) continue;
      if (c.length > 220) c = c.slice(0, 217) + "…";
      lines.push(c);
    }
    const blob = lines.join("\n");
    const dims = extractStatedDimensionsFromBlob(blob);
    if (dims.length) {
      lines.push("【用户侧已覆盖维度（勿就同一维度换句式重问）】" + dims.join("；"));
    }
    const lastAsst = h.filter((x) => x.role === "assistant").slice(-1)[0];
    if (lastAsst) {
      const ac = String(lastAsst.content || "").trim();
      const firstLine = ac.split(/\n/)[0].slice(0, 160);
      if (firstLine) lines.push("【上一轮助手首句预览（勿重复同一开场）】" + firstLine);
    }
    return lines.join("\n---\n").slice(0, 2000);
  }

  function applyDecisionTreeResult(result, getKnowledge, getSpecies, opts) {
    const Eng = global.CuraHealthDecisionEngine;
    if (!Eng) return;
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
      persistConversationSnapshot();
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
      persistConversationSnapshot();
      completeTreeTransition(knowledge, getKnowledge, getSpecies);
      return;
    }
    if (result.kind === "continue" && result.node) {
      appendDecisionTreeNode(result.node);
    }
  }

  /** 自由输入是否已覆盖当前决策树节点选项（与点按钮等价） */
  function tryAdvanceDecisionTreeFromText(raw, getKnowledge, getSpecies, opts) {
    if (!treePhaseActive || !decisionSession) return false;
    const Eng = global.CuraHealthDecisionEngine;
    if (!Eng || !Eng.matchOptionFromUserText) return false;
    const node = Eng.getCurrentNode(decisionSession);
    if (!node) return false;
    const opt = Eng.matchOptionFromUserText(node, raw);
    if (!opt) return false;
    const { log } = getEls();
    if (log) {
      const wraps = log.querySelectorAll(".health-decision-tree-wrap");
      const lastWrap = wraps[wraps.length - 1];
      if (lastWrap) {
        lastWrap.querySelectorAll("[data-decision-tree-option]").forEach((b) => {
          b.disabled = true;
        });
      }
    }
    const result = Eng.applyOption(decisionSession, opt);
    applyDecisionTreeResult(result, getKnowledge, getSpecies, opts);
    return true;
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
    history.push({ role: "user", content: label, ts: safeNow() });
    persistConversationSnapshot();
    const result = Eng.applyOption(decisionSession, opt);
    applyDecisionTreeResult(result, getKnowledge, getSpecies, opts);
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
    history.push({ role: "user", content: label, ts: safeNow() });
    persistConversationSnapshot();

    guidedStepIndex += 1;
    advanceGuided(getKnowledge, getSpecies, opts);
  }

  function resetConversation(getKnowledge, getSpecies, presetProfile, options) {
    const opts = options || {};
    history.length = 0;
    chatProfile = presetProfile && typeof presetProfile === "object" ? { ...presetProfile } : {};
    const entrySp = getSpecies && getSpecies();
    if (entrySp === "cat" || entrySp === "dog") {
      chatProfile.species = entrySp;
    }
    guidedStepIndex = 0;
    guidedComplete = true;
    lastUserPlainInput = "";
    lastMandatoryOpenerIndex = -1;
    quizSupplementLines = [];
    answeredQuizIds = [];
    mandatoryThreadKind = null;
    decisionSession = null;
    treePhaseActive = false;
    persistedHealthSessionId = null;
    pendingChatImages = [];
    renderPendingChatPreviews();
    syncProfileToWindow();
    syncDecisionSessionWindow();
    setEmergencyBannerVisible(false, "");

    const knowledge = getKnowledge();
    const steps = getGuidedSteps(knowledge);

    const { log } = getEls();
    if (log) log.innerHTML = "";

    const store = safeReadChatStore();
    let targetSession = null;
    if (opts.forceNew) {
      targetSession = newBlankSessionRecord(chatProfile);
      store.sessions.unshift(targetSession);
      store.currentSessionId = targetSession.id;
      safeWriteChatStore(store);
    } else {
      targetSession = ensureCurrentSession(store, chatProfile);
      store.currentSessionId = targetSession.id;
      safeWriteChatStore(store);
    }
    currentSessionId = targetSession.id;

    if (targetSession.chatProfile && typeof targetSession.chatProfile === "object") {
      chatProfile = Object.assign({}, chatProfile, targetSession.chatProfile);
    }
    if (targetSession.lastUserPlainInput) lastUserPlainInput = String(targetSession.lastUserPlainInput);
    syncProfileToWindow();

    const kept = pruneByDays(targetSession.history || [], safeNow());
    if (kept.length) {
      decisionSession = cloneJsonSafe(targetSession.decisionSession);
      treePhaseActive = !!targetSession.treePhaseActive;
      guidedStepIndex = Number(targetSession.guidedStepIndex) || 0;
      guidedComplete = targetSession.guidedComplete !== false;
      quizSupplementLines = Array.isArray(targetSession.quizSupplementLines) ? targetSession.quizSupplementLines.slice() : [];
      answeredQuizIds = Array.isArray(targetSession.answeredQuizIds) ? targetSession.answeredQuizIds.slice() : [];
      mandatoryThreadKind = targetSession.mandatoryThreadKind || null;
      syncDecisionSessionWindow();
    } else {
      guidedStepIndex = 0;
      guidedComplete = true;
      while (guidedStepIndex < steps.length) {
        const sid = steps[guidedStepIndex].id;
        const v = chatProfile[sid];
        if (v == null || v === "") break;
        guidedStepIndex += 1;
      }
    }

    let restored = false;
    if (kept.length) {
      kept.forEach((h) => {
        const role = h.role === "assistant" ? "assistant" : "user";
        const content = String(h.content || "").trim();
        if (!content && !(h.html && String(h.html).trim())) return;
        history.push({
          role,
          content: content || "（历史消息）",
          ts: Number(h.ts) || safeNow(),
        });
        if (h.html && String(h.html).trim() && log) {
          log.insertAdjacentHTML("beforeend", stripScriptsFromHtml(h.html));
        } else if (log) {
          appendBubble(role === "assistant" ? "bot" : "user", content || "（历史消息）", "", {
            severity: role === "assistant" ? "unclear" : undefined,
            hideTierBadge: role === "assistant",
            showDisclaimer: role === "assistant" ? false : undefined,
          });
        }
      });
      if (log) restoreInteractiveStateForHistory(log);
      restored = true;
    }

    updateChatInputState();
    if (!restored) appendFreeChatWelcome(knowledge, getSpecies);
    persistConversationSnapshot();
    renderSessionListUi();
    refreshChatStatus();
  }

  function openView(getKnowledge, getSpecies, opts, presetProfile) {
    global.__healthChatOpts = opts || {};
    clearExpiredStoresBestEffort();
    resetConversation(getKnowledge, getSpecies, presetProfile, { forceNew: false });
  }

  function sendQuickMessage(getSpecies, getKnowledge, opts, text) {
    const { input } = getEls();
    if (!input) return;
    const t = String(text || "").trim();
    if (!t) return;
    input.value = t;
    sendMessage(getSpecies, getKnowledge, opts);
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
    global.__healthGetSpecies = getSpecies;

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
        const startG = e.target && e.target.closest && e.target.closest("[data-start-guided-intake]");
        if (startG) {
          e.preventDefault();
          startOptionalGuidedIntake(getKnowledge, getSpecies, opts);
          return;
        }
        const gBtn = e.target && e.target.closest && e.target.closest("[data-guided-option]");
        if (gBtn && !guidedComplete && !treePhaseActive) {
          e.preventDefault();
          onGuidedOptionClick(gBtn, getKnowledge, getSpecies, opts);
          return;
        }
        const mBtn = e.target && e.target.closest && e.target.closest("[data-mandatory-option]");
        if (mBtn) {
          e.preventDefault();
          onMandatoryOptionClick(mBtn, getKnowledge, getSpecies, opts);
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

    const sessionHost = document.getElementById("healthSessionList");
    if (sessionHost && !sessionHost.dataset.bound) {
      sessionHost.dataset.bound = "1";
      sessionHost.addEventListener("pointerdown", (e) => {
        const actionBtn =
          e.target && e.target.closest && e.target.closest("[data-session-rename], [data-session-delete]");
        if (actionBtn) {
          e.stopPropagation();
        }
      });
      sessionHost.addEventListener("click", (e) => {
        const actionWrap = e.target && e.target.closest && e.target.closest(".health-session-actions");
        if (actionWrap) {
          e.stopPropagation();
        }
        const renameBtn = e.target && e.target.closest && e.target.closest("[data-session-rename]");
        if (renameBtn) {
          e.preventDefault();
          const sid = renameBtn.getAttribute("data-session-rename");
          if (sid) renameSessionById(sid);
          return;
        }
        const delBtn = e.target && e.target.closest && e.target.closest("[data-session-delete]");
        if (delBtn) {
          e.preventDefault();
          const sid = delBtn.getAttribute("data-session-delete");
          if (sid) deleteSessionById(sid, getKnowledge, getSpecies);
          return;
        }
        const openBtn = e.target && e.target.closest && e.target.closest("[data-session-open]");
        if (openBtn) {
          e.preventDefault();
          const sid = openBtn.getAttribute("data-session-open");
          if (sid) switchSessionById(sid, getKnowledge, getSpecies, undefined);
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
    const btnNewSession = document.getElementById("btnHealthNewSession");
    if (btnNewSession && !btnNewSession.dataset.bound) {
      btnNewSession.dataset.bound = "1";
      btnNewSession.addEventListener("click", () => {
        resetConversation(getKnowledge, getSpecies, undefined, { forceNew: true });
      });
    }
    const chatInput = document.getElementById("healthChatInput");

    global.CuraHealthChat = {
      open: (presetProfile) => openView(getKnowledge, getSpecies, opts, presetProfile),
      reset: () => resetConversation(getKnowledge, getSpecies, undefined, { forceNew: true }),
      sendQuickMessage: (text) => sendQuickMessage(getSpecies, getKnowledge, opts, text),
      syncSpecies: function () {
        /* 与首页物种解耦，不再同步 */
      },
    };
  }

  global.CuraHealthChatInit = init;
})(typeof window !== "undefined" ? window : globalThis);
