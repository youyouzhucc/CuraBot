#!/usr/bin/env node
"use strict";

require("dotenv").config();

try {
  const proxyUrl =
    (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "").trim();
  if (proxyUrl) {
    let undiciMod = null;
    try {
      undiciMod = require("node:undici");
    } catch (_) {
      try {
        undiciMod = require("undici");
      } catch (_) {
        undiciMod = null;
      }
    }
    if (undiciMod && undiciMod.setGlobalDispatcher && undiciMod.ProxyAgent) {
      undiciMod.setGlobalDispatcher(new undiciMod.ProxyAgent(proxyUrl));
      console.log(`[probe] proxy=${proxyUrl}`);
    } else {
      const envProxy = String(process.env.NODE_USE_ENV_PROXY || "").trim();
      if (envProxy === "1" || envProxy.toLowerCase() === "true") {
        console.log("[probe] using NODE_USE_ENV_PROXY=1 (native env proxy mode)");
      } else {
        console.log("[probe] proxy requested but undici unavailable; set NODE_USE_ENV_PROXY=1");
      }
    }
  }
} catch (e) {
  console.log(`[probe] proxy setup skipped: ${e && e.message ? e.message : String(e)}`);
}

async function main() {
  const key = String(process.env.GEMINI_API_KEY || "").trim();
  const rawBase = String(process.env.GEMINI_BASE_URL || "").trim().replace(/\/$/, "");
  const model = String(process.env.GEMINI_MODEL || "gemini-1.5-pro").trim();

  if (!key) {
    console.error("[probe] 缺少 GEMINI_API_KEY");
    process.exitCode = 2;
    return;
  }
  if (!rawBase) {
    console.error("[probe] 缺少 GEMINI_BASE_URL");
    process.exitCode = 2;
    return;
  }

  const candidates = [
    rawBase,
    `${rawBase}/google`,
    `${rawBase}/gemini`,
    `${rawBase}/api`,
    `${rawBase}/googleai`,
  ];
  const uniqueCandidates = [...new Set(candidates)];
  const body = {
    contents: [{ parts: [{ text: "ping" }] }],
    generationConfig: { maxOutputTokens: 16 },
  };

  console.log(`[probe] model=${model}`);
  let hasSuccess = false;

  for (const base of uniqueCandidates) {
    const url = `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), 8000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      const preview = text.replace(/\s+/g, " ").slice(0, 200);
      console.log(`\nBASE=${base}`);
      console.log(`STATUS=${res.status}`);
      console.log(`BODY=${preview}`);
      if (res.ok) hasSuccess = true;
    } catch (err) {
      clearTimeout(timer);
      console.log(`\nBASE=${base}`);
      console.log(`FETCH_ERROR=${err && err.message ? err.message : String(err)}`);
    }
  }

  if (!hasSuccess) {
    console.log("\n[probe] 所有候选路径都未成功，优先排查网络链路/代理服务可用性。");
  } else {
    console.log("\n[probe] 已发现可用路径，请把对应 BASE 写入 GEMINI_BASE_URL。");
  }
}

main();

