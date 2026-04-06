/**
 * 首页：健康图谱（剪影按顶部猫/狗切换单显 · 实拍/矢量 + 莫兰迪热区）· 便便识别/体况识别 · 趣味闯关
 */
(function (global) {
  const STORAGE = {
    streak: "curabot_hgq_streak",
    lastGood: "curabot_hgq_last_good_date",
    lastPlay: "curabot_hgq_last_play_date",
    weakDiet: "curabot_quiz_weak_diet",
    badges: "curabot_hgq_badges",
  };

  let data = null;
  let mount = null;
  /** 健康图谱模块内猫/狗范围（与日常知识 tabs 样式一致），默认猫猫 */
  let hgqSpecies = "cat";
  /** 顶栏模块：map | poop | body | quiz */
  let hgqMainTab = "map";

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function todayISO() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }

  function yesterdayISO() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  function seasonKey() {
    const m = new Date().getMonth();
    if (m >= 2 && m <= 4) return "spring";
    if (m >= 5 && m <= 7) return "summer";
    if (m >= 8 && m <= 10) return "autumn";
    return "winter";
  }

  function seasonTip() {
    const s = seasonKey();
    const map = {
      spring: "换季时节，梳毛频率可适当增加，留意皮肤与被毛变化；疫苗与驱虫计划可和兽医确认。",
      summer: "高温日注意通风与补水；短鼻犬种更易中暑，避免正午剧烈运动。",
      autumn: "气温波动大，留意食欲与排便节律；可适当增加环境湿度相关护理。",
      winter: "室内外温差大，关节与呼吸道敏感个体需更温和过渡；取暖注意通风与安全。",
    };
    const fb = data && data.seasonalFallback && data.seasonalFallback[0];
    return map[s] || fb || "";
  }

  async function fetchWeatherLine() {
    let lat = 39.9042;
    let lon = 116.4074;
    try {
      if (navigator.geolocation) {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 600000 });
        });
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
      }
    } catch (e) {
      /* 默认北京 */
    }
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
      const r = await fetch(u);
      const j = await r.json();
      const t = j.current && j.current.temperature_2m;
      if (typeof t === "number") {
        let extra = "";
        if (t >= 30) extra = " 今日气温偏高，短鼻犬种与老年个体更要注意防暑与补水。";
        else if (t <= 5) extra = " 气温偏低，外出时可缩短时间，注意脚垫保暖与关节舒适。";
        return `当前约 ${Math.round(t)}°C（Open-Meteo 参考）。${extra}`;
      }
    } catch (e) {
      /* ignore */
    }
    return "天气数据暂不可用，仍可根据季节提示安排日常护理。";
  }

  /** 解析 viewBox "minX minY width height"，用于底图与热区共用同一坐标系 */
  function parseViewBox(vb) {
    const p = String(vb || "0 0 800 480")
      .trim()
      .split(/\s+/)
      .map(Number);
    const minX = Number.isFinite(p[0]) ? p[0] : 0;
    const minY = Number.isFinite(p[1]) ? p[1] : 0;
    const w = Number.isFinite(p[2]) ? p[2] : 800;
    const h = Number.isFinite(p[3]) ? p[3] : 480;
    return { minX, minY, w, h };
  }

  function usePctLayout(spec) {
    return spec && spec.layout === "percent" && Array.isArray(spec.regions);
  }

  function useColorMapLayout(spec) {
    return spec && spec.layout === "color-map" && Array.isArray(spec.regions);
  }

  /** 百分比热区（相对裁剪后的可见半图），带中心呼吸点 */
  function renderBodyRegionPct(species, reg) {
    const zs = String(reg.zone || "red")
      .toLowerCase()
      .replace(/[^a-z]/g, "") || "red";
    const zoneClass = ` hgq-zone--${esc(zs)}`;
    const pct = reg.hotspotPct;
    if (!pct || typeof pct.top !== "number") return "";
    const style = `top:${pct.top}%;left:${pct.left}%;width:${pct.width}%;height:${pct.height}%;`;
    return `
        <div class="hgq-hotspot-group hgq-hotspot-group--pct${zoneClass}" data-species="${esc(species)}" data-part="${esc(reg.id)}" style="${style}">
          <span class="hgq-hotspot-pulse-dot" aria-hidden="true"></span>
          <button type="button" class="hgq-hotspot-hit hgq-hotspot-hit--pct" aria-label="${esc(reg.label)}"></button>
        </div>`;
  }

  function renderBodyStackPct(species, spec) {
    const crop = spec.imageCrop === "right" ? "right" : "left";
    const regions = spec.regions.map((reg) => renderBodyRegionPct(species, reg)).join("");
    const imgHref = spec.image && String(spec.image).trim();
    return `
      <div class="hgq-silhouette-block" data-silhouette-block="${esc(species)}">
        <p class="muted small hgq-body-sub">${esc(spec.subtitle)}</p>
        <div class="hgq-svg-wrap hgq-svg-wrap--pct">
          <div class="hgq-silhouette-pct hgq-silhouette-pct--${crop}">
            ${imgHref ? `<img class="hgq-silhouette-photo" src="${esc(imgHref)}" alt="" decoding="async" />` : ""}
            <div class="hgq-hotspot-layer">${regions}</div>
          </div>
        </div>
      </div>`;
  }

  function renderBodyRegionShapes(species, reg) {
    const zs = String(reg.zone || "red")
      .toLowerCase()
      .replace(/[^a-z]/g, "") || "red";
    const zoneClass = ` hgq-zone--${esc(zs)}`;
    if (reg.path) {
      return `
        <g class="hgq-hotspot-group${zoneClass}" data-species="${esc(species)}" data-part="${esc(reg.id)}">
          <path class="hgq-hotspot" d="${esc(reg.path)}" />
          <path class="hgq-hotspot-hit" d="${esc(reg.path)}" tabindex="0" role="button" aria-label="${esc(reg.label)}" />
        </g>`;
    }
    const rv = reg.r || 8;
    const rh = rv + 2;
    return `
        <g class="hgq-hotspot-group${zoneClass}" data-species="${esc(species)}" data-part="${esc(reg.id)}">
          <circle class="hgq-hotspot" cx="${reg.cx}" cy="${reg.cy}" r="${rv}" />
          <circle class="hgq-hotspot-hit" cx="${reg.cx}" cy="${reg.cy}" r="${rh}" tabindex="0" role="button" aria-label="${esc(reg.label)}" />
        </g>`;
  }

  function renderBodyStack(species) {
    const spec = data.bodyMap[species];
    if (!spec) return "";
    if (useColorMapLayout(spec)) {
      const imgHref = spec.image && String(spec.image).trim();
      const speciesLabel = species === "dog" ? "狗狗" : "猫猫";
      return `
      <div class="hgq-silhouette-block" data-silhouette-block="${esc(species)}">
        <p class="muted small hgq-body-sub">${esc(spec.subtitle)}</p>
        <div class="hgq-color-map-wrap" data-species="${esc(species)}">
          ${imgHref ? `<img class="hgq-color-map-img" src="${esc(imgHref)}" alt="" decoding="async" />` : ""}
          <canvas class="hgq-color-map-highlight" aria-hidden="true"></canvas>
          <button type="button" class="hgq-color-map-hit" aria-label="点击${esc(speciesLabel)}色块查看部位说明"></button>
        </div>
      </div>`;
    }
    if (usePctLayout(spec)) {
      return renderBodyStackPct(species, spec);
    }
    const regions = spec.regions.map((reg) => renderBodyRegionShapes(species, reg)).join("");
    const imgHref = spec.image && String(spec.image).trim();
    const vb = parseViewBox(spec.viewBox);
    /* 底图铺满 viewBox：与资源图素尺寸一致时无留白，热区 path 与像素对齐 */
    const baseLayer = imgHref
      ? `<image class="hgq-silhouette-img" href="${esc(imgHref)}" x="${vb.minX}" y="${vb.minY}" width="${vb.w}" height="${vb.h}" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>`
      : spec.silhouette || "";
    return `
      <div class="hgq-silhouette-block" data-silhouette-block="${esc(species)}">
        <p class="muted small hgq-body-sub">${esc(spec.subtitle)}</p>
        <div class="hgq-svg-wrap">
          <svg class="hgq-silhouette-svg" viewBox="${esc(spec.viewBox)}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            ${baseLayer}
            ${regions}
          </svg>
        </div>
      </div>`;
  }

  function updateSilhouetteSpeciesVisibility() {
    if (!mount) return;
    mount.querySelectorAll(".hgq-silhouette-block").forEach((b) => {
      const sp = b.getAttribute("data-silhouette-block");
      b.hidden = sp !== hgqSpecies;
    });
  }

  function renderBodyMapBlock() {
    return `
      <div class="hgq-body-map-root">
        <div class="hgq-body-map-row hgq-body-map-combo">
          <div class="hgq-body-map-col hgq-body-map-col--svg">
            <div class="hgq-silhouette-stack">
              ${renderBodyStack("dog")}
              ${renderBodyStack("cat")}
            </div>
          </div>
          <aside class="hgq-body-map-col hgq-body-map-col--card" aria-live="polite">
            <div class="hgq-tip-card has-content" id="hgqTipCard"></div>
          </aside>
        </div>
      </div>`;
  }

  function renderUnifiedToolbar() {
    const catOn = hgqSpecies === "cat";
    const dogOn = hgqSpecies === "dog";
    const mapOn = hgqMainTab === "map";
    const poopOn = hgqMainTab === "poop";
    const bodyOn = hgqMainTab === "body";
    const quizOn = hgqMainTab === "quiz";
    return `
      <div class="hgq-unified-toolbar daily-knowledge-toolbar" role="region" aria-label="健康知识筛选">
        <div class="daily-knowledge-tabs hgq-unified-tabs-seg" role="group" aria-label="物种范围">
          <button type="button" class="daily-knowledge-tab ${catOn ? "is-active" : ""}" data-hgq-filter="cat" id="hgqFilterCat">猫猫</button>
          <button type="button" class="daily-knowledge-tab ${dogOn ? "is-active" : ""}" data-hgq-filter="dog" id="hgqFilterDog">狗狗</button>
        </div>
        <span class="hgq-toolbar-divider" aria-hidden="true"></span>
        <div class="daily-knowledge-tabs hgq-unified-tabs-seg" role="tablist" aria-label="内容模块">
          <button type="button" class="daily-knowledge-tab ${mapOn ? "is-active" : ""}" role="tab" aria-selected="${mapOn ? "true" : "false"}" data-hgq-tab="map" id="hgqTabMap">剪影图谱</button>
          <button type="button" class="daily-knowledge-tab ${poopOn ? "is-active" : ""}" role="tab" aria-selected="${poopOn ? "true" : "false"}" data-hgq-tab="poop" id="hgqTabPoop">便便识别</button>
          <button type="button" class="daily-knowledge-tab ${bodyOn ? "is-active" : ""}" role="tab" aria-selected="${bodyOn ? "true" : "false"}" data-hgq-tab="body" id="hgqTabBody">体况识别</button>
          <button type="button" class="daily-knowledge-tab ${quizOn ? "is-active" : ""}" role="tab" aria-selected="${quizOn ? "true" : "false"}" data-hgq-tab="quiz" id="hgqTabQuiz">趣味闯关</button>
        </div>
      </div>`;
  }

  function filterCardsBySpecies(cards, sp) {
    if (!Array.isArray(cards)) return [];
    return cards.filter((c) => {
      if (c.species == null) return true;
      if (Array.isArray(c.species)) return c.species.indexOf(sp) >= 0;
      return c.species === sp;
    });
  }

  /** 便便示意图（科普示意，非医学影像） */
  function poopIllustrationSvg(id) {
    const svgStart = '<svg class="hgq-poop-fig" viewBox="0 0 88 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
    const map = {
      p1:
        svgStart +
        '<ellipse cx="22" cy="38" rx="14" ry="10" fill="#b8956a"/><ellipse cx="44" cy="36" rx="15" ry="11" fill="#c9a574"/><ellipse cx="66" cy="38" rx="14" ry="10" fill="#b8956a"/><line x1="30" y1="31" x2="30" y2="43" stroke="#7d6348" stroke-width="1.3"/><line x1="52" y1="30" x2="52" y2="44" stroke="#7d6348" stroke-width="1.3"/></svg>',
      p2:
        svgStart +
        '<ellipse cx="44" cy="38" rx="30" ry="12" fill="#5c4033"/><path d="M 22 35 L 66 37 M 26 40 L 62 39" stroke="#3d2a22" stroke-width="1.2"/><path d="M 34 33 L 38 41 M 50 32 L 54 42" stroke="#4a3428" stroke-width="0.9"/></svg>',
      p3:
        svgStart +
        '<ellipse cx="44" cy="40" rx="34" ry="15" fill="#e8c84a" opacity="0.92"/><ellipse cx="44" cy="38" rx="28" ry="11" fill="#f2e080"/><ellipse cx="52" cy="36" rx="6" ry="4" fill="#f5e9a0" opacity="0.7"/></svg>',
      p4:
        svgStart +
        '<ellipse cx="44" cy="38" rx="26" ry="11" fill="#8b6b52"/><path d="M 30 36 Q 44 42 58 34" stroke="#c04040" stroke-width="2.2" fill="none" stroke-linecap="round"/><ellipse cx="36" cy="36" rx="4" ry="2.5" fill="#d64d4d" opacity="0.85"/><path d="M 40 33 Q 44 37 48 33" stroke="#e8d4c0" stroke-width="1.5" fill="none" opacity="0.9"/></svg>',
      p5:
        svgStart +
        '<ellipse cx="44" cy="38" rx="28" ry="12" fill="#121212"/><ellipse cx="36" cy="33" rx="10" ry="5" fill="#2e2e2e" opacity="0.55"/><ellipse cx="50" cy="35" rx="6" ry="3" fill="#3a3a3a" opacity="0.4"/></svg>',
    };
    return map[id] || "";
  }

  /** 体况小图标（俯视轮廓示意） */
  function bodyIllustrationSvg(id) {
    const svgStart = '<svg class="hgq-body-fig" viewBox="0 0 88 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">';
    const map = {
      b1:
        svgStart +
        '<ellipse cx="44" cy="28" rx="18" ry="12" fill="#bcc6b8"/><path d="M 28 36 Q 44 30 60 36 Q 44 42 28 36" fill="#a8b5a5"/></svg>',
      b2:
        svgStart +
        '<ellipse cx="44" cy="30" rx="22" ry="14" fill="#c9c4b0"/><path d="M 26 38 Q 44 34 62 38 Q 44 44 26 38" fill="#b5b09a"/></svg>',
      b3:
        svgStart +
        '<ellipse cx="44" cy="32" rx="26" ry="16" fill="#c4b8a8"/><circle cx="44" cy="32" r="14" fill="#b0a090" opacity="0.5"/></svg>',
      b4:
        svgStart +
        '<rect x="18" y="20" width="52" height="22" rx="4" fill="none" stroke="#8a9ab0" stroke-width="2"/><path d="M 28 31 L 60 31" stroke="#8a9ab0" stroke-width="1.5" stroke-dasharray="3 2"/><circle cx="44" cy="31" r="3" fill="#8a9ab0"/></svg>',
    };
    return map[id] || "";
  }

  function cardRatingText(c) {
    if (c.rating && String(c.rating).trim()) return String(c.rating).trim();
    const fb = { ok: "理想参考", watch: "留意观察", vet: "建议就医", urgent: "尽快就医", tip: "参考" };
    return fb[c.tone] || "";
  }

  function renderWellCard(c, kind) {
    const fig = kind === "poop" ? poopIllustrationSvg(c.id) : bodyIllustrationSvg(c.id);
    const badge = esc(cardRatingText(c));
    return `
            <article class="hgq-well-card" data-card-kind="${esc(kind)}">
              <span class="hgq-well-card__badge">${badge}</span>
              ${fig ? `<div class="hgq-well-card__fig">${fig}</div>` : ""}
              <div class="hgq-well-card__head">
                <h5 class="hgq-well-card__title">${esc(c.title)}</h5>
                <button type="button" class="hgq-well-card__expand" hidden aria-expanded="false" aria-label="展开全文">
                  <span class="hgq-expand-icon" aria-hidden="true"></span>
                </button>
              </div>
              <p class="hgq-well-card__desc">${esc(c.desc)}</p>
            </article>`;
  }

  function initWellCardExpand(root) {
    if (!root) return;
    function measureCollapsed(card) {
      const desc = card.querySelector(".hgq-well-card__desc");
      const btn = card.querySelector(".hgq-well-card__expand");
      if (!desc || !btn) return;
      if (card.classList.contains("is-expanded")) return;
      void desc.offsetHeight;
      const overflow = desc.scrollHeight > desc.clientHeight + 1;
      card.dataset.needsExpand = overflow ? "1" : "0";
      btn.hidden = !overflow;
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", "展开全文");
    }

    root.querySelectorAll(".hgq-well-card").forEach((card) => {
      measureCollapsed(card);
      const btn = card.querySelector(".hgq-well-card__expand");
      if (!btn) return;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (card.dataset.needsExpand !== "1") return;
        card.classList.toggle("is-expanded");
        const exp = card.classList.contains("is-expanded");
        btn.setAttribute("aria-expanded", exp ? "true" : "false");
        btn.setAttribute("aria-label", exp ? "收起" : "展开全文");
      });
    });

    if (typeof ResizeObserver !== "undefined") {
      try {
        const ro = new ResizeObserver(() => {
          root.querySelectorAll(".hgq-well-card").forEach((card) => {
            if (!card.classList.contains("is-expanded")) measureCollapsed(card);
          });
        });
        root.querySelectorAll(".hgq-well-card__desc").forEach((el) => ro.observe(el));
      } catch (e) {
        /* ignore */
      }
    }
  }

  function renderPoopCardsHost(sp) {
    const poops = filterCardsBySpecies(data.poopCards || [], sp);
    return `
      <div class="hgq-wellness-module hgq-wellness-module--solo">
        <div class="hgq-wellness-panel">
          <div class="hgq-wellness-grid">
            ${poops.map((c) => renderWellCard(c, "poop")).join("")}
          </div>
        </div>
      </div>`;
  }

  function renderBodyCardsHost(sp) {
    const bodies = filterCardsBySpecies(data.bodyCards || [], sp);
    return `
      <div class="hgq-wellness-module hgq-wellness-module--solo">
        <div class="hgq-wellness-panel">
          <div class="hgq-wellness-grid">
            ${bodies.map((c) => renderWellCard(c, "body")).join("")}
          </div>
        </div>
      </div>`;
  }

  function refreshCardPanels() {
    const poopHost = document.getElementById("hgqPoopHost");
    const bodyHost = document.getElementById("hgqBodyHost");
    if (poopHost) {
      poopHost.innerHTML = renderPoopCardsHost(hgqSpecies);
      initWellCardExpand(poopHost);
    }
    if (bodyHost) {
      bodyHost.innerHTML = renderBodyCardsHost(hgqSpecies);
      initWellCardExpand(bodyHost);
    }
  }

  function updateQuizScopeLabel() {
    const el = document.getElementById("hgqQuizScope");
    if (!el) return;
    const t = hgqSpecies === "dog" ? "狗狗" : "猫猫";
    el.innerHTML = `当前闯关范围：<strong>${t}</strong>（题目优先匹配该物种）`;
  }

  function getDefaultPartId(species) {
    const spec = data.bodyMap[species];
    if (!spec || !spec.regions) return null;
    const head = spec.regions.find((r) => r.id === "head");
    return head ? "head" : spec.regions[0].id;
  }

  function selectEarsForSpecies(sp) {
    const part = getDefaultPartId(sp);
    if (!mount || !part) return;
    mount.querySelectorAll(".hgq-hotspot-group.is-selected").forEach((g) => g.classList.remove("is-selected"));
    const group = mount.querySelector(`.hgq-hotspot-group[data-species="${sp}"][data-part="${part}"]`);
    if (group) group.classList.add("is-selected");
    const spec = data.bodyMap[sp];
    const reg = spec && spec.regions.find((r) => r.id === part);
    if (reg) showTip(sp, reg);
  }

  function bindUnifiedToolbar() {
    mount.querySelectorAll("[data-hgq-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sp = btn.getAttribute("data-hgq-filter") === "dog" ? "dog" : "cat";
        hgqSpecies = sp;
        mount.querySelectorAll("[data-hgq-filter]").forEach((b) => {
          b.classList.toggle("is-active", b.getAttribute("data-hgq-filter") === sp);
        });
        refreshCardPanels();
        updateQuizScopeLabel();
        updateSilhouetteSpeciesVisibility();
        selectEarsForSpecies(hgqSpecies);
      });
    });
    mount.querySelectorAll("[data-hgq-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-hgq-tab");
        if (!id) return;
        hgqMainTab = id;
        mount.querySelectorAll("[data-hgq-tab]").forEach((b) => {
          const on = b.getAttribute("data-hgq-tab") === id;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        mount.querySelectorAll("[data-hgq-panel]").forEach((p) => {
          const on = p.getAttribute("data-hgq-panel") === id;
          p.hidden = !on;
          p.classList.toggle("is-active", on);
        });
      });
    });
  }

  function tipCardHtml(species, reg) {
    if (!reg) return "";
    const daily = reg.dailyCare != null ? String(reg.dailyCare) : reg.tip != null ? String(reg.tip) : "";
    const warns = Array.isArray(reg.warningSigns) ? reg.warningSigns : reg.conditions ? reg.conditions.slice() : [];
    const care = reg.careTips != null ? String(reg.careTips) : "";
    const warnList = warns.map((c) => `<li>${esc(c)}</li>`).join("");
    const zp = String(reg.zone || "red")
      .toLowerCase()
      .replace(/[^a-z]/g, "") || "red";
    return `
      <header class="hgq-tip-card-head">
        <span class="hgq-tip-zone-pill hgq-tip-zone-pill--${esc(zp)}">${esc(reg.label)}</span>
        ${reg.organs ? `<p class="hgq-tip-card-meta muted small">${esc(reg.organs)}</p>` : ""}
      </header>
      <section class="hgq-tip-card-block">
        <h5 class="hgq-tip-card-h">日常关注</h5>
        <p class="hgq-tip-card-p">${esc(daily)}</p>
      </section>
      <section class="hgq-tip-card-block">
        <h5 class="hgq-tip-card-h">异常警示</h5>
        ${warnList ? `<ul class="hgq-tip-card-ul">${warnList}</ul>` : `<p class="hgq-tip-card-p muted small">暂无单独条目，请以兽医评估为准。</p>`}
      </section>
      <section class="hgq-tip-card-block">
        <h5 class="hgq-tip-card-h">养护建议</h5>
        <p class="hgq-tip-card-p">${esc(care)}</p>
      </section>`;
  }

  function showTip(species, reg) {
    const host = document.getElementById("hgqTipCard");
    if (!host || !reg) return;
    host.innerHTML = tipCardHtml(species, reg);
    host.classList.add("has-content");
  }

  function classifyZoneByRgb(r, g, b, a) {
    if (a < 20) return "";
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    if (maxC - minC < 10) return "";
    if (maxC > 246 && minC > 236) return "";
    const targets = [
      { zone: "red", rgb: [228, 150, 125] },
      { zone: "blue", rgb: [132, 169, 205] },
      { zone: "green", rgb: [140, 196, 156] },
      { zone: "yellow", rgb: [228, 201, 108] },
      { zone: "purple", rgb: [182, 136, 196] },
    ];
    let bestZone = "";
    let bestDist = Infinity;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const dr = r - t.rgb[0];
      const dg = g - t.rgb[1];
      const db = b - t.rgb[2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestZone = t.zone;
      }
    }
    if (!bestZone || bestDist > 9000) return "";
    return bestZone;
  }

  function buildColorMapMasks(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const cvs = document.createElement("canvas");
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const raw = ctx.getImageData(0, 0, w, h);
    const src = raw.data;
    const zones = ["red", "blue", "green", "yellow", "purple"];
    const masks = {};
    zones.forEach((z) => {
      masks[z] = new Uint8ClampedArray(w * h);
    });
    for (let i = 0, p = 0; i < src.length; i += 4, p++) {
      const z = classifyZoneByRgb(src[i], src[i + 1], src[i + 2], src[i + 3]);
      if (z && masks[z]) masks[z][p] = 255;
    }
    return { w, h, masks };
  }

  function paintZoneHighlight(canvas, maskPack, zone) {
    if (!canvas || !maskPack || !zone || !maskPack.masks[zone]) return;
    const w = maskPack.w;
    const h = maskPack.h;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imgData = ctx.createImageData(w, h);
    const dst = imgData.data;
    const mask = maskPack.masks[zone];
    const tint = {
      red: [228, 150, 125],
      blue: [132, 169, 205],
      green: [140, 196, 156],
      yellow: [228, 201, 108],
      purple: [182, 136, 196],
    }[zone] || [180, 180, 180];
    const edge = new Uint8ClampedArray(mask.length);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        if (!mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) edge[p] = 1;
      }
    }
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      if (!mask[p]) continue;
      // 主体填充：提高不透明度
      dst[i] = tint[0];
      dst[i + 1] = tint[1];
      dst[i + 2] = tint[2];
      dst[i + 3] = 185;
      if (edge[p]) {
        // 边缘双层对比：外白内深，提升可见性
        dst[i] = 255;
        dst[i + 1] = 255;
        dst[i + 2] = 255;
        dst[i + 3] = 235;
      }
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(imgData, 0, 0);
  }

  function clearZoneHighlight(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** 剪影框与图片缩放后，高亮 canvas 需与图片像素区域对齐（避免白边内偏移） */
  function syncColorMapHighlightOverlay(wrap, img, hi) {
    if (!wrap || !img || !hi) return;
    const run = () => {
      const l = img.offsetLeft;
      const t = img.offsetTop;
      const w = Math.max(1, Math.round(img.offsetWidth));
      const h = Math.max(1, Math.round(img.offsetHeight));
      hi.style.left = l + "px";
      hi.style.top = t + "px";
      hi.style.width = w + "px";
      hi.style.height = h + "px";
    };
    run();
    if (typeof ResizeObserver !== "undefined") {
      try {
        const ro = new ResizeObserver(() => run());
        ro.observe(wrap);
        ro.observe(img);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function bindBodyMap() {
    mount.querySelectorAll(".hgq-hotspot-hit").forEach((el) => {
      function activate() {
        mount.querySelectorAll(".hgq-hotspot-group.is-selected").forEach((g0) => g0.classList.remove("is-selected"));
        const g = el.closest(".hgq-hotspot-group");
        if (!g) return;
        g.classList.add("is-selected");
        const species = g.getAttribute("data-species");
        const part = g.getAttribute("data-part");
        const spec = data.bodyMap[species];
        const reg = spec && spec.regions.find((r) => r.id === part);
        showTip(species, reg);
      }
      el.addEventListener("mouseenter", activate);
      el.addEventListener("click", activate);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });

    mount.querySelectorAll(".hgq-color-map-hit").forEach((el) => {
      const wrap = el.closest(".hgq-color-map-wrap");
      const img = wrap && wrap.querySelector(".hgq-color-map-img");
      const hi = wrap && wrap.querySelector(".hgq-color-map-highlight");
      let maskPack = null;
      let hoverZone = "";
      let sampleCtx = null;
      if (img) {
        const ensureMask = () => {
          if (!maskPack && img.naturalWidth && img.naturalHeight) {
            maskPack = buildColorMapMasks(img);
          }
          if (!sampleCtx && img.naturalWidth && img.naturalHeight) {
            const cvs = document.createElement("canvas");
            cvs.width = img.naturalWidth;
            cvs.height = img.naturalHeight;
            sampleCtx = cvs.getContext("2d", { willReadFrequently: true });
            if (sampleCtx) sampleCtx.drawImage(img, 0, 0);
          }
        };
        if (img.complete) ensureMask();
        else img.addEventListener("load", ensureMask, { once: true });
      }

      if (img && hi) {
        const bootSync = () => syncColorMapHighlightOverlay(wrap, img, hi);
        if (img.complete) bootSync();
        else img.addEventListener("load", bootSync, { once: true });
      }

      function zoneFromEvent(evt) {
        if (!wrap || !img || !img.naturalWidth || !img.naturalHeight) return "";
        const rect = img.getBoundingClientRect();
        if (!rect.width || !rect.height) return "";
        const x = evt.clientX - rect.left;
        const y = evt.clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) return "";
        if (!sampleCtx) {
          const cvs = document.createElement("canvas");
          cvs.width = img.naturalWidth;
          cvs.height = img.naturalHeight;
          sampleCtx = cvs.getContext("2d", { willReadFrequently: true });
          if (sampleCtx) sampleCtx.drawImage(img, 0, 0);
        }
        if (!sampleCtx) return "";
        const px = Math.floor((x / rect.width) * img.naturalWidth);
        const py = Math.floor((y / rect.height) * img.naturalHeight);
        const sx = Math.max(0, px - 1);
        const sy = Math.max(0, py - 1);
        const sw = Math.min(3, img.naturalWidth - sx);
        const sh = Math.min(3, img.naturalHeight - sy);
        const d = sampleCtx.getImageData(sx, sy, sw, sh).data;
        let rs = 0;
        let gs = 0;
        let bs = 0;
        let as = 0;
        const n = sw * sh;
        for (let i = 0; i < d.length; i += 4) {
          rs += d[i];
          gs += d[i + 1];
          bs += d[i + 2];
          as += d[i + 3];
        }
        return classifyZoneByRgb(rs / n, gs / n, bs / n, as / n);
      }

      el.addEventListener("mousemove", (evt) => {
        const z = zoneFromEvent(evt);
        if (!z) {
          hoverZone = "";
          el.style.cursor = "default";
          clearZoneHighlight(hi);
          return;
        }
        el.style.cursor = "pointer";
        if (z !== hoverZone) {
          hoverZone = z;
          if (!maskPack && img && img.naturalWidth) maskPack = buildColorMapMasks(img);
          paintZoneHighlight(hi, maskPack, z);
          syncColorMapHighlightOverlay(wrap, img, hi);
        }
      });

      el.addEventListener("mouseleave", () => {
        hoverZone = "";
        el.style.cursor = "default";
        clearZoneHighlight(hi);
      });

      el.addEventListener("click", (evt) => {
        const wrap = el.closest(".hgq-color-map-wrap");
        if (!wrap) return;
        const species = wrap.getAttribute("data-species");
        const spec = data.bodyMap[species];
        if (!spec || !spec.regions || !spec.image) return;
        const img = wrap.querySelector(".hgq-color-map-img");
        if (!img || !img.naturalWidth || !img.naturalHeight) return;
        const zone = zoneFromEvent(evt);
        if (!zone) return;
        const reg = spec.regions.find((x0) => String(x0.zone || "").toLowerCase() === zone);
        if (!reg) return;
        showTip(species, reg);
      });
    });
  }

  let quizState = { items: [], index: 0, correct: 0, wrongDiet: false };

  function pickQuizThree(sp) {
    const pool = (data.quizzes || []).filter((q) => Array.isArray(q.tags) && q.tags.indexOf(sp) >= 0);
    const src = pool.length >= 3 ? pool : data.quizzes || [];
    return shuffle(src).slice(0, 3);
  }

  function renderQuizPanel() {
    return `
      <div class="hgq-quiz" id="hgqQuizRoot">
        <p class="muted small" id="hgqQuizScope">当前闯关范围：<strong>猫猫</strong>（题目优先匹配该物种）</p>
        <div class="hgq-quiz-intro">
          <p>每次随机 <strong>3</strong> 题，答完看解析。连续多天完成可解锁称号（本地记录）。</p>
          <button type="button" class="btn secondary" id="hgqQuizStart">开始闯关</button>
        </div>
        <div class="hgq-quiz-play" id="hgqQuizPlay" hidden></div>
        <div class="hgq-quiz-result" id="hgqQuizResult" hidden></div>
        <div class="hgq-badge-row" id="hgqBadgeRow" aria-live="polite"></div>
      </div>`;
  }

  function showBadges(streak) {
    const row = document.getElementById("hgqBadgeRow");
    if (!row || !data.badges) return;
    const earned = data.badges.filter((b) => streak >= b.needStreak);
    row.innerHTML =
      `<span class="hgq-streak">连续完成 streak：<strong>${streak}</strong> 天</span>` +
      earned.map((b) => `<span class="hgq-badge">${esc(b.title)}</span>`).join("");
  }

  function updateStreakAfterRound(scoreGood) {
    const t = todayISO();
    let streak = parseInt(localStorage.getItem(STORAGE.streak) || "0", 10) || 0;
    const lastGood = localStorage.getItem(STORAGE.lastGood) || "";

    if (!scoreGood) {
      try {
        localStorage.setItem(STORAGE.streak, "0");
        localStorage.setItem(STORAGE.lastPlay, t);
      } catch (e) {
        /* ignore */
      }
      showBadges(0);
      return;
    }

    if (lastGood === t) {
      showBadges(streak);
      return;
    }

    if (lastGood === yesterdayISO()) {
      streak += 1;
    } else {
      streak = 1;
    }
    try {
      localStorage.setItem(STORAGE.streak, String(streak));
      localStorage.setItem(STORAGE.lastGood, t);
      localStorage.setItem(STORAGE.lastPlay, t);
    } catch (e) {
      /* ignore */
    }
    showBadges(streak);
  }

  function triggerConfetti() {
    const box = document.createElement("div");
    box.className = "hgq-confetti";
    box.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 28; i++) {
      const s = document.createElement("span");
      s.style.left = `${Math.random() * 100}%`;
      s.style.animationDelay = `${Math.random() * 0.4}s`;
      box.appendChild(s);
    }
    mount.appendChild(box);
    setTimeout(() => box.remove(), 2200);
  }

  function renderQuizQuestion() {
    const play = document.getElementById("hgqQuizPlay");
    const q = quizState.items[quizState.index];
    if (!q || !play) return;
    const opts = q.options
      .map(
        (o, i) => `
      <button type="button" class="btn secondary soft hgq-opt" data-idx="${i}">${esc(o)}</button>`
      )
      .join("");
    play.innerHTML = `
      <p class="hgq-q-meta">${q.type === "roleplay" ? "假如我是它 · " : "读心术 · "}第 ${quizState.index + 1} / ${quizState.items.length} 题</p>
      <p class="hgq-q-text">${esc(q.question)}</p>
      <div class="hgq-q-opts">${opts}</div>`;
    play.hidden = false;
    play.querySelectorAll(".hgq-opt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        const ok = idx === q.correct_index;
        if (ok) quizState.correct += 1;
        if (!ok && q.dietRelated) quizState.wrongDiet = true;
        btn.classList.add(ok ? "is-correct" : "is-wrong");
        play.querySelectorAll(".hgq-opt").forEach((b) => {
          b.disabled = true;
          const bi = parseInt(b.getAttribute("data-idx"), 10);
          if (bi === q.correct_index) b.classList.add("is-correct");
        });
        setTimeout(() => {
          quizState.index += 1;
          if (quizState.index >= quizState.items.length) finishQuiz();
          else renderQuizQuestion();
        }, 650);
      });
    });
  }

  function finishQuiz() {
    const play = document.getElementById("hgqQuizPlay");
    const res = document.getElementById("hgqQuizResult");
    const intro = document.querySelector(".hgq-quiz-intro");
    if (intro) intro.hidden = true;
    if (play) play.hidden = true;
    if (!res) return;
    const n = quizState.items.length;
    const c = quizState.correct;
    const good = c >= 2;
    if (quizState.wrongDiet) {
      try {
        localStorage.setItem(STORAGE.weakDiet, "1");
      } catch (e) {
        /* ignore */
      }
    }
    updateStreakAfterRound(good);
    if (good) triggerConfetti();
    res.hidden = false;
    res.innerHTML = `
      <p class="hgq-result-score">本轮答对 <strong>${c}</strong> / ${n}</p>
      <p class="muted small">${good ? "太棒了！继续保持观察与记录的习惯。" : "没关系，看看解析下次更稳～"}</p>
      <div class="hgq-result-explain">
        ${quizState.items
          .map(
            (q) => `
          <details class="hgq-ex-item">
            <summary>${esc(q.question.slice(0, 36))}…</summary>
            <p class="small">${esc(q.explanation)}</p>
          </details>`
          )
          .join("")}
      </div>
      <button type="button" class="btn secondary" id="hgqQuizAgain">再来一轮</button>`;
    document.getElementById("hgqQuizAgain").addEventListener("click", () => {
      res.hidden = true;
      startQuizRound();
    });
  }

  function startQuizRound() {
    quizState = { items: pickQuizThree(hgqSpecies), index: 0, correct: 0, wrongDiet: false };
    const intro = document.querySelector(".hgq-quiz-intro");
    const res = document.getElementById("hgqQuizResult");
    if (res) res.hidden = true;
    if (intro) intro.hidden = true;
    renderQuizQuestion();
  }

  function bindQuiz() {
    const start = document.getElementById("hgqQuizStart");
    if (start) start.addEventListener("click", () => startQuizRound());
    const streak = parseInt(localStorage.getItem(STORAGE.streak) || "0", 10) || 0;
    showBadges(streak);
  }

  async function renderWeather() {
    const el = document.getElementById("hgqWeatherContent");
    if (!el) return;
    el.innerHTML = `<p class="muted small">正在获取天气与季节提示…</p>`;
    const line = await fetchWeatherLine();
    const sea = seasonTip();
    el.innerHTML = `<p class="hgq-weather-line">${esc(line)}</p><p class="hgq-season-line">${esc(sea)}</p>`;
  }

  function buildHTML() {
    const sp = hgqSpecies;
    return `
      <div class="hgq-inner">
        ${renderUnifiedToolbar()}
        <div class="hgq-panels">
          <section class="hgq-panel is-active" data-hgq-panel="map" role="tabpanel" aria-labelledby="hgqTabMap">
            ${renderBodyMapBlock()}
          </section>
          <section class="hgq-panel" data-hgq-panel="poop" role="tabpanel" aria-labelledby="hgqTabPoop" hidden>
            <div id="hgqPoopHost">${renderPoopCardsHost(sp)}</div>
          </section>
          <section class="hgq-panel" data-hgq-panel="body" role="tabpanel" aria-labelledby="hgqTabBody" hidden>
            <div id="hgqBodyHost">${renderBodyCardsHost(sp)}</div>
          </section>
          <section class="hgq-panel" data-hgq-panel="quiz" role="tabpanel" aria-labelledby="hgqTabQuiz" hidden>
            ${renderQuizPanel()}
          </section>
        </div>
      </div>`;
  }

  async function init() {
    mount = document.getElementById("healthGraphQuizMount");
    if (!mount) return;
    try {
      const r = await fetch("/data/health-graph-quiz.json");
      data = await r.json();
    } catch (e) {
      mount.innerHTML = `<p class="muted">内容加载失败，请稍后刷新。</p>`;
      return;
    }
    hgqSpecies = "cat";
    hgqMainTab = "map";
    mount.innerHTML = buildHTML();
    bindUnifiedToolbar();
    bindBodyMap();
    bindQuiz();
    refreshCardPanels();
    updateQuizScopeLabel();
    updateSilhouetteSpeciesVisibility();
    selectEarsForSpecies("cat");
    showBadges(parseInt(localStorage.getItem(STORAGE.streak) || "0", 10) || 0);
  }

  global.CuraHealthGraphQuiz = { init };
})(typeof window !== "undefined" ? window : globalThis);
