(function () {
  const state = {
    knowledge: null,
    species: "cat",
    view: "home",
    flowKey: null,
    stepId: null,
    lastOutcome: null,
    intakeFlags: null,
    /** @type {string[]} 分诊流程内已走过的步骤 id，用于「上一步」 */
    flowStepHistory: [],
    /** 进入结果页前的一步，用于从结果返回题目 */
    outcomeReturnStepId: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function isLocalDevHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  }

  /**
   * 用 GET /api/capabilities（含 apiChat）判断同源是否为本仓库完整后端。
   * 旧进程可能仍有 /api/meta 但没有 /api/chat——不能仅凭 meta 判定。
   * 静态页 / 其它端口：把对话指向 apiDevFallback（默认 127.0.0.1:3000）。
   * 若在 3000 仍无对话接口：置 CURABOT_API_CHAT_MISSING，由健康机器人提示重启 Node。
   */
  async function detectApiBase(meta) {
    if (typeof window === "undefined") return;
    if (window.CURABOT_API_BASE != null && String(window.CURABOT_API_BASE).trim() !== "") return;

    const rawFb = meta && meta.apiDevFallback;
    let fallback = "http://127.0.0.1:3000";
    if (rawFb === "") return;
    if (rawFb != null && String(rawFb).trim() !== "") {
      fallback = String(rawFb).trim().replace(/\/$/, "");
    }

    const loc = window.location;
    if (loc.protocol === "file:") {
      window.CURABOT_API_BASE = fallback;
      window.CURABOT_API_CHAT_MISSING = false;
      return;
    }

    if (!isLocalDevHost(loc.hostname)) return;

    const port = loc.port || "";

    async function sameOriginHasChatCapabilities() {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const r = await fetch(new URL("/api/capabilities", loc.origin).href, {
          cache: "no-store",
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) return false;
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("application/json")) return false;
        const j = await r.json();
        return j && j.name === "CuraBot" && j.apiChat === true;
      } catch (e) {
        return false;
      }
    }

    if (await sameOriginHasChatCapabilities()) {
      window.CURABOT_API_CHAT_MISSING = false;
      return;
    }

    const on3000OrDefaultPort = port === "3000" || port === "";
    if (!on3000OrDefaultPort) {
      window.CURABOT_API_BASE = fallback;
      window.CURABOT_API_CHAT_MISSING = false;
    } else {
      window.CURABOT_API_CHAT_MISSING = true;
    }
  }

  async function loadKnowledge() {
    const [k, intake] = await Promise.all([
      fetch("/data/knowledge.json", { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("无法加载内容");
        return r.json();
      }),
      fetch("/data/intake-flows.json", { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("无法加载采集清单");
        return r.json();
      }),
    ]);
    state.knowledge = k;
    Object.assign(k.triageFlows || {}, intake.triageFlows || {});
    const apiBase = k.meta && k.meta.apiBase;
    if (apiBase != null && String(apiBase).trim() !== "") {
      window.CURABOT_API_BASE = String(apiBase).trim().replace(/\/$/, "");
    }
    await detectApiBase(k.meta || {});
  }

  function speciesLabel(sp) {
    return sp === "dog" ? "狗狗" : "猫咪";
  }

  function applyHeroImages() {
    const k = state.knowledge;
    if (!k || !k.uiImages) return;
    const cat = $("#heroCatImg");
    const dog = $("#heroDogImg");
    const banner = $("#warmBanner");
    if (cat && k.uiImages.heroCat) {
      cat.src = k.uiImages.heroCat;
      cat.alt = "猫咪照片";
    }
    if (dog && k.uiImages.heroDog) {
      dog.src = k.uiImages.heroDog;
      dog.alt = "狗狗照片";
    }
    if (banner) {
      if (k.uiImages.bannerSoft) {
        banner.classList.add("warm-banner--single");
        banner.style.backgroundImage = `url(${k.uiImages.bannerSoft})`;
      } else {
        banner.classList.remove("warm-banner--single");
        banner.style.backgroundImage = "";
      }
    }
  }

  function renderRefs(refIds) {
    if (!refIds || !refIds.length || !state.knowledge) return "";
    const refs = state.knowledge.references || [];
    const map = Object.fromEntries(refs.map((r) => [r.id, r]));
    const items = refIds
      .map((id) => map[id])
      .filter(Boolean)
      .map(
        (r) =>
          `<li><span class="ref-title">${escapeHtml(r.title)}</span><span class="muted"> · ${escapeHtml(
            r.category || ""
          )}</span></li>`
      );
    if (!items.length) return "";
    return `<details class="refs-fold"><summary>给爱学习的家长：资料参考</summary><ul>${items.join("")}</ul></details>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 转义后支持 **粗体** 与换行，用于结论正文与建议 */
  function formatRichText(s) {
    if (s == null || s === "") return "";
    return escapeHtml(String(s))
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");
  }

  /** 与分诊 level 对应的四色状态：紧急 / 中等 / 低等 / 不明确 */
  function severityUi(level) {
    const map = {
      emergency: { mod: "emergency", label: "紧急" },
      urgent: { mod: "moderate", label: "中等" },
      monitor: { mod: "low", label: "低等" },
      routine: { mod: "unclear", label: "不明确" },
    };
    return map[level] || { mod: "unclear", label: "不明确" };
  }

  function updateSpeciesLabels() {
    $$(".js-species-label").forEach((el) => {
      el.textContent = speciesLabel(state.species);
    });
  }

  function topicMatchesSpecies(topic, species) {
    if (!topic.species || topic.species.length === 0) return true;
    return topic.species.indexOf(species) !== -1;
  }

  function clusterMatchesSpecies(cluster, species) {
    if (!cluster.species || cluster.species.length === 0) return true;
    return cluster.species.indexOf(species) !== -1;
  }

  function findDailyTopic(topicId) {
    const dk = state.knowledge && state.knowledge.dailyKnowledge;
    if (!dk || !dk.modules) return null;
    for (let i = 0; i < dk.modules.length; i++) {
      const m = dk.modules[i];
      const t = (m.topics || []).find((x) => x.id === topicId);
      if (t) return { module: m, topic: t };
    }
    return null;
  }

  /** 日常知识条目：关联知识图谱中的簇（按当前物种过滤） */
  function renderGraphClustersForDailyTopic(clusterIds) {
    if (!clusterIds || !clusterIds.length) return "";
    const kg = state.knowledge && state.knowledge.knowledgeGraph;
    if (!kg || !kg.clusters) return "";
    const map = Object.fromEntries(kg.clusters.map((c) => [c.id, c]));
    const parts = clusterIds
      .map((id) => map[id])
      .filter(Boolean)
      .filter((c) => clusterMatchesSpecies(c, state.species));
    if (!parts.length) {
      return `<p class="muted">当前物种下暂无匹配的图谱节点，仍以参考文献与兽医意见为准。</p>`;
    }
    const cards = parts
      .map((c) => {
        const hints = (c.hints || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
        const apps = (c.appHints || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
        const refs = renderRefs(c.refIds || []);
        return `<article class="card warm daily-graph-card">
          <h4 class="daily-graph-card-title">${escapeHtml(c.label)}</h4>
          <p class="signs-label">线索（非诊断）</p>
          <ul class="kg-list">${hints}</ul>
          <p class="signs-label">与站内流程的对应</p>
          <ul class="kg-list">${apps}</ul>
          ${refs}
        </article>`;
      })
      .join("");
    return `<section class="daily-graph-section" aria-labelledby="daily-graph-h">
        <h3 id="daily-graph-h" class="outcome-section-title">关联知识图谱</h3>
        <div class="region-grid daily-graph-grid">${cards}</div>
      </section>`;
  }

  function renderDailyTopicPage(topicId) {
    const found = findDailyTopic(topicId);
    const host = $("#dailyTopicContent");
    if (!host) return;
    if (!found) {
      host.innerHTML = `<p class="error">未找到该条目。</p>`;
      return;
    }
    const { module, topic } = found;
    if (!topicMatchesSpecies(topic, state.species)) {
      host.innerHTML = `<p class="error">当前物种下暂无此条目，请在首页切换猫/狗。</p>`;
      return;
    }
    const adviceList = (topic.advice || []).map((a) => `<li>${escapeHtml(a)}</li>`).join("");
    const graphHtml = renderGraphClustersForDailyTopic(topic.graphClusterIds || []);
    const refsHtml = renderRefs(topic.refIds || []);
    host.innerHTML = `
      <header class="flow-head daily-topic-head">
        <p class="badge">${escapeHtml(module.title)} · ${speciesLabel(state.species)}</p>
        <h2 class="daily-topic-h2">${escapeHtml(topic.title)}</h2>
      </header>
      <section class="daily-science" aria-labelledby="daily-science-h">
        <h3 id="daily-science-h" class="outcome-section-title">科学知识</h3>
        <div class="daily-prose">${formatRichText(topic.science || "")}</div>
      </section>
      <section class="daily-advice" aria-labelledby="daily-advice-h">
        <h3 id="daily-advice-h" class="outcome-section-title">家庭建议</h3>
        <ul class="daily-advice-list">${adviceList}</ul>
      </section>
      <section class="daily-vet" aria-labelledby="daily-vet-h">
        <h3 id="daily-vet-h" class="outcome-section-title">何时需要看兽医</h3>
        <div class="daily-prose">${formatRichText(topic.vetWhen || "")}</div>
      </section>
      ${graphHtml}
      <section class="daily-refs" aria-labelledby="daily-refs-h">
        <h3 id="daily-refs-h" class="outcome-section-title">参考资料</h3>
        ${refsHtml || `<p class="muted">（无）</p>`}
      </section>
      <p class="muted daily-topic-footnote">科普参考，不能代替执业兽医诊断与治疗。</p>
    `;
  }

  function updateDailyRefLinksVisibility() {
    const cat = $("#homeDailyRefLinksCat");
    const dog = $("#homeDailyRefLinksDog");
    if (!cat || !dog) return;
    const isCat = state.species === "cat";
    cat.hidden = !isCat;
    dog.hidden = !isCat;
  }

  function renderDailyKnowledgeHome() {
    const host = $("#homeDailyKnowledge");
    const dk = state.knowledge && state.knowledge.dailyKnowledge;
    if (!host || !dk || !dk.modules) return;
    const mods = dk.modules
      .map((mod) => {
        const topics = (mod.topics || []).filter((t) => topicMatchesSpecies(t, state.species));
        if (!topics.length) return "";
        const topicRows = topics
          .map(
            (t) => `
        <button type="button" class="home-merge-row daily-topic-row" data-daily-topic="${escapeHtml(
          t.id
        )}" aria-label="${escapeHtml("查看：" + t.title)}">
          <span class="home-merge-row-text daily-topic-title-only"><strong>${escapeHtml(t.title)}</strong></span>
        </button>`
          )
          .join("");
        return `<section class="daily-mod" data-daily-module="${escapeHtml(mod.id)}">
        <h3 class="daily-mod-title">${escapeHtml(mod.title)}</h3>
        <div class="daily-topic-list">${topicRows}</div>
      </section>`;
      })
      .filter(Boolean)
      .join("");
    host.innerHTML = mods;
    $$("[data-daily-topic]", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-daily-topic");
        renderDailyTopicPage(id);
        showView("dailyTopic");
      });
    });
  }

  function updateHomeMergedPanels() {
    renderDailyKnowledgeHome();
    updateDailyRefLinksVisibility();
  }

  function updateSpeciesCards() {
    $$(".species-card").forEach((card) => {
      const sp = card.getAttribute("data-species");
      card.classList.toggle("is-selected", sp === state.species);
      card.setAttribute("aria-pressed", sp === state.species ? "true" : "false");
    });
    updateTriageIntakeVisibility();
    updateHomeMergedPanels();
    if (typeof CuraHealthChat !== "undefined" && CuraHealthChat && CuraHealthChat.syncSpecies) {
      CuraHealthChat.syncSpecies();
    }
  }

  /** 分诊页「标准化采集」只展示当前首页所选物种对应的入口 */
  function updateTriageIntakeVisibility() {
    const catBtn = $("#startCatIntake");
    const dogBtn = $("#startDogIntake");
    if (!catBtn || !dogBtn) return;
    catBtn.hidden = state.species !== "cat";
    dogBtn.hidden = state.species !== "dog";
  }

  function showView(name) {
    state.view = name;
    $$("[data-view]").forEach((el) => {
      el.hidden = el.getAttribute("data-view") !== name;
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderHome() {
    state.flowKey = null;
    state.stepId = null;
    state.lastOutcome = null;
    state.flowStepHistory = [];
    state.outcomeReturnStepId = null;
    state.intakeFlags = null;
    updateSpeciesLabels();
    updateSpeciesCards();
    showView("home");
  }

  function goBackInFlow() {
    if (state.lastOutcome) {
      state.lastOutcome = null;
      if (state.outcomeReturnStepId != null) {
        state.stepId = state.outcomeReturnStepId;
        state.outcomeReturnStepId = null;
        renderStep();
      } else {
        state.flowKey = null;
        state.stepId = null;
        state.intakeFlags = null;
        showView("triageMenu");
      }
      return;
    }
    if (state.flowStepHistory.length > 0) {
      state.stepId = state.flowStepHistory.pop();
      renderStep();
    } else {
      state.flowKey = null;
      state.stepId = null;
      state.intakeFlags = null;
      showView("triageMenu");
    }
  }

  function wireFlowBack(host) {
    const btn = $("#btnFlowBack", host);
    if (btn) btn.addEventListener("click", () => goBackInFlow());
  }

  function startFlow(key) {
    const flow = state.knowledge.triageFlows[key];
    if (!flow) return;
    if (flow.flowType === "accumulate") {
      if (key === "catIntake" && state.species !== "cat") {
        alert("该清单专为猫咪设计，请先在首页选择「猫咪」。");
        return;
      }
      if (key === "dogIntake" && state.species !== "dog") {
        alert("该清单专为狗狗设计，请先在首页选择「狗狗」。");
        return;
      }
      state.intakeFlags = new Set();
    } else {
      state.intakeFlags = null;
    }
    state.flowKey = key;
    state.stepId = flow.start;
    state.lastOutcome = null;
    state.flowStepHistory = [];
    state.outcomeReturnStepId = null;
    renderStep();
    showView("flow");
  }

  function renderOutcome() {
    const o = state.lastOutcome;
    const host = $("#flowContent");
    const levelClass = `level-${o.level}`;
    const sev = severityUi(o.level);
    const diagnosticMod = `outcome-diagnostic--${sev.mod}`;
    const suggestSource = o.oneLiner || o.vetNeed || "";
    const vetBlock = suggestSource
      ? `<div class="outcome-suggestion" role="status">
          <span class="outcome-suggestion-icon" aria-hidden="true">🏥</span>
          <div class="outcome-suggestion-text">${formatRichText(suggestSource)}</div>
        </div>`
      : "";
    const hasStruct =
      o.detailExplain != null && String(o.detailExplain).trim() !== "";
    const detailSection = hasStruct
      ? `<section class="outcome-section" aria-labelledby="outcome-detail-h">
          <h3 id="outcome-detail-h" class="outcome-section-title">Ta 大概啥情况</h3>
          <div class="outcome-section-body">${formatRichText(o.detailExplain)}</div>
        </section>`
      : "";
    const homeSection =
      hasStruct && o.homeCare != null && String(o.homeCare).trim() !== ""
        ? `<section class="outcome-section outcome-section--home" aria-labelledby="outcome-home-h">
          <h3 id="outcome-home-h" class="outcome-section-title">在家你可以先这样做</h3>
          <div class="outcome-section-body">${formatRichText(o.homeCare)}</div>
        </section>`
        : "";
    const summarySection =
      o.intakeSummary != null && String(o.intakeSummary).trim() !== ""
        ? `<section class="outcome-section outcome-section--summary" aria-labelledby="outcome-sum-h">
          <h3 id="outcome-sum-h" class="outcome-section-title">已结构化记录要点</h3>
          <div class="outcome-section-body outcome-section-body--mono">${formatRichText(o.intakeSummary)}</div>
        </section>`
        : "";
    const legacyBody =
      !hasStruct && o.body
        ? `<div class="outcome-body">${formatRichText(o.body)}</div>`
        : "";
    const flowMeta = state.knowledge.triageFlows[state.flowKey];
    const kicker =
      flowMeta && flowMeta.outcomeKicker
        ? flowMeta.outcomeKicker
        : `${speciesLabel(state.species)} · 温柔小结`;
    const copyBlock =
      o.copyBlock &&
      `<div class="copy-template">
        <p class="muted">以下为可复制文本，便于在线问诊或就诊时使用（请补充持续时间、用药与化验单）：</p>
        <textarea readonly class="copy-text" rows="14" id="intakeCopyArea">${escapeHtml(o.copyBlock)}</textarea>
        <button type="button" class="btn secondary" id="btnCopyIntake">复制全文</button>
      </div>`;
    const refsBlock =
      o.refIds && o.refIds.length
        ? `<div class="outcome-tips" aria-label="延伸阅读">
        <p class="outcome-tips-label">延伸阅读 · 供了解，非诊断依据</p>
        ${renderRefs(o.refIds)}
      </div>`
        : "";
    host.innerHTML = `
      <div class="outcome outcome--split ${levelClass}">
        <div class="outcome-core">
          <p class="outcome-kicker">${escapeHtml(kicker)}</p>
          <section class="outcome-diagnostic ${diagnosticMod}" aria-label="分诊小结">
            <div class="outcome-diagnostic-head">
              <span class="severity-badge severity-badge--${sev.mod}">${escapeHtml(sev.label)}</span>
              <span class="outcome-diagnostic-label">先帮你捋一捋（不是诊断哦）</span>
            </div>
            <h2 class="outcome-title">${escapeHtml(o.title)}</h2>
            ${vetBlock}
          </section>
          ${detailSection}
          ${homeSection}
          ${summarySection}
          ${legacyBody}
          ${copyBlock || ""}
          <div class="row outcome-actions">
            <button type="button" class="btn secondary" id="btnRestartFlow">再测一次</button>
            <button type="button" class="btn" id="btnBackTriage">返回分诊</button>
          </div>
        </div>
        ${refsBlock}
      </div>
    `;
    $("#btnRestartFlow").addEventListener("click", () => startFlow(state.flowKey));
    $("#btnBackTriage").addEventListener("click", () => {
      state.lastOutcome = null;
      state.outcomeReturnStepId = null;
      state.flowStepHistory = [];
      state.flowKey = null;
      state.stepId = null;
      state.intakeFlags = null;
      showView("triageMenu");
    });
    const btnCopy = $("#btnCopyIntake");
    if (btnCopy && o.copyBlock) {
      btnCopy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(o.copyBlock);
          btnCopy.textContent = "已复制";
          setTimeout(() => {
            btnCopy.textContent = "复制全文";
          }, 2000);
        } catch {
          const ta = $("#intakeCopyArea");
          if (ta) {
            ta.focus();
            ta.select();
          }
        }
      });
    }
  }

  function renderMultiStep(flow, step) {
    const host = $("#flowContent");
    const options = CuraTriageEngine.getVisibleOptions(step, state.species);
    const optsHtml = options
      .map((opt, idx) => {
        const id = `cb-${state.flowKey}-${state.stepId}-${idx}`;
        const label = escapeHtml(opt.label);
        return `<label class="check-card" for="${id}">
          <input type="checkbox" id="${id}" data-opt-index="${idx}" />
          <span class="check-text">${label}</span>
        </label>`;
      })
      .join("");

    const noneNext = step.noneNext
      ? `<button type="button" class="btn text-link" id="btnNoneNext">${escapeHtml(
          step.noneLabel || "以上都没有"
        )}</button>`
      : "";
    const noneOnly = step.noneOutcome && step.noneLabel
      ? `<button type="button" class="btn secondary soft" id="btnNoneOutcome">${escapeHtml(step.noneLabel)}</button>`
      : "";

    host.innerHTML = `
      <header class="flow-head">
        <p class="badge">${escapeHtml(flow.title)} · ${speciesLabel(state.species)}</p>
        <p class="flow-q">${escapeHtml(step.text).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</p>
      </header>
      <p class="muted multi-hint">可以勾选多项，更像真实养宠时的「好几件同时担心」。</p>
      <div class="multi-wrap">${optsHtml}</div>
      <div class="multi-actions">
        <button type="button" class="btn" id="btnMultiSubmit">${escapeHtml(
          step.submitLabel || "选好了，看看怎么办"
        )}</button>
        ${noneNext}
        ${noneOnly}
      </div>
      <nav class="flow-nav flow-nav--bottom">
        <button type="button" class="btn secondary btn-back-step" id="btnFlowBack">← 上一步</button>
      </nav>
    `;
    wireFlowBack(host);

    $("#btnMultiSubmit").addEventListener("click", () => {
      const checked = $$('input[type="checkbox"]', host).filter((i) => i.checked);
      if (checked.length === 0) {
        if (step.noneOutcome) {
          applyNoneOutcome(step.noneOutcome);
          return;
        }
        alert("请勾选一两条最像的，或点下面「都没有」。");
        return;
      }
      const selected = checked.map((c) => options[Number(c.getAttribute("data-opt-index"))]);
      const merged = CuraTriageEngine.mergeMultiOptions(selected, state.species);
      state.outcomeReturnStepId = state.stepId;
      state.lastOutcome = merged;
      renderOutcome();
    });

    if (step.noneNext) {
      $("#btnNoneNext").addEventListener("click", () => {
        state.flowStepHistory.push(state.stepId);
        state.stepId = step.noneNext;
        renderStep();
      });
    }

    if (step.noneOutcome && $("#btnNoneOutcome")) {
      $("#btnNoneOutcome").addEventListener("click", () => applyNoneOutcome(step.noneOutcome));
    }
  }

  function applyNoneOutcome(raw) {
    state.outcomeReturnStepId = state.stepId;
    const meta = CuraTriageEngine.LEVEL_META[raw.level] || {};
    let detailExplain =
      raw.detailExplain != null ? raw.detailExplain : raw.body || meta.detailExplain || meta.body || "";
    let homeCare = raw.homeCare != null ? raw.homeCare : meta.homeCare || "";
    if (raw.body && raw.detailExplain == null && !meta.detailExplain) {
      detailExplain = raw.body;
    }
    const vetNeed = raw.vetNeed || meta.vetNeed;
    const oneLiner = raw.oneLiner || meta.oneLiner || "";
    const body =
      detailExplain +
      (homeCare ? "\n\n【在家可以这样做】\n" + homeCare : "");
    state.lastOutcome = {
      level: raw.level,
      title: raw.title || meta.title,
      oneLiner,
      detailExplain,
      homeCare,
      body,
      vetNeed,
      refIds: raw.refIds || [],
    };
    renderOutcome();
  }

  function renderAccumulateStep(flow, step) {
    const host = $("#flowContent");
    const options = CuraTriageEngine.getVisibleOptions(step, state.species);
    const optsHtml = options
      .map((opt, idx) => {
        const label = escapeHtml(opt.label);
        return `<button type="button" class="btn option" data-opt-index="${idx}">${label}</button>`;
      })
      .join("");
    const sectionHtml = step.section
      ? `<p class="intake-meta"><span class="intake-section">${escapeHtml(step.section)}</span> · <span class="intake-progress">${escapeHtml(
          step.progress || ""
        )}</span></p>`
      : "";
    const sub = flow.subtitle ? `<p class="muted intake-sub">${escapeHtml(flow.subtitle)}</p>` : "";
    host.innerHTML = `
      <header class="flow-head">
        <p class="badge">${escapeHtml(flow.title)}</p>
        ${sub}
        ${sectionHtml}
        <p class="flow-q">${escapeHtml(step.text)}</p>
      </header>
      <div class="option-grid">${optsHtml}</div>
      <nav class="flow-nav flow-nav--bottom">
        <button type="button" class="btn secondary btn-back-step" id="btnFlowBack">← 上一步</button>
      </nav>
    `;
    wireFlowBack(host);
    $$(".option", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-opt-index"));
        const opt = options[idx];
        (opt.flags || []).forEach((f) => state.intakeFlags.add(f));
        if (opt.criticalOutcome) {
          state.outcomeReturnStepId = state.stepId;
          const out = CuraIntakeEval.finalizeCritical(opt.criticalOutcome, state.intakeFlags);
          state.lastOutcome = out;
          renderOutcome();
          return;
        }
        if (opt.next === "END") {
          state.outcomeReturnStepId = state.stepId;
          state.lastOutcome = CuraIntakeEval.evaluateIntake(state.species, state.intakeFlags);
          renderOutcome();
          return;
        }
        state.flowStepHistory.push(state.stepId);
        state.stepId = opt.next;
        renderStep();
      });
    });
  }

  function renderStep() {
    const flow = state.knowledge.triageFlows[state.flowKey];
    const step = CuraTriageEngine.getStep(flow, state.stepId);
    const host = $("#flowContent");
    if (!step) {
      host.innerHTML = `<p class="error">步骤缺失</p>`;
      return;
    }
    if (flow.flowType === "accumulate") {
      renderAccumulateStep(flow, step);
      return;
    }
    if (step.multi) {
      renderMultiStep(flow, step);
      return;
    }

    const options = CuraTriageEngine.getVisibleOptions(step, state.species);
    const optsHtml = options
      .map((opt, idx) => {
        const label = escapeHtml(opt.label);
        return `<button type="button" class="btn option" data-opt-index="${idx}">${label}</button>`;
      })
      .join("");
    host.innerHTML = `
      <header class="flow-head">
        <p class="badge">${escapeHtml(flow.title)} · ${speciesLabel(state.species)}</p>
        <p class="flow-q">${escapeHtml(step.text)}</p>
      </header>
      <div class="option-grid">${optsHtml}</div>
      <nav class="flow-nav flow-nav--bottom">
        <button type="button" class="btn secondary btn-back-step" id="btnFlowBack">← 上一步</button>
      </nav>
    `;
    wireFlowBack(host);
    $$(".option", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-opt-index"));
        const chosen = options[idx];
        const resolved = CuraTriageEngine.resolveOption(chosen, state.species);
        if (resolved.skip) return;
        if (resolved.kind === "step") {
          state.flowStepHistory.push(state.stepId);
          state.stepId = resolved.stepId;
          renderStep();
        } else if (resolved.kind === "outcome") {
          state.outcomeReturnStepId = state.stepId;
          state.lastOutcome = resolved.outcome;
          renderOutcome();
        }
      });
    });
  }

  function renderEmergencyList() {
    const list = state.knowledge.emergencyRedLines || [];
    const filtered = list.filter(
      (item) => !item.species || item.species.indexOf(state.species) !== -1
    );
    const host = $("#emergencyList");
    host.innerHTML = filtered
      .map((item) => {
        const signs = (item.signs || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
        return `
        <article class="card redline warm">
          <h3>${escapeHtml(item.title)}</h3>
          <p class="signs-label">可能的表现：</p>
          <ul class="signs">${signs}</ul>
          <div class="action-box">${escapeHtml(item.action)}</div>
          ${renderRefs(item.refIds)}
        </article>`;
      })
      .join("");
  }

  function renderBehavior() {
    const tips = (state.knowledge.behaviorTips || []).filter(
      (t) =>
        !t.species ||
        !t.species.length ||
        t.species.indexOf(state.species) !== -1
    );
    const host = $("#behaviorContent");
    host.innerHTML = tips
      .map((t) => {
        const items = (t.items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join("");
        return `
        <article class="card warm">
          <h3>${escapeHtml(t.title)}</h3>
          <ul>${items}</ul>
          ${renderRefs(t.refIds)}
        </article>`;
      })
      .join("");
  }

  function renderZoonosis() {
    const notes = state.knowledge.zoonosisNotes || [];
    const host = $("#zoonosisContent");
    host.innerHTML = notes
      .map(
        (n) => `
      <article class="card warm">
        <h3>${escapeHtml(n.title)}</h3>
        <p>${escapeHtml(n.text)}</p>
        ${renderRefs(n.refIds)}
      </article>`
      )
      .join("");
  }

  function renderKnowledgeGraphBlock() {
    const kg = state.knowledge.knowledgeGraph;
    if (!kg || !kg.clusters || !kg.clusters.length) return "";
    const intro = kg.intro ? `<p class="muted small-intro">${escapeHtml(kg.intro)}</p>` : "";
    const speciesLabel = (arr) => {
      if (!arr || !arr.length) return "犬猫";
      if (arr.length === 2 && arr.indexOf("cat") !== -1 && arr.indexOf("dog") !== -1) return "犬猫";
      if (arr[0] === "dog") return "犬";
      return "猫";
    };
    const cards = kg.clusters
      .map((c) => {
        const sp = `<span class="owner-guides-sp">${escapeHtml(speciesLabel(c.species))}</span>`;
        const hints = (c.hints || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
        const apps = (c.appHints || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
        const refs = renderRefs(c.refIds || []);
        return `<article class="card warm knowledge-graph-card">
          <h3>${escapeHtml(c.label)} ${sp}</h3>
          <p class="signs-label">常见线索（非诊断）</p>
          <ul class="kg-list">${hints}</ul>
          <p class="signs-label">站内相关入口</p>
          <ul class="kg-list">${apps}</ul>
          ${refs}
        </article>`;
      })
      .join("");
    return `<section class="ref-block ref-block--graph"><h3>${escapeHtml(
      kg.title || "知识图谱"
    )}</h3>${intro}<div class="region-grid knowledge-graph-grid">${cards}</div></section><hr class="ref-sep" />`;
  }

  function renderOwnerFreeGuidesBlock() {
    const og = state.knowledge.ownerFreeGuides;
    if (!og || !og.sections || !og.sections.length) return "";
    const intro = og.intro
      ? `<p class="muted owner-guides-intro">${escapeHtml(og.intro)}</p>`
      : "";
    const spLabel = (s) => {
      if (s === "cat") return "猫";
      if (s === "dog") return "犬";
      return "犬猫";
    };
    const sections = og.sections
      .map((sec) => {
        const items = (sec.items || [])
          .map((it) => {
            const u = escapeHtml(it.url || "#");
            const t = escapeHtml(it.title || "");
            const sum = escapeHtml(it.summary || "");
            const how = it.howto ? `<p class="muted owner-guides-howto">${escapeHtml(it.howto)}</p>` : "";
            const badge = `<span class="owner-guides-sp">${escapeHtml(spLabel(it.species))}</span>`;
            return `<li class="owner-guides-item">
              <div class="owner-guides-item-head">
                <a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>
                ${badge}
              </div>
              <p class="muted owner-guides-sum">${sum}</p>
              ${how}
            </li>`;
          })
          .join("");
        return `<section class="ref-block ref-block--owner"><h3>${escapeHtml(sec.title)}</h3><ul class="owner-guides-list">${items}</ul></section>`;
      })
      .join("");
    return `<div class="owner-guides-wrap">${intro}${sections}</div><hr class="ref-sep" />`;
  }

  function renderReferencesPage() {
    const refs = state.knowledge.references || [];
    const host = $("#refsContent");
    const byCat = {};
    refs.forEach((r) => {
      const c = r.category || "其他";
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(r);
    });
    const ownerBlock = renderOwnerFreeGuidesBlock();
    const graphBlock = renderKnowledgeGraphBlock();
    host.innerHTML =
      ownerBlock +
      graphBlock +
      `<p class="muted small-intro">以下为团队内部用于校对条目的参考书与数据库目录（与上方「家长免费指南」互补）；带链接的可直接打开默克等在线章节。</p>` +
      Object.keys(byCat)
        .sort()
        .map((cat) => {
          const items = byCat[cat]
            .map((r) => {
              const link = r.url
                ? `<div class="ref-online"><a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">在线章节</a></div>`
                : "";
              return `
          <li>
            <strong>${escapeHtml(r.title)}</strong>
            ${link}
            <div class="muted">${escapeHtml(r.role || "")}</div>
          </li>`;
            })
            .join("");
          return `<section class="ref-block"><h3>${escapeHtml(cat)}</h3><ul>${items}</ul></section>`;
        })
        .join("");
  }

  function renderBodyMap() {
    const regions = state.knowledge.bodyRegions || [];
    const host = $("#bodyMapContent");
    host.innerHTML = `
      <p class="muted">用来帮你描述「哪里不舒服」，不是自动诊断哦。</p>
      <div class="region-grid">
        ${regions
          .map(
            (r) => `
          <div class="card region warm">
            <h3>${escapeHtml(r.label)}</h3>
            <p class="muted">${escapeHtml(r.note)}</p>
          </div>`
          )
          .join("")}
      </div>`;
  }

  function bindNav() {
    $("#btnDisclaimer").addEventListener("click", () => showView("disclaimer"));
    $("#pickCat").addEventListener("click", () => {
      state.species = "cat";
      updateSpeciesLabels();
      updateSpeciesCards();
    });
    $("#pickDog").addEventListener("click", () => {
      state.species = "dog";
      updateSpeciesLabels();
      updateSpeciesCards();
    });
    $("#enterApp").addEventListener("click", () => {
      updateSpeciesLabels();
      updateSpeciesCards();
      showView("triageMenu");
    });
    $("#brandHome").addEventListener("click", () => renderHome());
    $$(".js-back-home").forEach((btn) => btn.addEventListener("click", () => renderHome()));
    $("#linkHome").addEventListener("click", () => renderHome());
    $$("[data-home-nav]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nav = btn.getAttribute("data-home-nav");
        if (nav === "emergency") {
          renderEmergencyList();
          showView("emergency");
        } else if (nav === "behavior") {
          renderBehavior();
          showView("behavior");
        } else if (nav === "bodymap") {
          renderBodyMap();
          showView("bodymap");
        } else if (nav === "zoonosis") {
          renderZoonosis();
          showView("zoonosis");
        } else if (nav === "refs") {
          renderReferencesPage();
          showView("refs");
        }
      });
    });

    const btnDailyBack = $("#btnDailyTopicBack");
    if (btnDailyBack) btnDailyBack.addEventListener("click", () => renderHome());

    $("#startScreen").addEventListener("click", () => startFlow("screen"));
    $("#startUrinary").addEventListener("click", () => startFlow("urinary"));
    $("#startGi").addEventListener("click", () => startFlow("gi"));
    $("#startSkin").addEventListener("click", () => startFlow("skin"));
    $("#startToxic").addEventListener("click", () => startFlow("toxic"));
    $("#startBehavior").addEventListener("click", () => startFlow("behavior"));
    $("#startCatIntake").addEventListener("click", () => startFlow("catIntake"));
    $("#startDogIntake").addEventListener("click", () => startFlow("dogIntake"));

    const openHc = $("#openHealthChat");
    if (openHc && typeof CuraHealthChatInit === "function") {
      CuraHealthChatInit({
        getSpecies: () => state.species,
        getKnowledge: () => state.knowledge,
        onOpenEmergency: () => {
          renderEmergencyList();
          showView("emergency");
        },
        onOpenTriage: () => {
          showView("triageMenu");
        },
        onOpenDailyTopic: (topicId) => {
          renderDailyTopicPage(topicId);
          showView("dailyTopic");
        },
      });
      openHc.addEventListener("click", () => {
        if (typeof CuraHealthChat !== "undefined" && CuraHealthChat) {
          CuraHealthChat.syncSpecies();
          CuraHealthChat.open();
        }
        showView("healthChat");
      });
    }
  }

  async function boot() {
    try {
      await loadKnowledge();
    } catch (e) {
      document.body.innerHTML = `<main class="wrap"><p class="error">加载失败：${escapeHtml(
        e.message
      )}</p></main>`;
      return;
    }
    applyHeroImages();
    bindNav();
    renderHome();
  }

  boot();
})();
