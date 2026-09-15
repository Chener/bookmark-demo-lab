/**
 * ballot-api — single Cloudflare Worker for hub voting.
 * KV binding: BALLOT_KV
 * Secrets: VOTE_SALT, BALLOT_ADMIN_TOKEN
 * Vars: ORIGIN
 *
 * GET  /api/health
 * GET  /api/vote?windowId=
 * POST /api/vote
 * PUT  /api/window   (cron / admin; Bearer BALLOT_ADMIN_TOKEN)
 */

const RL_WINDOW_S = 60;
const RL_MAX = 12;
const COOLDOWN_S = 8;
const BODY_MAX = 4096;
const FP_MAX = 128;
const TALLY_TTL_S = 60 * 60 * 24 * 14;
const VOTED_TTL_MIN_S = 60 * 60 * 24 * 2;

export default {
  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (err) {
      return json(env, request, { ok: false, error: "server_error" }, 500);
    }
  }
};

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    return cors(env, request, new Response(null, { status: 204 }));
  }

  if (path === "/api/health" && request.method === "GET") {
    return json(env, request, { ok: true, service: "ballot-api" });
  }

  if (path === "/api/window" && request.method === "PUT") {
    return putWindow(request, env);
  }

  if (path === "/api/vote" && request.method === "GET") {
    return getTallies(url, request, env);
  }

  if (path === "/api/vote" && request.method === "POST") {
    return postVote(request, env);
  }

  return json(env, request, { ok: false, error: "not_found" }, 404);
}

async function putWindow(request, env) {
  const token = bearer(request);
  const expected = String(env.BALLOT_ADMIN_TOKEN || "");
  if (!expected || token !== expected) {
    return json(env, request, { ok: false, error: "unauthorized" }, 401);
  }
  const body = await readJson(request);
  if (!body || !body.windowId || !body.opensAt || !body.closesAt) {
    return json(env, request, { ok: false, error: "invalid_window" }, 400);
  }
  const snapshot = {
    windowId: String(body.windowId),
    opensAt: String(body.opensAt),
    closesAt: String(body.closesAt),
    periodHours: Number(body.periodHours) || 8,
    candidates: Array.isArray(body.candidates) ? body.candidates : [],
    options: optionsToArrays(body.options)
  };
  await env.BALLOT_KV.put("current-window", JSON.stringify(snapshot), {
    expirationTtl: TALLY_TTL_S
  });
  await env.BALLOT_KV.put("window-meta:" + snapshot.windowId, JSON.stringify(snapshot), {
    expirationTtl: TALLY_TTL_S
  });
  return json(env, request, { ok: true, windowId: snapshot.windowId });
}

async function getTallies(url, request, env) {
  const windowId = String(url.searchParams.get("windowId") || "").trim();
  const current = await loadCurrentWindow(env);
  const id = windowId || (current && current.windowId) || "";
  if (!id) {
    return json(env, request, { ok: false, error: "missing_window" }, 400);
  }
  const tallies = (await env.BALLOT_KV.get("tally:" + id, "json")) || emptyTallies();
  return json(env, request, {
    ok: true,
    windowId: id,
    voteCount: Number(tallies.voteCount) || 0,
    tallies: {
      fuel: tallies.fuel || {},
      harness: tallies.harness || {},
      environment: tallies.environment || {},
      candidate: tallies.candidate || {}
    }
  });
}

