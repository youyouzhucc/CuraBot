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

  function updateSpeciesLabels() {
    $$(".js-species-label").forEach((el) => {
      el.textContent = speciesLabel(state.species);
    });
  }

  function updateSpeciesCards() {
    $$(".species-card").forEach((card) => {
      const sp = card.getAttribute("data-species");
      card.classList.toggle("is-selected", sp === state.species);
      card.setAttribute("aria-pressed", sp === state.species ? "true" : "false");
    });
    updateTriageIntakeVisibility();
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
    const vetBlock = o.vetNeed
      ? `<div class="vet-banner" role="status"><span class="vet-icon">🏥</span><div class="vet-text">${escapeHtml(
          o.vetNeed
        )}</div></div>`
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
        <textarea readonly class="copy-text" rows="12" id="intakeCopyArea">${escapeHtml(o.copyBlock)}</textarea>
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
          <h2 class="outcome-title">${escapeHtml(o.title)}</h2>
          <div class="outcome-body">${escapeHtml(o.body).replace(/\n/g, "<br/>")}</div>
          ${vetBlock}
          ${copyBlock || ""}
          <div class="row outcome-actions">
            <button type="button" class="btn secondary" id="btnRestartFlow">再测一次</button>
            <button type="button" class="btn" id="btnBackTriage">返回分诊</button>
          </div>
        </div>
        ${refsBlock}
      </div>
      <nav class="flow-nav flow-nav--bottom">
        <button type="button" class="btn secondary btn-back-step" id="btnFlowBack">← 上一步</button>
      </nav>
    `;
    wireFlowBack(host);
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
    let body = raw.body || meta.body || "";
    if (raw.homeCare) body += `\n\n【在家可以这样做】\n${raw.homeCare}`;
    state.lastOutcome = {
      level: raw.level,
      title: raw.title || meta.title,
      body,
      vetNeed: raw.vetNeed || meta.vetNeed,
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

  function renderReferencesPage() {
    const refs = state.knowledge.references || [];
    const host = $("#refsContent");
    const byCat = {};
    refs.forEach((r) => {
      const c = r.category || "其他";
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(r);
    });
    host.innerHTML =
      `<p class="muted small-intro">下面是团队内部用来校对内容的参考书与指南目录，不影响日常使用。</p>` +
      Object.keys(byCat)
        .sort()
        .map((cat) => {
          const items = byCat[cat]
            .map(
              (r) => `
          <li>
            <strong>${escapeHtml(r.title)}</strong>
            <div class="muted">${escapeHtml(r.role || "")}</div>
          </li>`
            )
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
      showView("menu");
    });
    $("#brandHome").addEventListener("click", () => renderHome());
    $$(".js-back-to-menu").forEach((btn) => btn.addEventListener("click", () => showView("menu")));
    $$(".js-back-home").forEach((btn) => btn.addEventListener("click", () => renderHome()));
    $("#linkHome").addEventListener("click", () => renderHome());

    $("#menuTriage").addEventListener("click", () => showView("triageMenu"));
    $("#menuRed").addEventListener("click", () => {
      renderEmergencyList();
      showView("emergency");
    });
    $("#menuBehavior").addEventListener("click", () => {
      renderBehavior();
      showView("behavior");
    });
    $("#menuBody").addEventListener("click", () => {
      renderBodyMap();
      showView("bodymap");
    });
    $("#menuRefs").addEventListener("click", () => {
      renderReferencesPage();
      showView("refs");
    });
    $("#menuZoonosis").addEventListener("click", () => {
      renderZoonosis();
      showView("zoonosis");
    });

    $("#startScreen").addEventListener("click", () => startFlow("screen"));
    $("#startUrinary").addEventListener("click", () => startFlow("urinary"));
    $("#startGi").addEventListener("click", () => startFlow("gi"));
    $("#startSkin").addEventListener("click", () => startFlow("skin"));
    $("#startToxic").addEventListener("click", () => startFlow("toxic"));
    $("#startBehavior").addEventListener("click", () => startFlow("behavior"));
    $("#startCatIntake").addEventListener("click", () => startFlow("catIntake"));
    $("#startDogIntake").addEventListener("click", () => startFlow("dogIntake"));
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
