(function () {
  const state = {
    knowledge: null,
    species: "cat",
    view: "home",
    flowKey: null,
    stepId: null,
    lastOutcome: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  async function loadKnowledge() {
    const res = await fetch("/data/knowledge.json", { cache: "no-store" });
    if (!res.ok) throw new Error("无法加载内容");
    state.knowledge = await res.json();
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
        banner.style.backgroundImage = `url(${k.uiImages.bannerSoft})`;
      } else {
        banner.style.backgroundImage = "none";
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
  }

  function showView(name) {
    state.view = name;
    $$("[data-view]").forEach((el) => {
      el.hidden = el.getAttribute("data-view") !== name;
    });
    const topBtn = $("#topMenuBtn");
    if (topBtn) {
      const showTop = name !== "home" && name !== "disclaimer";
      topBtn.hidden = !showTop;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderHome() {
    updateSpeciesLabels();
    updateSpeciesCards();
    showView("home");
  }

  function startFlow(key) {
    const flow = state.knowledge.triageFlows[key];
    if (!flow) return;
    state.flowKey = key;
    state.stepId = flow.start;
    state.lastOutcome = null;
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
    host.innerHTML = `
      <div class="outcome ${levelClass}">
        <p class="outcome-kicker">${escapeHtml(speciesLabel(state.species))} · 温柔小结</p>
        <h2 class="outcome-title">${escapeHtml(o.title)}</h2>
        <div class="outcome-body">${escapeHtml(o.body).replace(/\n/g, "<br/>")}</div>
        ${vetBlock}
        ${renderRefs(o.refIds)}
        <div class="row">
          <button type="button" class="btn secondary" id="btnRestartFlow">再测一次</button>
          <button type="button" class="btn" id="btnBackMenu">回主菜单</button>
        </div>
      </div>
    `;
    $("#btnRestartFlow").addEventListener("click", () => startFlow(state.flowKey));
    $("#btnBackMenu").addEventListener("click", () => showView("menu"));
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
    `;

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
      state.lastOutcome = merged;
      renderOutcome();
    });

    if (step.noneNext) {
      $("#btnNoneNext").addEventListener("click", () => {
        state.stepId = step.noneNext;
        renderStep();
      });
    }

    if (step.noneOutcome && $("#btnNoneOutcome")) {
      $("#btnNoneOutcome").addEventListener("click", () => applyNoneOutcome(step.noneOutcome));
    }
  }

  function applyNoneOutcome(raw) {
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

  function renderStep() {
    const flow = state.knowledge.triageFlows[state.flowKey];
    const step = CuraTriageEngine.getStep(flow, state.stepId);
    const host = $("#flowContent");
    if (!step) {
      host.innerHTML = `<p class="error">步骤缺失</p>`;
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
    `;
    $$(".option", host).forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-opt-index"));
        const chosen = options[idx];
        const resolved = CuraTriageEngine.resolveOption(chosen, state.species);
        if (resolved.skip) return;
        if (resolved.kind === "step") {
          state.stepId = resolved.stepId;
          renderStep();
        } else if (resolved.kind === "outcome") {
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
    const tips = state.knowledge.behaviorTips || [];
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
    $("#topMenuBtn").addEventListener("click", () => showView("menu"));
    $$(".js-open-menu").forEach((btn) => btn.addEventListener("click", () => showView("menu")));
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