async function postVote(request, env) {
  const ip = clientIp(request);
  if (!ip) {
    return json(env, request, { ok: false, error: "no_ip" }, 400);
  }

  const rl = await rateLimit(env, ip);
  if (!rl.ok) {
    return json(env, request, { ok: false, error: "rate_limited" }, 429);
  }

  const body = await readJson(request);
  if (!body) {
    return json(env, request, { ok: false, error: "invalid_json" }, 400);
  }

  const windowId = String(body.windowId || "").trim();
  const fuel = String(body.fuel || "").trim();
  const harness = String(body.harness || "").trim();
  const environment = String(body.environment || "").trim();
  const candidateId = String(body.candidateId || "").trim();
  const fingerprint = String(body.fingerprint || "").trim();
  if (fingerprint && (fingerprint.length > FP_MAX || !/^[a-zA-Z0-9._:-]+$/.test(fingerprint))) {
    return json(env, request, { ok: false, error: "invalid_fingerprint" }, 400);
  }

  const window = await loadWindow(env, windowId);
  if (!window) {
    return json(env, request, { ok: false, error: "unknown_window" }, 400);
  }
  if (window.windowId !== windowId) {
    return json(env, request, { ok: false, error: "stale_window" }, 409);
  }

  const now = Date.now();
  const opens = Date.parse(window.opensAt);
  const closes = Date.parse(window.closesAt);
  if (!Number.isFinite(opens) || !Number.isFinite(closes)) {
    return json(env, request, { ok: false, error: "invalid_window" }, 400);
  }
  if (now < opens) {
    return json(env, request, { ok: false, error: "window_not_open" }, 403);
  }
  if (now >= closes) {
    return json(env, request, { ok: false, error: "window_closed" }, 403);
  }

  const options = await resolveOptions(env, window);
  if (!options.fuel.has(fuel) || !options.harness.has(harness) || !options.environment.has(environment)) {
    return json(env, request, { ok: false, error: "invalid_option" }, 400);
  }
  if (candidateId) {
    const openIds = new Set(
      (window.candidates || [])
        .filter(function (c) { return c && c.status === "open" && c.id; })
        .map(function (c) { return String(c.id); })
    );
    if (!openIds.has(candidateId)) {
      return json(env, request, { ok: false, error: "invalid_candidate" }, 400);
    }
  }

  const salt = String(env.VOTE_SALT || "ballot-dev-salt");
  const ipHash = await sha256Hex(salt + "|" + windowId + "|ip|" + ip);
  const votedKey = "voted:" + windowId + ":" + ipHash;
  const ttl = votedTtl(window.periodHours, closes);

  const already = await env.BALLOT_KV.get(votedKey);
  if (already) {
    return json(env, request, { ok: false, error: "already_voted" }, 409);
  }

  if (fingerprint) {
    const fpHash = await sha256Hex(salt + "|" + windowId + "|fp|" + fingerprint);
    const fpKey = "fp:" + windowId + ":" + fpHash;
    const fpHit = await env.BALLOT_KV.get(fpKey);
    if (fpHit) {
      return json(env, request, { ok: false, error: "already_voted" }, 409);
    }
    await env.BALLOT_KV.put(fpKey, "1", { expirationTtl: ttl });
  }

  const coolKey = "cool:" + ipHash;
  const coolHit = await env.BALLOT_KV.get(coolKey);
  if (coolHit) {
    return json(env, request, { ok: false, error: "cooldown" }, 429);
  }
  await env.BALLOT_KV.put(coolKey, "1", { expirationTtl: COOLDOWN_S });
  await env.BALLOT_KV.put(votedKey, String(now), { expirationTtl: ttl });

  const tallyKey = "tally:" + windowId;
  const tallies = (await env.BALLOT_KV.get(tallyKey, "json")) || emptyTallies();
  bump(tallies.fuel, fuel);
  bump(tallies.harness, harness);
  bump(tallies.environment, environment);
  if (candidateId) bump(tallies.candidate, candidateId);
  tallies.voteCount = (Number(tallies.voteCount) || 0) + 1;
  await env.BALLOT_KV.put(tallyKey, JSON.stringify(tallies), { expirationTtl: TALLY_TTL_S });

  return json(env, request, {
    ok: true,
    windowId: windowId,
    voteCount: tallies.voteCount,
    receipt: { windowId: windowId, at: new Date(now).toISOString() }
  });
}

function emptyTallies() {
  return { voteCount: 0, fuel: {}, harness: {}, environment: {}, candidate: {} };
}

function bump(map, key) {
  map[key] = (Number(map[key]) || 0) + 1;
}

function votedTtl(periodHours, closesMs) {
  const periodS = Math.max(1, Number(periodHours) || 8) * 3600;
  const untilClose = Math.ceil((closesMs - Date.now()) / 1000);
  return Math.max(VOTED_TTL_MIN_S, untilClose + periodS + 3600);
}

async function rateLimit(env, ip) {
  const salt = String(env.VOTE_SALT || "ballot-dev-salt");
  const hash = await sha256Hex(salt + "|rl|" + ip);
  const key = "rl:" + hash;
  const n = Number(await env.BALLOT_KV.get(key)) || 0;
  if (n >= RL_MAX) return { ok: false };
  await env.BALLOT_KV.put(key, String(n + 1), { expirationTtl: RL_WINDOW_S });
  return { ok: true };
}

