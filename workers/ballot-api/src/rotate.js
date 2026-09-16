/**
 * Slim 8h (or 2h/1h) ballot rotate for Cloudflare Workers Cron Triggers.
 * Window math matches scripts/rotate-beat.py. No git, X, agy, or demo builds.
 */

export const CRON_UTC = "0 0,8,16 * * *";
export const CONFIG_TTL_S = 60 * 60 * 24 * 7;
export const LEDGER_TTL_S = 60 * 60 * 24 * 14;
export const STATUS_TTL_S = 60 * 60 * 24 * 14;
export const KV_MIN_TTL_S = 60;
// Short-lived rotate lock. Cloudflare KV requires expirationTtl >= 60.
export const LOCK_TTL_S = 60;

export function kvTtl(seconds) {
  return Math.max(KV_MIN_TTL_S, Number(seconds) || 0);
}

const DEFAULT_TZ = "Asia/Shanghai";
const DEFAULT_PERIOD = 8;
const DEFAULT_SLOTS = [0, 8, 16];

export function isoZ(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return y + "-" + mo + "-" + da + "T" + h + ":" + mi + ":" + s + ".000Z";
}

export function parseIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  return Date.parse(raw);
}

export function periodHours(cfg) {
  const n = Number(cfg && cfg.periodHours) || DEFAULT_PERIOD;
  return n > 0 ? n : DEFAULT_PERIOD;
}

export function slotHours(cfg) {
  const slots = cfg && cfg.slotHours;
  if (Array.isArray(slots) && slots.length) {
    const uniq = [];
    slots.forEach(function (h) {
      const n = Number(h) % 24;
      const v = n < 0 ? n + 24 : n;
      if (uniq.indexOf(v) === -1) uniq.push(v);
    });
    uniq.sort(function (a, b) { return a - b; });
    return uniq;
  }
  const period = periodHours(cfg);
  const out = [];
  for (let h = 0; h < 24; h += period) out.push(h);
  return out;
}

export function timezone(cfg) {
  return String((cfg && cfg.timezone) || DEFAULT_TZ);
}

export function zonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const map = {};
  dtf.formatToParts(new Date(ms)).forEach(function (p) {
    if (p.type !== "literal") map[p.type] = p.value;
  });
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hour
  };
}

export function wallToUtcMs(year, month, day, hour, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const tz = timeZone || DEFAULT_TZ;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(utc, tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, 0, 0);
    const want = Date.UTC(year, month - 1, day, hour, 0, 0);
    const delta = want - got;
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

function addCalendarDays(year, month, day, n) {
  const dt = new Date(Date.UTC(year, month - 1, day + n));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate()
  };
}

export function windowIdFor(startLocal) {
  const y = String(startLocal.year).padStart(4, "0");
  const m = String(startLocal.month).padStart(2, "0");
  const d = String(startLocal.day).padStart(2, "0");
  const h = String(startLocal.hour).padStart(2, "0");
  return y + "-" + m + "-" + d + "-" + h;
}

export function containingWindow(nowMs, cfg) {
  const tz = timezone(cfg);
  const period = periodHours(cfg);
  const slots = slotHours(cfg);
  const local = zonedParts(nowMs, tz);
  const hour = local.hour;
  let startY = local.year;
  let startM = local.month;
  let startD = local.day;
  let startH;
  if (hour < slots[0]) {
    const prev = addCalendarDays(local.year, local.month, local.day, -1);
    startY = prev.year;
    startM = prev.month;
    startD = prev.day;
    startH = slots[slots.length - 1];
  } else {
    startH = 0;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i] <= hour) startH = slots[i];
    }
  }
  const startLocal = { year: startY, month: startM, day: startD, hour: startH };
  const startMs = wallToUtcMs(startY, startM, startD, startH, tz);
  const endMs = startMs + period * 3600 * 1000;
  return { startMs: startMs, endMs: endMs, startLocal: startLocal };
}

export function nextWindowAfter(closeMs, cfg) {
  let win = containingWindow(closeMs, cfg);
  if (win.startMs < closeMs) {
    win = containingWindow(closeMs + 1000, cfg);
  }
  return win;
}

export function activeOptions(arsenal) {
  const out = { fuel: [], harness: [], environment: [] };
  const sections = (arsenal && Array.isArray(arsenal.sections)) ? arsenal.sections : [];
  sections.forEach(function (sec) {
    const kind = sec && sec.id;
    if (!out[kind]) return;
    (Array.isArray(sec.items) ? sec.items : []).forEach(function (item) {
      if (!item || item.status !== "active") return;
      const name = String(item.nameZh || item.name || "").trim();
      if (name) out[kind].push(name);
    });
  });
  return out;
}

