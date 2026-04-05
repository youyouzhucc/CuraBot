/**
 * 本地兜底：基于知识库关键词与急诊红线的科普回复（非 LLM，不能诊断）。
 */
(function (global) {
  function speciesName(sp) {
    return sp === "dog" ? "犬" : "猫";
  }

  function findTopicByText(msg, knowledge, sp) {
    const dk = knowledge && knowledge.dailyKnowledge;
    if (!dk || !dk.modules) return null;
    for (const mod of dk.modules) {
      for (const t of mod.topics || []) {
        if (t.species && t.species.indexOf(sp) === -1) continue;
        const plain = String(t.title || "")
          .replace(/（[^）]*）/g, "")
          .replace(/\([^)]*\)/g, "")
          .trim();
        if (plain.length < 2) continue;
        const needles = [plain, ...plain.split(/[、，。]/).map((s) => s.trim()).filter((s) => s.length >= 2)];
        for (const n of needles) {
          if (n.length >= 2 && msg.indexOf(n) !== -1) return { module: mod, topic: t };
        }
      }
    }
    return null;
  }

  function matchEmergencyLine(msg, knowledge, sp) {
    const rows = (knowledge && knowledge.emergencyRedLines) || [];
    const shortOf = (row) => (row.action || "").slice(0, 220);

    if (sp === "cat" && /(尿不|尿不出|尿闭|无尿|几滴|蹲盆|尿血)/.test(msg) && !/(狗|犬)/.test(msg)) {
      const u = rows.find((r) => r.id === "uro-cat");
      if (u) return { row: u, short: shortOf(u) };
    }
    if (sp === "dog" && /(肚子胀|腹胀|鼓|干呕|呕不出|胃扭转|GDV)/i.test(msg)) {
      const g = rows.find((r) => r.id === "gdv-dog");
      if (g) return { row: g, short: shortOf(g) };
    }
    if (/(喘|呼吸).*(费力|困难|急促)|张口喘|发绀|粘膜.*紫/.test(msg)) {
      const r = rows.find((x) => x.id === "resp-distress");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(抽搐|抽经|癫痫|昏迷|瘫痪|站不起来)/.test(msg)) {
      const r = rows.find((x) => x.id === "neuro-acute");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(大出血|止不住|休克|牙龈白|脚垫凉)/.test(msg)) {
      const r = rows.find((x) => x.id === "hemorrhage-shock");
      if (r) return { row: r, short: shortOf(r) };
    }
    if (/(中毒|老鼠药|防冻液|巧克力|葡萄|木糖醇)/.test(msg)) {
      const r = rows.find((x) => x.id === "toxin-unknown");
      if (r) return { row: r, short: shortOf(r) };
    }
    return null;
  }

  function reply({ message, species, knowledge }) {
    const sp = species === "dog" ? "dog" : "cat";
    const msg = (message || "").trim();
    if (!msg) {
      return {
        text: `可以说说${speciesName(sp)}的食欲、精神、呕吐、大小便里你最担心的一点；紧急情况请直接去医院。`,
        source: "local",
      };
    }

    if (/^(谢谢|感谢|好的|明白|懂了|ok|okay|thx)/i.test(msg)) {
      return { text: "不客气。若症状加重或心里不踏实，建议尽快联系兽医。", source: "local" };
    }

    if (/^(你好|您好|哈喽|嗨|hi|hello|在吗)/i.test(msg)) {
      return {
        text: `你好，我是 CuraBot 健康机器人，当前按「${speciesName(sp)}」来聊。请用一两句话描述最担心的症状或行为；我会给科普级参考，**不能代替兽医诊断**。\n\n你也可以点首页「从这里开始」做系统采集，或问我「急症有哪些」。`,
        source: "local",
      };
    }

    if (/(急症|急诊|红线|立刻去医院|别等)/.test(msg)) {
      return {
        text:
          "急症线索包括：喘得厉害/粘膜发紫发白、猫少尿无尿、狗腹胀干呕、大出血或休克、抽搐或意识不清、可疑中毒等。首页「这些情况要抓紧去医院」有展开说明。**很危险时请直接出发急诊。**",
        source: "local",
        suggestNav: "emergency",
      };
    }

    if (/(分诊|采集|清单|问卷)/.test(msg)) {
      return {
        text: "首页进入「从这里开始」可使用标准化采集与按症状分诊流程，把信息整理给兽医看。",
        source: "local",
        suggestNav: "triageMenu",
      };
    }

    const em = matchEmergencyLine(msg, knowledge, sp);
    if (em && em.row) {
      return {
        text:
          `你描述的情况**可能属于需要尽快就医甚至急诊的范畴**（与「${em.row.title}」相关）。\n\n` +
          `${em.short}${em.short.length >= 220 ? "…" : ""}\n\n` +
          `我无法在线确认是否急症，**请结合 Ta 的实时状态**；若符合任一条，建议尽快联系或前往动物医院。`,
        source: "local",
        suggestNav: "emergency",
      };
    }

    const hit = findTopicByText(msg, knowledge, sp);
    if (hit && hit.topic) {
      const t = hit.topic;
      const sci = (t.science || "").slice(0, 280);
      return {
        text:
          `从日常知识库里，与你描述较接近的条目是「${t.title}」。\n\n` +
          `**科学知识（节选）**：${sci}${(t.science || "").length > 280 ? "…" : ""}\n\n` +
          `**何时看兽医**：${(t.vetWhen || "").slice(0, 200)}${(t.vetWhen || "").length > 200 ? "…" : ""}\n\n` +
          `可点击下方按钮打开完整条目，或在首页日常知识里点同名卡片。`,
        source: "local",
        suggestTopicId: t.id,
      };
    }

    return {
      text:
        `我根据现有资料**没法精确对应**你这句话；可能信息太少或需要当面检查。\n\n` +
        `建议：① 用首页「从这里开始」按步骤描述；② 打开「这些情况要抓紧去医院」对照红线；③ 直接联系兽医说明品种、年龄与症状持续时间。\n\n` +
        `若已配置大模型服务（服务器环境变量 OPENAI_API_KEY），联网对话会更灵活；未配置时由本地知识库兜底。`,
      source: "local",
    };
  }

  global.CuraHealthBotLocal = { reply };
})(typeof window !== "undefined" ? window : globalThis);