async function loadCurrentWindow(env) {
  const fromKv = await env.BALLOT_KV.get("current-window", "json");
  if (fromKv && fromKv.windowId) return fromKv;
  return fetchOriginWindow(env);
}

async function loadWindow(env, windowId) {
  if (!windowId) return null;
  const current = await loadCurrentWindow(env);
  if (current && current.windowId === windowId) return current;
  const named = await env.BALLOT_KV.get("window-meta:" + windowId, "json");
  if (named && named.windowId === windowId) return named;
  return null;
}

async function fetchOriginWindow(env) {
  const origin = String(env.ORIGIN || "").replace(/\/$/, "");
  if (!origin) return null;
  const res = await fetch(origin + "/tracking/ballot-window.json", {
    cf: { cacheTtl: 30, cacheEverything: true }
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data || !data.windowId) return null;
  return {
    windowId: String(data.windowId),
    opensAt: String(data.opensAt),
    closesAt: String(data.closesAt),
    periodHours: Number(data.periodHours) || 8,
    candidates: Array.isArray(data.candidates) ? data.candidates : [],
    options: optionsToArrays(data.options)
  };
}

async function resolveOptions(env, window) {
  const fromWindow = arraysToSets(optionsToArrays(window && window.options));
  const fromArsenal = await fetchActiveArsenal(env);
  const pick = function (kind) {
    const src = fromArsenal[kind] && fromArsenal[kind].size ? fromArsenal[kind] : fromWindow[kind];
    return src || new Set();
  };
  return {
    fuel: pick("fuel"),
    harness: pick("harness"),
    environment: pick("environment")
  };
}

async function fetchActiveArsenal(env) {
  const empty = { fuel: new Set(), harness: new Set(), environment: new Set() };
  const origin = String(env.ORIGIN || "").replace(/\/$/, "");
  if (!origin) return empty;
  try {
    const res = await fetch(origin + "/tracking/arsenal.json", {
      cf: { cacheTtl: 60, cacheEverything: true }
    });
    if (!res.ok) return empty;
    const data = await res.json();
    return activeSetsFromArsenal(data);
  } catch (_) {
    return empty;
  }
}

function activeSetsFromArsenal(data) {
  const out = { fuel: new Set(), harness: new Set(), environment: new Set() };
  const sections = (data && Array.isArray(data.sections)) ? data.sections : [];
  sections.forEach(function (sec) {
    const id = sec && sec.id;
    if (!out[id]) return;
    (Array.isArray(sec.items) ? sec.items : []).forEach(function (it) {
      if (!it || it.status !== "active") return;
      const name = String(it.nameZh || it.name || "").trim();
      if (name) out[id].add(name);
    });
  });
  return out;
}

function optionsToArrays(options) {
  const out = { fuel: [], harness: [], environment: [] };
  if (!options || typeof options !== "object") return out;
  ["fuel", "harness", "environment"].forEach(function (kind) {
    const src = options[kind];
    const list = src instanceof Set ? Array.from(src) : Array.isArray(src) ? src : [];
    list.forEach(function (name) {
      const s = String(name || "").trim();
      if (s && out[kind].indexOf(s) === -1) out[kind].push(s);
    });
  });
  return out;
}

function arraysToSets(options) {
  const arr = optionsToArrays(options);
  return {
    fuel: new Set(arr.fuel),
    harness: new Set(arr.harness),
    environment: new Set(arr.environment)
  };
}

function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "";
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

async function readJson(request) {
  const len = Number(request.headers.get("Content-Length") || 0);
  if (len > BODY_MAX) return null;
  const text = await request.text();
  if (text.length > BODY_MAX) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

function allowedOrigin(origin, env) {
  if (!origin) return "";
  const configured = String(env.ORIGIN || "").replace(/\/$/, "");
  if (configured && origin === configured) return origin;
  if (/^https:\/\/[a-z0-9.-]+\.pages\.dev$/i.test(origin)) return origin;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  return "";
}

function corsHeaders(env, request) {
  const origin = allowedOrigin(request.headers.get("Origin") || "", env);
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Vary": "Origin"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function cors(env, request, response) {
  const headers = corsHeaders(env, request);
  Object.keys(headers).forEach(function (k) {
    response.headers.set(k, headers[k]);
  });
  return response;
}

function json(env, request, data, status) {
  const body = JSON.stringify(data);
  const res = new Response(body, {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
  return cors(env, request, res);
}