export function plurality(counts, allowed) {
  if (!counts || !allowed || !allowed.length) return null;
  let bestN = -1;
  let best = null;
  for (let i = 0; i < allowed.length; i++) {
    const name = allowed[i];
    const n = Number(counts[name] || 0);
    if (n > bestN) {
      bestN = n;
      best = name;
    }
  }
  if (bestN <= 0) return null;
  return best;
}

export function emptyTallies() {
  return { voteCount: 0, fuel: {}, harness: {}, environment: {}, candidate: {} };
}

export function settleFromTallies(ballot, arsenal, remote, nowMs) {
  const options = activeOptions(arsenal);
  const tallies = (remote && remote.tallies) || emptyTallies();
  const voteCount = Number((remote && remote.voteCount) != null ? remote.voteCount : 0) || 0;
  let autoPick = voteCount <= 0;
  const winning = {
    fuel: autoPick ? null : plurality(tallies.fuel || {}, options.fuel),
    harness: autoPick ? null : plurality(tallies.harness || {}, options.harness),
    environment: autoPick ? null : plurality(tallies.environment || {}, options.environment),
    autoPick: autoPick
  };
  if (!autoPick && !winning.fuel && !winning.harness && !winning.environment) {
    winning.autoPick = true;
  }
  const candIds = [];
  (ballot.candidates || []).forEach(function (c) {
    if (c && c.id) candIds.push(String(c.id));
  });
  const winningCandidate = plurality(tallies.candidate || {}, candIds);
  return {
    ledger: {
      version: 1,
      lastSettleAt: isoZ(nowMs),
      settledWindowId: ballot.windowId || null,
      voteCount: voteCount,
      tallySource: "kv",
      tallies: {
        fuel: tallies.fuel || {},
        harness: tallies.harness || {},
        environment: tallies.environment || {},
        candidate: tallies.candidate || {}
      },
      winningStack: winning,
      winningCandidateId: winningCandidate,
      noteZh: winning.autoPick
        ? "零票，autoPick=true，编排器可从军火库启用项自选。"
        : "已按 Worker 计票选出本窗燃料 / harness / 7×24。"
    },
    options: options
  };
}

export function nextBallotSnapshot(nowMs, closesMs, ballot, cfg, options) {
  let win = containingWindow(nowMs, cfg);
  if (win.startMs <= closesMs || windowIdFor(win.startLocal) === ballot.windowId) {
    win = nextWindowAfter(closesMs, cfg);
  }
  const candidates = [];
  return {
    version: 1,
    windowId: windowIdFor(win.startLocal),
    timezone: timezone(cfg),
    periodHours: periodHours(cfg),
    opensAt: isoZ(win.startMs),
    closesAt: isoZ(win.endMs),
    candidates: candidates,
    options: options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh:
      "本窗无新书签增量：Worker Cron 不抓 X、不跑 git / agy。X ingest 与 JSON 入库由后续 harness 根据 KV rotate-status 处理。仍可投燃料 / harness / 7×24。"
  };
}

export function bootstrapBallot(nowMs, cfg, options) {
  const win = containingWindow(nowMs, cfg);
  return {
    version: 1,
    windowId: windowIdFor(win.startLocal),
    timezone: timezone(cfg),
    periodHours: periodHours(cfg),
    opensAt: isoZ(win.startMs),
    closesAt: isoZ(win.endMs),
    candidates: [],
    options: options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh:
      "Worker Cron 首次打开本窗（KV 无快照）。不抓 X、不跑 git。仍可投燃料 / harness / 7×24。"
  };
}

export function windowSnapshot(ballot) {
  return {
    windowId: String(ballot.windowId),
    opensAt: String(ballot.opensAt),
    closesAt: String(ballot.closesAt),
    periodHours: Number(ballot.periodHours) || DEFAULT_PERIOD,
    timezone: String(ballot.timezone || DEFAULT_TZ),
    candidates: Array.isArray(ballot.candidates) ? ballot.candidates : [],
    options: ballot.options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh: ballot.ingestNoteZh || ""
  };
}

export function defaultConfig() {
  return {
    timezone: DEFAULT_TZ,
    periodHours: DEFAULT_PERIOD,
    slotHours: DEFAULT_SLOTS.slice()
  };
}

