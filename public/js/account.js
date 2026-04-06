/**
 * 注册登录与毛孩子档案（最多 6 条）；顶栏展示「毛孩子」与头像条，未登录仅一个「+」位，点添加需登录。
 */
(function (global) {
  const TOKEN_KEY = "curabot_auth_token";
  const SELECTED_PET_KEY = "curabot_selected_pet_id";

  /** 用户从「+」进入登录/注册成功后，自动打开添加档案弹窗 */
  let pendingOpenPetModalAfterAuth = false;
  let petAvatarObjectUrl = null;
  /** @type {{ cat: Array<{label:string}>, dog: Array<{label:string}> } | null} */
  let petBreedsData = null;

  function isLikelyDevMachineHostname(hostname) {
    const h = String(hostname || "").toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
    const raw = String(hostname || "").trim();
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(raw)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(raw)) return true;
    return false;
  }

  /**
   * 与 app.js detectApiBase 一致：静态页/Live Server 等端口请求须指向本机 Node（默认 :3000）。
   * 优先使用 window.CURABOT_API_BASE（由 loadKnowledge 后注入）。
   */
  function getApiBase() {
    if (typeof window === "undefined") return "";
    const manual = window.CURABOT_API_BASE;
    if (manual != null && String(manual).trim() !== "") return String(manual).replace(/\/$/, "");
    try {
      const loc = window.location;
      if (loc.protocol === "file:") return "http://127.0.0.1:3000";
      const host = loc.hostname;
      const port = loc.port || "";
      if (!isLikelyDevMachineHostname(host)) return "";
      if (port === "3000" || port === "") return "";
      return "http://127.0.0.1:3000";
    } catch (e) {
      return "";
    }
  }

  function apiUrl(path) {
    const base = getApiBase();
    const p = path.indexOf("/") === 0 ? path : "/" + path;
    return base ? base + p : p;
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  function loadSelectedPetId() {
    try {
      return localStorage.getItem(SELECTED_PET_KEY) || null;
    } catch (e) {
      return null;
    }
  }

  function saveSelectedPetId(id) {
    try {
      if (id) localStorage.setItem(SELECTED_PET_KEY, id);
      else localStorage.removeItem(SELECTED_PET_KEY);
    } catch (e) {
      /* ignore */
    }
    state.selectedPetId = id || null;
  }

  const state = {
    user: null,
    pets: [],
    selectedPetId: null,
  };

  async function apiFetch(path, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body != null && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const tok = getToken();
    if (tok) headers.Authorization = "Bearer " + tok;
    const method = (opts.method || "GET").toUpperCase();
    const fetchOpts = Object.assign({}, opts, { headers });
    if (method === "GET" && fetchOpts.cache == null) fetchOpts.cache = "no-store";
    let r;
    try {
      r = await fetch(apiUrl(path), fetchOpts);
    } catch (e) {
      const err = new Error("network");
      err.code = "network";
      err.cause = e;
      throw err;
    }
    const text = await r.text();
    let j = {};
    if (text) {
      try {
        j = JSON.parse(text);
      } catch (e) {
        if (!r.ok) {
          j = { error: "bad_response" };
        } else {
          const parseErr = new Error("bad_response");
          parseErr.code = "bad_response";
          throw parseErr;
        }
      }
    }
    if (!r.ok) {
      const code =
        j.error ||
        (r.status === 404 ? "not_found" : r.status >= 500 ? "server_error" : "request_failed");
      const err = new Error(code);
      err.status = r.status;
      err.body = j;
      throw err;
    }
    return j;
  }

  function defaultPetAvatarUrl(species) {
    return species === "dog" ? "/images/hero-dog.png" : "/images/hero-cat.png";
  }

  async function loadPetBreeds() {
    try {
      const r = await fetch(apiUrl("/data/pet-breeds.json"), { cache: "no-store" });
      if (!r.ok) throw new Error("load");
      petBreedsData = await r.json();
    } catch (e) {
      petBreedsData = { cat: [], dog: [] };
    }
  }

  function fillBreedSelect(species) {
    const sel = document.getElementById("petBreed");
    if (!sel || !petBreedsData) return;
    const key = species === "dog" ? "dog" : "cat";
    const list = petBreedsData[key] || [];
    const prev = sel.value;
    sel.innerHTML = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "请选择品种（可选）";
    sel.appendChild(opt0);
    const useGroups = list.length > 0 && list[0].group != null && Array.isArray(list[0].breeds);
    if (useGroups) {
      list.forEach((g) => {
        const og = document.createElement("optgroup");
        og.label = g.group || "";
        (g.breeds || []).forEach((label) => {
          const o = document.createElement("option");
          o.value = label;
          o.textContent = label;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
    } else {
      list.forEach((b) => {
        const o = document.createElement("option");
        o.value = b.label;
        o.textContent = b.label;
        sel.appendChild(o);
      });
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }

  /**
   * 由出生日期推算展示文案与年龄段（与物种相关：猫/狗老年阈值不同）。
   * @returns {{ text: string, age_band: string | null, displayLine: string }}
   */
  function computeAgeFromBirth(birthIso, species) {
    const emptyHint = { text: "—", age_band: null, displayLine: "填写生日后自动显示" };
    if (!birthIso || !/^\d{4}-\d{2}-\d{2}$/.test(String(birthIso).trim())) {
      return emptyHint;
    }
    const birthIsoTrim = String(birthIso).trim();
    const b = new Date(birthIsoTrim + "T12:00:00");
    const now = new Date();
    if (b > now) {
      return { text: "日期无效", age_band: null, displayLine: "日期无效" };
    }
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) months -= 1;
    if (months < 0) return emptyHint;
    const years = Math.floor(months / 12);
    const mo = months % 12;
    let text;
    if (years < 1) {
      text = mo <= 0 ? "约 1 个月内" : "约 " + mo + " 个月";
    } else {
      text = mo === 0 ? "约 " + years + " 岁" : "约 " + years + " 岁 " + mo + " 个月";
    }
    const sp = species === "dog" ? "dog" : "cat";
    let age_band = null;
    if (months < 12) age_band = "young";
    else {
      const y = years + mo / 12;
      if (sp === "dog") age_band = y < 8 ? "adult" : "senior";
      else age_band = y < 11 ? "adult" : "senior";
    }
    return { text, age_band, displayLine: text };
  }

  function updatePetAgeDisplay() {
    const bdEl = document.getElementById("petBirthDate");
    const spEl = document.getElementById("petSpecies");
    const bd = bdEl && bdEl.value;
    const species = spEl && spEl.value === "dog" ? "dog" : "cat";
    const ageDisp = document.getElementById("petAgeDisplay");
    const ageInfo = computeAgeFromBirth(bd, species);
    if (ageDisp) ageDisp.textContent = bd ? ageInfo.displayLine : "填写生日后自动显示";
  }

  function petToChatPreset(pet) {
    if (!pet) return null;
    const o = { species: pet.species };
    if (pet.gender) o.gender = pet.gender;
    if (pet.neuter) o.neuter = pet.neuter;
    if (pet.age_band) o.ageBand = pet.age_band;
    if (pet.nickname) o.petNickname = pet.nickname;
    if (pet.breed) o.petBreed = pet.breed;
    if (pet.weight_kg != null && pet.weight_kg !== "") o.weightKg = pet.weight_kg;
    if (pet.notes) o.petNotes = pet.notes;
    return o;
  }

  function getPresetForSpecies(species) {
    const sp = species === "dog" ? "dog" : "cat";
    const id = state.selectedPetId || loadSelectedPetId();
    let pet = state.pets.find((p) => p.id === id);
    if (!pet || pet.species !== sp) {
      pet = state.pets.find((p) => p.species === sp);
    }
    if (!pet) return { species: sp };
    return petToChatPreset(pet);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const AGE_LABELS = { young: "幼年（约 1 岁前）", adult: "成年", senior: "老年" };
  const GENDER_LABELS = { male: "男生", female: "女生" };
  const NEUTER_LABELS = { yes: "已绝育", no: "未绝育", unknown: "不清楚" };

  function petSummaryLine(p) {
    const bits = [p.species === "dog" ? "狗狗" : "猫猫"];
    if (p.breed) bits.push(p.breed);
    if (p.age_band && AGE_LABELS[p.age_band]) bits.push(AGE_LABELS[p.age_band]);
    return bits.join(" · ");
  }

  /** 从接口对象取昵称字段（兼容大小写差异） */
  function pickNicknameFromUser(u) {
    if (!u || typeof u !== "object") return "";
    const keys = ["nickname", "nickName", "nick"];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (u[k] != null) {
        const s = String(u[k]).trim();
        if (s) return s;
      }
    }
    return "";
  }

  /** 统一把 /api/auth 返回的 user 压成纯对象，保留接口里其它字段，并强制带上 nickname */
  function normalizeServerUser(raw) {
    if (!raw || typeof raw !== "object") return null;
    let nickname = pickNicknameFromUser(raw);
    if (!nickname && raw.nickname !== undefined && raw.nickname !== null) {
      const s = String(raw.nickname).trim();
      if (s) nickname = s;
    }
    return Object.assign({}, raw, {
      id: raw.id,
      email: raw.email != null ? String(raw.email) : "",
      nickname: nickname || "",
    });
  }

  function renderPetTileTopbar(p, selected) {
    const imgSrc = (p.avatar_url && String(p.avatar_url).trim()) || defaultPetAvatarUrl(p.species);
    return `
      <div class="pet-avatar-tile pet-avatar-tile--topbar ${selected ? "is-selected" : ""}" data-pet-id="${escapeHtml(p.id)}" role="group" tabindex="0" aria-pressed="${selected ? "true" : "false"}">
        <div class="pet-avatar-ring-wrap">
          <button type="button" class="pet-avatar-ring pet-avatar-ring--edit" data-pet-edit="${escapeHtml(p.id)}" aria-label="编辑 ${escapeHtml(p.nickname || "档案")}">
            <img class="pet-avatar-img" src="${escapeHtml(imgSrc)}" alt="" width="48" height="48" loading="lazy" decoding="async" />
          </button>
          <button type="button" class="pet-avatar-remove" data-pet-del="${escapeHtml(p.id)}" aria-label="删除档案">×</button>
        </div>
      </div>`;
  }

  function renderEmptySlot() {
    return `
      <button type="button" class="pet-slot-empty" aria-label="添加毛孩子">
        <span class="pet-slot-empty-ring" aria-hidden="true"><span class="pet-slot-empty-plus">+</span></span>
      </button>`;
  }

  function onPetAddClick() {
    if (!state.user) {
      pendingOpenPetModalAfterAuth = true;
      openAuthModal("login");
      return;
    }
    openPetModal(null);
  }

  const PET_SLOT_COUNT = 6;

  function buildPetStripHtml() {
    const sel = state.selectedPetId || loadSelectedPetId();
    const list = state.user ? state.pets || [] : [];
    let tiles = "";
    if (!state.user) {
      return renderEmptySlot();
    }
    const n = list.length;
    const max = PET_SLOT_COUNT;
    for (let i = 0; i < n; i++) {
      tiles += renderPetTileTopbar(list[i], list[i].id === sel);
    }
    if (n < max) tiles += renderEmptySlot();
    return tiles;
  }

  function bindTopbarPetEvents() {
    const wrap = document.getElementById("topbarPetBlock");
    if (!wrap) return;
    const list = state.user ? state.pets || [] : [];
    wrap.querySelectorAll(".pet-avatar-tile").forEach((el) => {
      const id = el.getAttribute("data-pet-id");
      el.addEventListener("click", (e) => {
        if (e.target.closest(".pet-avatar-remove") || e.target.closest(".pet-avatar-ring--edit")) return;
        selectPet(id);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectPet(id);
        }
      });
    });
    wrap.querySelectorAll(".pet-avatar-ring--edit").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = b.getAttribute("data-pet-edit");
        const pet = list.find((x) => x.id === id);
        if (pet) openPetModal(pet);
      });
    });
    wrap.querySelectorAll(".pet-avatar-remove").forEach((b) => {
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = b.getAttribute("data-pet-del");
        if (!id) return;
        if (!window.confirm("确定删除该档案？此操作不可撤销。")) return;
        try {
          await apiFetch("/api/pets/" + encodeURIComponent(id), { method: "DELETE" });
          if (state.selectedPetId === id) {
            saveSelectedPetId(null);
          }
          await refreshPets();
          renderTopbar();
        } catch (err) {
          alert("删除失败：" + (err.message || ""));
        }
      });
    });
    wrap.querySelectorAll(".pet-slot-empty").forEach((btn) => {
      btn.addEventListener("click", () => onPetAddClick());
    });
  }

  function updateSiteAccountLinksVisibility() {
    const el = document.getElementById("siteAccountLinks");
    if (el) el.hidden = !state.user;
  }

  function renderTopbar() {
    const host = document.getElementById("topbarAuth");
    if (!host) return;
    const tilesHtml = buildPetStripHtml();
    const petBlock = `
      <div class="topbar-pet-block" id="topbarPetBlock" aria-labelledby="label-pet-archive">
        <span class="topbar-pet-label" id="label-pet-archive">毛孩子</span>
        <div class="pet-archive-grid pet-archive-grid--avatars topbar-pet-grid" id="topbarPetGrid">${tilesHtml}</div>
      </div>`;
    host.innerHTML = `<div class="topbar-auth-inner">${petBlock}</div>`;
    bindTopbarPetEvents();
    updateSiteAccountLinksVisibility();
  }

  function updateAuthSwitchLabel(mode) {
    const b = document.getElementById("btnAuthSwitchMode");
    if (!b) return;
    if (mode === "register") {
      b.textContent = "已有账号？去登录";
      b.setAttribute("data-auth-mode-target", "login");
    } else {
      b.textContent = "没有账号？去注册";
      b.setAttribute("data-auth-mode-target", "register");
    }
  }

  function openAuthModal(mode) {
    const overlay = document.getElementById("accountModalOverlay");
    const title = document.getElementById("accountModalTitle");
    const form = document.getElementById("accountAuthForm");
    const err = document.getElementById("accountModalError");
    if (!overlay || !form) return;
    if (title) title.textContent = mode === "register" ? "注册账号" : "登录";
    form.dataset.mode = mode;
    updateAuthSwitchLabel(mode);
    if (err) err.textContent = "";
    overlay.hidden = false;
    const email = document.getElementById("accountEmail");
    const pw = document.getElementById("accountPassword");
    const nickWrap = document.getElementById("accountNicknameWrap");
    const nick = document.getElementById("accountNickname");
    if (email) email.value = "";
    if (nick) nick.value = "";
    if (nickWrap) nickWrap.hidden = mode !== "register";
    if (pw) {
      pw.value = "";
      pw.autocomplete = mode === "register" ? "new-password" : "current-password";
    }
  }

  function closeAuthModal() {
    const overlay = document.getElementById("accountModalOverlay");
    if (overlay) overlay.hidden = true;
  }

  function dismissAuthModal() {
    pendingOpenPetModalAfterAuth = false;
    closeAuthModal();
  }

  function openNicknameModal() {
    const overlay = document.getElementById("nicknameModalOverlay");
    const input = document.getElementById("nicknameEditInput");
    const err = document.getElementById("nicknameModalError");
    if (!overlay || !input) return;
    if (err) err.textContent = "";
    input.value = state.user && state.user.nickname ? String(state.user.nickname).trim() : "";
    overlay.hidden = false;
    setTimeout(() => input.focus(), 50);
  }

  function closeNicknameModal() {
    const overlay = document.getElementById("nicknameModalOverlay");
    if (overlay) overlay.hidden = true;
  }

  async function submitNickname(e) {
    e.preventDefault();
    const input = document.getElementById("nicknameEditInput");
    const errEl = document.getElementById("nicknameModalError");
    const v = input && input.value ? input.value.trim() : "";
    if (errEl) errEl.textContent = "";
    if (!v) {
      if (errEl) errEl.textContent = "请填写昵称";
      return;
    }
    try {
      const j = await apiFetch("/api/auth/profile", {
        method: "PUT",
        body: JSON.stringify({ nickname: v }),
      });
      if (j.user) state.user = normalizeServerUser(Object.assign({}, state.user, j.user)) || state.user;
      closeNicknameModal();
      renderTopbar();
    } catch (err) {
      const map = {
        invalid_nickname: "昵称需为 1–20 个字",
        nickname_taken: "该昵称已被使用",
        nickname_required: "请填写昵称",
      };
      const code = err.body && err.body.error;
      if (errEl) errEl.textContent = map[code] || err.message || "保存失败";
    }
  }

  function clearPetAvatarObjectUrl() {
    if (petAvatarObjectUrl) {
      try {
        URL.revokeObjectURL(petAvatarObjectUrl);
      } catch (e) {
        /* ignore */
      }
      petAvatarObjectUrl = null;
    }
  }

  function syncPetAvatarPreviewFromState() {
    const speciesEl = document.getElementById("petSpecies");
    const hidden = document.getElementById("petAvatarUrl");
    const fileEl = document.getElementById("petAvatarFile");
    const prev = document.getElementById("petAvatarPreview");
    if (!speciesEl || !prev) return;
    const sp = speciesEl.value === "dog" ? "dog" : "cat";
    const url = hidden && hidden.value ? hidden.value.trim() : "";
    if (fileEl && fileEl.files && fileEl.files[0]) {
      clearPetAvatarObjectUrl();
      petAvatarObjectUrl = URL.createObjectURL(fileEl.files[0]);
      prev.src = petAvatarObjectUrl;
      return;
    }
    prev.src = url || defaultPetAvatarUrl(sp);
  }

  async function openPetModal(pet) {
    const overlay = document.getElementById("petModalOverlay");
    if (!overlay) return;
    const form = document.getElementById("petForm");
    if (!form) return;
    await loadPetBreeds();
    clearPetAvatarObjectUrl();
    const fileEl = document.getElementById("petAvatarFile");
    if (fileEl) fileEl.value = "";
    form.dataset.petId = pet ? pet.id : "";
    document.getElementById("petNickname").value = pet ? pet.nickname || "" : "";
    document.getElementById("petSpecies").value = pet ? pet.species : "cat";
    fillBreedSelect(document.getElementById("petSpecies").value);
    const breedEl = document.getElementById("petBreed");
    const savedBreed = pet && pet.breed ? String(pet.breed).trim() : "";
    if (savedBreed && breedEl) {
      const exists = [...breedEl.options].some((o) => o.value === savedBreed);
      if (!exists) {
        const o = document.createElement("option");
        o.value = savedBreed;
        o.textContent = savedBreed;
        breedEl.appendChild(o);
      }
      breedEl.value = savedBreed;
    } else if (breedEl) breedEl.value = "";
    document.getElementById("petGender").value = pet && pet.gender ? pet.gender : "";
    document.getElementById("petNeuter").value = pet && pet.neuter ? pet.neuter : "";
    document.getElementById("petWeight").value =
      pet && pet.weight_kg != null && pet.weight_kg !== "" ? String(pet.weight_kg) : "";
    document.getElementById("petNotes").value = pet ? pet.notes || "" : "";
    const bd = document.getElementById("petBirthDate");
    if (bd) bd.value = pet && pet.birth_date ? String(pet.birth_date).slice(0, 10) : "";
    const hid = document.getElementById("petAvatarUrl");
    if (hid) hid.value = pet && pet.avatar_url ? String(pet.avatar_url).trim() : "";
    document.getElementById("petModalTitle").textContent = pet ? "编辑档案" : "添加毛孩子";
    syncPetAvatarPreviewFromState();
    updatePetAgeDisplay();
    overlay.hidden = false;
  }

  function closePetModal() {
    const overlay = document.getElementById("petModalOverlay");
    if (overlay) overlay.hidden = true;
    clearPetAvatarObjectUrl();
    const fileEl = document.getElementById("petAvatarFile");
    if (fileEl) fileEl.value = "";
  }

  async function uploadPetAvatarFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    const tok = getToken();
    const headers = {};
    if (tok) headers.Authorization = "Bearer " + tok;
    const r = await fetch(apiUrl("/api/pets/avatar"), {
      method: "POST",
      headers,
      body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error || "upload_failed");
      err.body = j;
      throw err;
    }
    return j.url;
  }

  async function submitAuth(e) {
    e.preventDefault();
    const form = document.getElementById("accountAuthForm");
    const errEl = document.getElementById("accountModalError");
    const mode = form && form.dataset.mode;
    const email = (document.getElementById("accountEmail") || {}).value || "";
    const password = (document.getElementById("accountPassword") || {}).value || "";
    const nicknameRaw = (document.getElementById("accountNickname") || {}).value || "";
    if (errEl) errEl.textContent = "";
    const shouldOpenPetAfter = pendingOpenPetModalAfterAuth;
    try {
      if (mode === "register") {
        const j = await apiFetch("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({ email, password, nickname: nicknameRaw.trim() || undefined }),
        });
        if (j.token) setToken(j.token);
        state.user = normalizeServerUser(j.user);
      } else {
        const j = await apiFetch("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
        if (j.token) setToken(j.token);
        state.user = normalizeServerUser(j.user);
      }
      /* 再拉一次 /me，与 ensureUserNickname、DB 读回一致 */
      try {
        const me = await apiFetch("/api/auth/me", { method: "GET" });
        if (me.loggedIn && me.user) state.user = normalizeServerUser(me.user);
      } catch (e2) {
        /* ignore */
      }
      pendingOpenPetModalAfterAuth = false;
      closeAuthModal();
      await refreshPets();
      renderTopbar();
      if (shouldOpenPetAfter) {
        openPetModal(null);
      }
    } catch (err) {
      const map = {
        network:
          "无法连接账号服务。请在本机运行 npm start 启动 API（默认 http://127.0.0.1:3000）。若网页与 API 不同端口，请在页面中设置 window.CURABOT_API_BASE。",
        bad_response:
          "服务器返回了非接口数据（常为 404 页面）。请在本项目目录执行 npm start 启动最新后端（需 Node 22.5+），并结束占用 3000 端口的旧进程；或用 Live Server 打开页面时保持 Node 在 http://127.0.0.1:3000 运行。",
        not_found:
          "未找到账号接口。请确认已用本仓库 server.js 启动 API（含 POST /api/auth/register），勿使用仅含对话接口的旧进程。",
        server_error: "服务器暂时不可用，请稍后重试。",
        server: "服务器错误，请稍后重试。",
        request_failed: "请求失败，请检查网络与 API 地址。",
        invalid_email: "邮箱格式不正确",
        invalid_password: "密码至少 8 位",
        email_taken: "该邮箱已注册，请直接登录",
        invalid_credentials: "邮箱或密码错误",
        invalid_nickname: "昵称需为 1–20 个字",
        nickname_taken: "该昵称已被使用，请换一个",
        sqlite_unavailable: "服务器未启用数据库（需 Node 22.5+ 与本站 API）",
      };
      const code = err.code || (err.body && err.body.error) || err.message;
      if (errEl) errEl.textContent = map[code] || err.message || "操作失败";
    }
  }

  async function submitPet(e) {
    e.preventDefault();
    const form = document.getElementById("petForm");
    const id = form && form.dataset.petId;
    const fileEl = document.getElementById("petAvatarFile");
    const hidden = document.getElementById("petAvatarUrl");
    let avatar_url = hidden && hidden.value ? hidden.value.trim() : "";
    try {
      if (fileEl && fileEl.files && fileEl.files[0]) {
        avatar_url = await uploadPetAvatarFile(fileEl.files[0]);
        if (hidden) hidden.value = avatar_url;
      }
    } catch (upErr) {
      alert("头像上传失败：" + (upErr.message || ""));
      return;
    }
    const birthEl = document.getElementById("petBirthDate");
    const birthRaw = birthEl && birthEl.value ? birthEl.value.trim() : "";
    const species = document.getElementById("petSpecies").value;
    const ageInfo = computeAgeFromBirth(birthRaw, species);
    const body = {
      nickname: document.getElementById("petNickname").value,
      species,
      breed: document.getElementById("petBreed").value,
      gender: document.getElementById("petGender").value || null,
      neuter: document.getElementById("petNeuter").value || null,
      age_band: birthRaw ? ageInfo.age_band : null,
      weight_kg: document.getElementById("petWeight").value,
      notes: document.getElementById("petNotes").value,
      avatar_url: avatar_url || null,
      birth_date: birthRaw || null,
    };
    try {
      if (id) {
        await apiFetch("/api/pets/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/api/pets", { method: "POST", body: JSON.stringify(body) });
      }
      closePetModal();
      await refreshPets();
      renderTopbar();
    } catch (err) {
      const map = { pet_limit: "最多 6 个档案", invalid_nickname: "请填写昵称（1–32 字）" };
      const code = err.body && err.body.error;
      alert(map[code] || err.message || "保存失败");
    }
  }

  async function logout() {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (e) {
      /* ignore */
    }
    setToken(null);
    saveSelectedPetId(null);
    state.user = null;
    state.pets = [];
    renderTopbar();
  }

  function selectPet(id) {
    saveSelectedPetId(id);
    state.selectedPetId = id;
    renderTopbar();
  }

  async function refreshPets() {
    if (!state.user || !getToken()) {
      state.pets = [];
      return;
    }
    try {
      const j = await apiFetch("/api/pets", { method: "GET" });
      state.pets = j.pets || [];
      const sel = loadSelectedPetId();
      if (sel && !state.pets.some((p) => p.id === sel)) {
        saveSelectedPetId(state.pets[0] ? state.pets[0].id : null);
      }
      state.selectedPetId = loadSelectedPetId();
    } catch (e) {
      state.pets = [];
    }
  }

  function bindAccountUiOnce() {
    if (global.__curabotAccountUiBound) return;
    global.__curabotAccountUiBound = true;

    const authForm = document.getElementById("accountAuthForm");
    if (authForm) authForm.addEventListener("submit", submitAuth);
    const petForm = document.getElementById("petForm");
    if (petForm) petForm.addEventListener("submit", submitPet);

    const closeAuth = document.getElementById("accountModalClose");
    if (closeAuth) {
      closeAuth.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dismissAuthModal();
      });
    }
    const closePet = document.getElementById("petModalClose");
    if (closePet) {
      closePet.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePetModal();
      });
    }
    const spEl = document.getElementById("petSpecies");
    if (spEl) {
      spEl.addEventListener("change", () => {
        fillBreedSelect(spEl.value);
        const br = document.getElementById("petBreed");
        if (br) br.value = "";
        syncPetAvatarPreviewFromState();
        updatePetAgeDisplay();
      });
    }
    const avFile = document.getElementById("petAvatarFile");
    if (avFile) avFile.addEventListener("change", () => syncPetAvatarPreviewFromState());
    const bdOnly = document.getElementById("petBirthDate");
    if (bdOnly) {
      bdOnly.addEventListener("input", () => updatePetAgeDisplay());
      bdOnly.addEventListener("change", () => updatePetAgeDisplay());
    }
    const pick = document.getElementById("petAvatarPick");
    if (pick && avFile) {
      pick.addEventListener("click", () => avFile.click());
      pick.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          avFile.click();
        }
      });
    }

    const authSwitch = document.getElementById("btnAuthSwitchMode");
    if (authSwitch) {
      authSwitch.addEventListener("click", (e) => {
        e.preventDefault();
        const next = authSwitch.getAttribute("data-auth-mode-target");
        if (next === "login" || next === "register") openAuthModal(next);
      });
    }

    const accOverlay = document.getElementById("accountModalOverlay");
    if (accOverlay) {
      accOverlay.addEventListener("click", (e) => {
        if (e.target === accOverlay) dismissAuthModal();
      });
    }
    const petOverlay = document.getElementById("petModalOverlay");
    if (petOverlay) {
      petOverlay.addEventListener("click", (e) => {
        if (e.target === petOverlay) closePetModal();
      });
    }

    const nickSite = document.getElementById("btnSiteNickname");
    if (nickSite) {
      nickSite.addEventListener("click", (e) => {
        e.preventDefault();
        openNicknameModal();
      });
    }
    const logoutSite = document.getElementById("btnSiteLogout");
    if (logoutSite) {
      logoutSite.addEventListener("click", async (e) => {
        e.preventDefault();
        if (!window.confirm("确定要退出登录吗？")) return;
        if (!window.confirm("再次确认退出登录？")) return;
        await logout();
      });
    }

    const nickForm = document.getElementById("nicknameForm");
    if (nickForm) nickForm.addEventListener("submit", submitNickname);
    const nickClose = document.getElementById("nicknameModalClose");
    if (nickClose) {
      nickClose.addEventListener("click", (e) => {
        e.preventDefault();
        closeNicknameModal();
      });
    }
    const nickOv = document.getElementById("nicknameModalOverlay");
    if (nickOv) {
      nickOv.addEventListener("click", (e) => {
        if (e.target === nickOv) closeNicknameModal();
      });
    }
  }

  async function init() {
    state.selectedPetId = loadSelectedPetId();
    const tok = getToken();
    state.user = null;
    if (tok) {
      try {
        let j = await apiFetch("/api/auth/me", { method: "GET" });
        if (j.loggedIn && j.user) {
          state.user = normalizeServerUser(j.user);
          /* 若仍无昵称再拉一次（避免偶发序列化/代理丢字段）；仍无则用邮箱前缀仅作展示 */
          if (!pickNicknameFromUser(state.user)) {
            try {
              j = await apiFetch("/api/auth/me", { method: "GET" });
              if (j.loggedIn && j.user) state.user = normalizeServerUser(j.user);
            } catch (e2) {
              /* ignore */
            }
          }
          await refreshPets();
        } else {
          setToken(null);
        }
      } catch (e) {
        const code = (e && (e.code || (e.body && e.body.error))) || "";
        const status = Number(e && e.status) || 0;
        // 仅在明确未授权/会话失效时清理 token，避免临时网络抖动导致“被登出”
        if (status === 401 || code === "unauthorized" || code === "invalid_session") {
          setToken(null);
        }
      }
    }
    renderTopbar();
    bindAccountUiOnce();
  }

  global.CuraAccount = {
    init,
    refreshPets,
    getPresetForSpecies,
    get state() {
      return state;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