export function trackingUrls(env, file) {
  const origin = String((env && env.ORIGIN) || "").replace(/\/$/, "");
  const raw = String((env && env.RAW_BASE) || "").replace(/\/$/, "");
  const urls = [];
  if (origin) urls.push(origin + "/tracking/" + file);
  if (raw) urls.push(raw + "/tracking/" + file);
  return urls;
}

export async function fetchFirstJson(urls, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    if (!url) continue;
    try {
      const res = await fetchFn(url, { cf: { cacheTtl: 30, cacheEverything: true } });
      if (!res || !res.ok) continue;
      const data = await res.json();
      if (data && typeof data === "object") return data;
    } catch (_) {
      /* try next URL */
    }
  }
  return null;
}

export async function loadRotateConfig(env, fetchImpl) {
  const fetched = await fetchFirstJson(trackingUrls(env, "rotate-config.json"), fetchImpl);
  if (fetched && (fetched.periodHours || fetched.slotHours)) {
    try {
      await env.BALLOT_KV.put("rotate-config", JSON.stringify(fetched), {
        expirationTtl: kvTtl(CONFIG_TTL_S)
      });
    } catch (_) {
      /* cache is best-effort */
    }
    return fetched;
  }
  const cached = await env.BALLOT_KV.get("rotate-config", "json");
  if (cached && (cached.periodHours || cached.slotHours)) return cached;
  return defaultConfig();
}

export async function loadArsenal(env, fetchImpl) {
  const fetched = await fetchFirstJson(trackingUrls(env, "arsenal.json"), fetchImpl);
  if (fetched) return fetched;
  const cached = await env.BALLOT_KV.get("arsenal", "json");
  return cached || null;
}

export async function loadBallotFallback(env, fetchImpl) {
  return fetchFirstJson(trackingUrls(env, "ballot-window.json"), fetchImpl);
}

async function claimLock(kv) {
  const prior = await kv.get("rotate-lock");
  if (prior) return false;
  const nonce = (crypto.randomUUID && crypto.randomUUID()) ||
    String(Date.now()) + "-" + Math.random();
  await kv.put("rotate-lock", nonce, { expirationTtl: kvTtl(LOCK_TTL_S) });
  const stored = await kv.get("rotate-lock");
  return stored === nonce;
}

async function putJson(kv, key, value, ttl) {
  await kv.put(key, JSON.stringify(value), { expirationTtl: kvTtl(ttl) });
}

export async function persistWindow(kv, ballot) {
  const snapshot = windowSnapshot(ballot);
  await putJson(kv, "current-window", snapshot, LEDGER_TTL_S);
  await putJson(kv, "window-meta:" + snapshot.windowId, snapshot, LEDGER_TTL_S);
  return snapshot;
}

export function harnessFlagsFrom(prior) {
  return {
    needsGitPush: !!(prior && prior.needsGitPush),
    needsXIngest: !!(prior && prior.needsXIngest)
  };
}

export async function ackRotateFlags(kv, patch) {
  const prior = await kv.get("rotate-status", "json");
  if (!prior) return { ok: false, error: "missing_status" };
  const next = Object.assign({}, prior);
  if (patch && patch.needsGitPush === false) next.needsGitPush = false;
  if (patch && patch.needsXIngest === false) next.needsXIngest = false;
  next.ackedAt = isoZ(Date.now());
  await putJson(kv, "rotate-status", next, STATUS_TTL_S);
  return { ok: true, status: next };
}

export async function runRotate(env, opts) {
  const options = opts || {};
  const nowMs = Number(options.nowMs) || Number(options.scheduledTime) || Date.now();
  const force = !!options.force;
  const cron = options.cron || CRON_UTC;
  const fetchImpl = options.fetchImpl || fetch;
  const kv = env.BALLOT_KV;
  const started = isoZ(nowMs);
  let priorFlags = { needsGitPush: false, needsXIngest: false };

  const writeStatus = async function (status, preserveHarnessFlags) {
    const next = Object.assign({}, status);
    if (preserveHarnessFlags) {
      next.needsGitPush = priorFlags.needsGitPush;
      next.needsXIngest = priorFlags.needsXIngest;
    }
    await putJson(kv, "rotate-status", next, STATUS_TTL_S);
    return next;
  };

  const fail = async function (error, extra) {
    const status = Object.assign({
      version: 1,
      at: started,
      cron: cron,
      scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
      ok: false,
      action: "error",
      error: error,
      needsGitPush: priorFlags.needsGitPush,
      needsXIngest: priorFlags.needsXIngest,
      noteZh: "Worker Cron 失败，未改窗。勿在 Worker 内补跑 git / X / agy。"
    }, extra || {});
    try {
      return await writeStatus(status, true);
    } catch (_) {
      status.needsGitPush = priorFlags.needsGitPush;
      status.needsXIngest = priorFlags.needsXIngest;
      return status;
    }
  };

  let heldLock = false;
  try {
    const priorStatus = await kv.get("rotate-status", "json");
    priorFlags = harnessFlagsFrom(priorStatus);

    if (!options.skipLock) {
      const locked = await claimLock(kv);
      if (!locked) {
        return await fail("locked");
      }
      heldLock = true;
    }

    let cfg;
    try {
      cfg = await loadRotateConfig(env, fetchImpl);
    } catch (err) {
      return await fail("config_fetch_failed");
    }

    let current = await kv.get("current-window", "json");
    if (!current || !current.windowId) {
      current = await loadBallotFallback(env, fetchImpl);
    }

    let arsenal = null;
    try {
      arsenal = await loadArsenal(env, fetchImpl);
      if (arsenal) {
        await putJson(kv, "arsenal", arsenal, CONFIG_TTL_S);
      }
    } catch (_) {
      arsenal = await kv.get("arsenal", "json");
    }

    const optionsFromArsenal = activeOptions(arsenal);
    const stackOptions = (optionsFromArsenal.fuel.length || optionsFromArsenal.harness.length)
      ? optionsFromArsenal
      : ((current && current.options) || { fuel: [], harness: [], environment: [] });

    if (!current || !current.windowId) {
      const boot = bootstrapBallot(nowMs, cfg, stackOptions);
      await persistWindow(kv, boot);
      const status = {
        version: 1,
        at: started,
        cron: cron,
        scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
        ok: true,
        action: "bootstrapped",
        settledWindowId: null,
        nextWindowId: boot.windowId,
        voteCount: 0,
        needsGitPush: true,
        needsXIngest: true,
        noteZh: "KV 无窗快照，已按 rotate-config 打开当前上海窗。请 harness 把 ballot-window 同步进 git；Worker 未抓 X。"
      };
      await writeStatus(status, false);
      return status;
    }

    const closesMs = parseIso(current.closesAt);
    const opensMs = parseIso(current.opensAt);
    if (!Number.isFinite(closesMs) || !Number.isFinite(opensMs)) {
      return await fail("invalid_window", { settledWindowId: current.windowId });
    }

    if (nowMs < closesMs && !force) {
      const status = {
        version: 1,
        at: started,
        cron: cron,
        scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
        ok: true,
        action: "skipped_open",
        settledWindowId: null,
        nextWindowId: current.windowId,
        voteCount: 0,
        needsGitPush: priorFlags.needsGitPush,
        needsXIngest: priorFlags.needsXIngest,
        noteZh: "当前窗仍未关闭，Worker Cron 跳过。needsGitPush / needsXIngest 沿用上次成功转窗，直至 harness POST /api/rotate-status/ack。"
      };
      await writeStatus(status, true);
      return status;
    }

    const tallies = (await kv.get("tally:" + current.windowId, "json")) || emptyTallies();
    const settled = settleFromTallies(current, arsenal || { sections: [] }, {
      ok: true,
      voteCount: Number(tallies.voteCount) || 0,
      tallies: tallies
    }, nowMs);

    const next = nextBallotSnapshot(nowMs, closesMs, current, cfg, stackOptions);
    await putJson(kv, "vote-ledger", settled.ledger, LEDGER_TTL_S);
    await persistWindow(kv, next);

    const status = {
      version: 1,
      at: started,
      cron: cron,
      scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
      ok: true,
      action: "rotated",
      settledWindowId: settled.ledger.settledWindowId,
      nextWindowId: next.windowId,
      voteCount: settled.ledger.voteCount,
      winningStack: settled.ledger.winningStack,
      needsGitPush: true,
      needsXIngest: true,
      noteZh:
        "Worker Cron 已在 KV 结算上一窗并打开下一窗。未跑 git / X / agy。harness 见 needsGitPush / needsXIngest；完成后 POST /api/rotate-status/ack。"
    };
    await writeStatus(status, false);
    return status;
  } catch (err) {
    const message = err && err.message ? String(err.message).slice(0, 200) : "rotate_failed";
    return await fail(message || "rotate_failed");
  } finally {
    if (heldLock) {
      try {
        await kv.delete("rotate-lock");
      } catch (_) {
        /* lock TTL is the fallback */
      }
    }
  }
}
