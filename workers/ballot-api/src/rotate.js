/**
 * Slim ballot rotate for Cloudflare Workers Cron Triggers.
 * Window length comes from fetched rotate-config voteWindowMinutes; if that
 * field is missing, duration is periodHours (cold/legacy, default 8h).
 * Windows are floor-aligned in timezone by that duration. No git, X, agy, or demo builds.
 *
 * KV write budget (Cron path; Free tier ~1000 writes/day):
 *   before_writes_est: ~1641/day (observed every-minute cron: lock/status on skipped_open ticks)
 *   after_writes_est: at most ~300/day avoidable cron-path writes (0 on skipped_open; 5-min poll;
 *     no redundant rotate-status/cache puts). Essential settle puts still scale (~5×rotates).
 */

export const CRON_UTC = "*/5 * * * *";
/** When the window is still open, act on pending repair / pre-close polling within this margin. */
export const NEAR_CLOSE_MS = 150000;
export const CONFIG_TTL_S = 60 * 60 * 24 * 7;
export const LEDGER_TTL_S = 60 * 60 * 24 * 14;
export const STATUS_TTL_S = 60 * 60 * 24 * 14;
export const KV_MIN_TTL_S = 60;
// Short-lived rotate lock. Cloudflare KV requires expirationTtl >= 60.
export const LOCK_TTL_S = 60;

export function kvTtl(seconds) {
  return Math.max(KV_MIN_TTL_S, Number(seconds) || 0);
}

export function isNearClose(nowMs, closesAtMs) {
  const closes = Number(closesAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(closes) || !Number.isFinite(now)) return false;
  const remaining = closes - now;
  if (remaining <= 0) return true;
  return remaining <= NEAR_CLOSE_MS;
}

/** Open-window Cron ticks far from closesAt need no mutate path; settle lands within ~5m of closesAt. */
export function shouldActOnOpenWindow(nowMs, closesAtMs) {
  return isNearClose(nowMs, closesAtMs);
}

/** KV / runtime error name only. Never echo messages (may contain secrets). */
export function safeErrorDetail(err) {
  if (err == null) return "unknown";
  const name = String(err.name || "Error");
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  return cleaned || "Error";
}

const DEFAULT_TZ = "Asia/Shanghai";
const DEFAULT_PERIOD = 8;

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

/** Source of truth for closesAt - opensAt. voteWindowMinutes wins; else periodHours * 60. */
export function voteWindowMinutes(cfg) {
  const n = Number(cfg && cfg.voteWindowMinutes);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return periodHours(cfg) * 60;
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
    hour: hour,
    minute: Number(map.minute) || 0
  };
}

export function wallToUtcMs(year, month, day, hour, timeZone, minute) {
  const min = Number(minute) || 0;
  let utc = Date.UTC(year, month - 1, day, hour, min, 0);
  const tz = timeZone || DEFAULT_TZ;
  for (let i = 0; i < 4; i++) {
    const p = zonedParts(utc, tz);
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, Number(p.minute) || 0, 0);
    const want = Date.UTC(year, month - 1, day, hour, min, 0);
    const delta = want - got;
    if (delta === 0) return utc;
    utc += delta;
  }
  return utc;
}

export function windowIdFor(startLocal) {
  const y = String(startLocal.year).padStart(4, "0");
  const m = String(startLocal.month).padStart(2, "0");
  const d = String(startLocal.day).padStart(2, "0");
  const h = String(startLocal.hour).padStart(2, "0");
  if (Object.prototype.hasOwnProperty.call(startLocal, "minute")) {
    const mi = String(Number(startLocal.minute) || 0).padStart(2, "0");
    return y + "-" + m + "-" + d + "-" + h + mi;
  }
  return y + "-" + m + "-" + d + "-" + h;
}

export function containingWindow(nowMs, cfg) {
  const tz = timezone(cfg);
  const minutes = voteWindowMinutes(cfg);
  const local = zonedParts(nowMs, tz);
  const minuteOfDay = local.hour * 60 + (Number(local.minute) || 0);
  const slotStart = Math.floor(minuteOfDay / minutes) * minutes;
  const startH = Math.floor(slotStart / 60);
  const startMin = slotStart % 60;
  const startLocal = {
    year: local.year,
    month: local.month,
    day: local.day,
    hour: startH
  };
  if (minutes % 60 !== 0 || startMin !== 0) {
    startLocal.minute = startMin;
  }
  const startMs = wallToUtcMs(startLocal.year, startLocal.month, startLocal.day, startH, tz, startMin);
  const endMs = startMs + minutes * 60 * 1000;
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
    voteWindowMinutes: voteWindowMinutes(cfg),
    opensAt: isoZ(win.startMs),
    closesAt: isoZ(win.endMs),
    candidates: candidates,
    options: options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh:
      "本窗无新书签增量：Worker Cron 不抓 X、不跑 git / agy。候选项由 Firstmate X MCP slim ingest（无 X_BEARER 主线）写入。空候选时本 Worker 仍开窗；隐藏投票 UI 在 Hub UI 分支 hub/v2-ui-realtime（合并 main 后才出现在枢纽页）。仍可投燃料 / harness / 7×24。"
  };
}

export function bootstrapBallot(nowMs, cfg, options) {
  const win = containingWindow(nowMs, cfg);
  return {
    version: 1,
    windowId: windowIdFor(win.startLocal),
    timezone: timezone(cfg),
    periodHours: periodHours(cfg),
    voteWindowMinutes: voteWindowMinutes(cfg),
    opensAt: isoZ(win.startMs),
    closesAt: isoZ(win.endMs),
    candidates: [],
    options: options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh:
      "Worker Cron 首次打开本窗（KV 无快照）。不抓 X、不跑 git。候选项靠 Firstmate MCP slim ingest。仍可投燃料 / harness / 7×24。"
  };
}

export function windowSnapshot(ballot) {
  const minutes = snapshotVoteWindowMinutes(ballot);
  return {
    windowId: String(ballot.windowId),
    opensAt: String(ballot.opensAt),
    closesAt: String(ballot.closesAt),
    periodHours: Number(ballot.periodHours) || DEFAULT_PERIOD,
    voteWindowMinutes: minutes,
    timezone: String(ballot.timezone || DEFAULT_TZ),
    candidates: Array.isArray(ballot.candidates) ? ballot.candidates : [],
    options: ballot.options || { fuel: [], harness: [], environment: [] },
    ingestNoteZh: ballot.ingestNoteZh || ""
  };
}

function snapshotVoteWindowMinutes(ballot) {
  const n = Number(ballot && ballot.voteWindowMinutes);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const opens = parseIso(ballot && ballot.opensAt);
  const closes = parseIso(ballot && ballot.closesAt);
  if (Number.isFinite(opens) && Number.isFinite(closes) && closes > opens) {
    return Math.max(1, Math.round((closes - opens) / 60000));
  }
  return periodHours({ periodHours: ballot && ballot.periodHours }) * 60;
}

export function defaultConfig() {
  // Legacy 8h until rotate-config.json is fetched. Do not silently bootstrap 10m.
  // Deploy Pages rotate-config (voteWindowMinutes: 10) before or with Worker redeploy.
  return {
    timezone: DEFAULT_TZ,
    periodHours: DEFAULT_PERIOD
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
  if (fetched && (fetched.voteWindowMinutes || fetched.periodHours || fetched.slotHours)) {
    try {
      const serialized = JSON.stringify(fetched);
      const existing = await env.BALLOT_KV.get("rotate-config");
      if (existing !== serialized) {
        await env.BALLOT_KV.put("rotate-config", serialized, {
          expirationTtl: kvTtl(CONFIG_TTL_S)
        });
      }
    } catch (_) {
      /* cache is best-effort */
    }
    return fetched;
  }
  const cached = await env.BALLOT_KV.get("rotate-config", "json");
  if (cached && (cached.voteWindowMinutes || cached.periodHours || cached.slotHours)) return cached;
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

export async function persistWindow(kv, ballot, options) {
  const opts = options || {};
  const snapshot = windowSnapshot(ballot);
  await putJson(kv, "current-window", snapshot, LEDGER_TTL_S);
  if (opts.persistMeta === true) {
    try {
      await putJson(kv, "window-meta:" + snapshot.windowId, snapshot, LEDGER_TTL_S);
    } catch (_) {
      /* current-window is source of truth for GET /api/window */
    }
  }
  return snapshot;
}

export function harnessFlagsFrom(prior) {
  return {
    needsGitPush: !!(prior && prior.needsGitPush),
    needsXIngest: !!(prior && prior.needsXIngest)
  };
}

export const PENDING_LEDGER_KEY = "pending-ledger";
/** Consecutive vote-ledger put failures for the same settledWindowId before
 *  giving up exclusive repair. After this, error=ledger_repair_exhausted and
 *  the next closed current window may settle so the chain does not freeze. */
export const LEDGER_REPAIR_MAX_FAILURES = 5;

export function pendingLedgerFrom(priorStatus, stored) {
  const fromStatus = (priorStatus && priorStatus.pendingLedger && priorStatus.pendingLedger.settledWindowId)
    ? priorStatus.pendingLedger
    : null;
  const fromKey = (stored && stored.settledWindowId) ? stored : null;
  if (!fromStatus && !fromKey) return null;
  if (!fromStatus) return fromKey;
  if (!fromKey) return fromStatus;
  // KEY wins identity fields; failCount is max so a stale lower status count
  // cannot delay ledger_repair_exhausted.
  const merged = Object.assign({}, fromStatus, fromKey);
  merged.failCount = Math.max(Number(fromStatus.failCount) || 0, Number(fromKey.failCount) || 0);
  return merged;
}

export function compactPendingBallot(ballot) {
  return {
    windowId: String((ballot && ballot.windowId) || ""),
    candidates: Array.isArray(ballot && ballot.candidates) ? ballot.candidates : []
  };
}

export async function ackRotateFlags(kv, patch) {
  const prior = await kv.get("rotate-status", "json");
  if (!prior) return { ok: false, error: "missing_status" };
  let storedPending = null;
  try {
    storedPending = await kv.get(PENDING_LEDGER_KEY, "json");
  } catch (_) {
    storedPending = null;
  }
  const pending = pendingLedgerFrom(prior, storedPending);
  const wantsClear = !!(patch && (patch.needsGitPush === false || patch.needsXIngest === false));
  if (pending && pending.settledWindowId && wantsClear) {
    return {
      ok: false,
      error: "pending_ledger",
      status: Object.assign({}, prior, {
        needsGitPush: true,
        needsXIngest: true,
        pendingLedger: pending
      })
    };
  }
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

  const fail = async function (error, extra, failOpts) {
    const preserve = !(failOpts && failOpts.preserveHarnessFlags === false);
    const dropPending = !!(failOpts && failOpts.dropPendingLedger);
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
    if (dropPending) {
      delete status.pendingLedger;
    } else {
      let storedPending = null;
      try {
        storedPending = await kv.get(PENDING_LEDGER_KEY, "json");
      } catch (_) {
        storedPending = null;
      }
      const merged = pendingLedgerFrom({
        pendingLedger: (status.pendingLedger && status.pendingLedger.settledWindowId)
          ? status.pendingLedger
          : (priorStatus && priorStatus.pendingLedger)
      }, storedPending);
      if (merged) status.pendingLedger = merged;
    }
    if (status.pendingLedger && status.pendingLedger.settledWindowId) {
      try {
        await putJson(kv, PENDING_LEDGER_KEY, status.pendingLedger, STATUS_TTL_S);
      } catch (_) {
        /* status write still carries pendingLedger */
      }
    }
    try {
      return await writeStatus(status, preserve);
    } catch (_) {
      if (preserve) {
        status.needsGitPush = priorFlags.needsGitPush;
        status.needsXIngest = priorFlags.needsXIngest;
      }
      return status;
    }
  };

  const writeCommittedStatus = async function (status) {
    const payload = Object.assign({}, status, {
      ok: true,
      needsGitPush: true,
      needsXIngest: true
    });
    delete payload.pendingLedger;
    delete payload.error;
    try {
      await kv.delete(PENDING_LEDGER_KEY);
    } catch (_) {
      /* missing key is fine */
    }
    try {
      await writeStatus(payload, false);
      return payload;
    } catch (_) {
      try {
        const prior = await kv.get("rotate-status", "json");
        const patched = Object.assign({}, prior || {}, {
          ok: true,
          action: payload.action,
          needsGitPush: true,
          needsXIngest: true,
          settledWindowId: payload.settledWindowId,
          nextWindowId: payload.nextWindowId,
          noteZh: payload.noteZh || ""
        });
        delete patched.error;
        delete patched.pendingLedger;
        await writeStatus(patched, false);
      } catch (__) {
        /* return in-memory flags-true status; never write 未改窗 */
      }
      return payload;
    }
  };

  let priorStatus = null;
  try {
    priorStatus = await kv.get("rotate-status", "json");
    priorFlags = harnessFlagsFrom(priorStatus);
  } catch (err) {
    return {
      version: 1,
      at: started,
      cron: cron,
      scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
      ok: false,
      action: "error",
      error: "rotate_failed",
      detail: safeErrorDetail(err)
    };
  }

  let heldLock = false;
  let committed = null;
  let durablyMutated = false;
  try {
    try {
      const takeLock = async function () {
        if (options.skipLock) return true;
        const locked = await claimLock(kv);
        if (!locked) return false;
        heldLock = true;
        return true;
      };

      const loadCachedArsenal = async function () {
        let arsenal = null;
        try {
          arsenal = await loadArsenal(env, fetchImpl);
          if (arsenal) {
            const serialized = JSON.stringify(arsenal);
            let existing = null;
            try {
              existing = await kv.get("arsenal");
            } catch (_) {
              existing = null;
            }
            if (existing !== serialized) {
              await putJson(kv, "arsenal", arsenal, CONFIG_TTL_S);
            }
          }
        } catch (_) {
          arsenal = await kv.get("arsenal", "json");
        }
        return arsenal;
      };

      const failLedger = async function (err, pending) {
        let stored = null;
        try {
          stored = await kv.get(PENDING_LEDGER_KEY, "json");
        } catch (_) {
          stored = null;
        }
        const base = pendingLedgerFrom({ pendingLedger: pending }, stored) || pending;
        const failCount = (Number(base.failCount) || 0) + 1;
        const nextPending = Object.assign({}, base, { failCount: failCount });
        if (failCount >= LEDGER_REPAIR_MAX_FAILURES) {
          try {
            await kv.delete(PENDING_LEDGER_KEY);
          } catch (_) {
            /* exclusive retry stops even if delete fails */
          }
          if (priorStatus) delete priorStatus.pendingLedger;
          return await fail("ledger_repair_exhausted", {
            detail: safeErrorDetail(err),
            settledWindowId: nextPending.settledWindowId,
            nextWindowId: nextPending.nextWindowId,
            exhaustedPendingLedger: nextPending,
            ledgerRepairFailures: failCount,
            needsGitPush: true,
            needsXIngest: true,
            noteZh: "vote-ledger 连续写入失败已达上限（" + LEDGER_REPAIR_MAX_FAILURES + "），停止独占重试以免卡住转窗。"
          }, { preserveHarnessFlags: false, dropPendingLedger: true });
        }
        try {
          await putJson(kv, PENDING_LEDGER_KEY, nextPending, STATUS_TTL_S);
        } catch (_) {
          /* rotate-status still carries pendingLedger */
        }
        return await fail("ledger_failed", {
          detail: safeErrorDetail(err),
          settledWindowId: nextPending.settledWindowId,
          nextWindowId: nextPending.nextWindowId,
          pendingLedger: nextPending,
          needsGitPush: true,
          needsXIngest: true,
          noteZh: "下一窗已写入 KV，但 vote-ledger 写入失败。未报 rotated。将在后续 Cron 补写 ledger。"
        }, { preserveHarnessFlags: false });
      };

      const tryRepairPendingLedger = async function (pending) {
        const arsenal = await loadCachedArsenal();
        const ballot = (pending.ballot && pending.ballot.windowId)
          ? pending.ballot
          : ((await kv.get("window-meta:" + pending.settledWindowId, "json")) || {
              windowId: pending.settledWindowId,
              candidates: []
            });
        const tallies = (await kv.get("tally:" + pending.settledWindowId, "json")) || emptyTallies();
        const settled = settleFromTallies(ballot, arsenal || { sections: [] }, {
          ok: true,
          voteCount: Number(tallies.voteCount) || 0,
          tallies: tallies
        }, nowMs);
        try {
          await putJson(kv, "vote-ledger", settled.ledger, LEDGER_TTL_S);
        } catch (err) {
          const status = await failLedger(err, pending);
          return {
            ok: false,
            exhausted: status.error === "ledger_repair_exhausted",
            status: status
          };
        }
        try {
          await kv.delete(PENDING_LEDGER_KEY);
        } catch (_) {
          /* missing key is fine */
        }
        if (priorStatus) delete priorStatus.pendingLedger;
        return {
          ok: true,
          repaired: {
            settledWindowId: settled.ledger.settledWindowId,
            nextWindowId: pending.nextWindowId || null,
            voteCount: settled.ledger.voteCount,
            winningStack: settled.ledger.winningStack
          }
        };
      };

      let storedPending = null;
      try {
        storedPending = await kv.get(PENDING_LEDGER_KEY, "json");
      } catch (_) {
        storedPending = null;
      }
      const pending = pendingLedgerFrom(priorStatus, storedPending);
      let repairResult = null;
      if (pending && pending.settledWindowId) {
        if (!await takeLock()) return await fail("locked");
        repairResult = await tryRepairPendingLedger(pending);
        if (!repairResult.ok && !repairResult.exhausted) {
          return repairResult.status;
        }
      }

      let current = await kv.get("current-window", "json");
      if (current && current.windowId) {
        const closesMs = parseIso(current.closesAt);
        const opensMs = parseIso(current.opensAt);
        if (!Number.isFinite(closesMs) || !Number.isFinite(opensMs)) {
          return await fail("invalid_window", { settledWindowId: current.windowId });
        }
        if (nowMs < closesMs && !force) {
          if (
            !(pending && pending.settledWindowId) &&
            !shouldActOnOpenWindow(nowMs, closesMs)
          ) {
            return {
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
              noteZh:
                "当前窗仍未关闭且距 closesAt 较远，Worker Cron 跳过（零 KV 写）。needsGitPush / needsXIngest 沿用上次成功转窗。"
            };
          }
          if (repairResult && repairResult.ok) {
            committed = {
              version: 1,
              at: started,
              cron: cron,
              scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
              ok: true,
              action: "rotated",
              settledWindowId: repairResult.repaired.settledWindowId,
              nextWindowId: repairResult.repaired.nextWindowId,
              voteCount: repairResult.repaired.voteCount,
              winningStack: repairResult.repaired.winningStack,
              needsGitPush: true,
              needsXIngest: true,
              noteZh: "已补写 vote-ledger（上一窗结算）。窗此前已写入 KV。harness 见 needsGitPush / needsXIngest。"
            };
            durablyMutated = true;
            return await writeCommittedStatus(committed);
          }
          if (repairResult && repairResult.exhausted) {
            return repairResult.status;
          }
          // Skip before claimLock: open-window ticks must not put/delete rotate-lock.
          return {
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
        }
      }

      if (!heldLock) {
        if (!await takeLock()) return await fail("locked");
      }

      let cfg;
      try {
        cfg = await loadRotateConfig(env, fetchImpl);
      } catch (_) {
        return await fail("config_fetch_failed");
      }

      current = (await kv.get("current-window", "json")) || current;
      if (!current || !current.windowId) {
        current = await loadBallotFallback(env, fetchImpl);
      }

      const arsenal = await loadCachedArsenal();

      const optionsFromArsenal = activeOptions(arsenal);
      const stackOptions = (optionsFromArsenal.fuel.length || optionsFromArsenal.harness.length)
        ? optionsFromArsenal
        : ((current && current.options) || { fuel: [], harness: [], environment: [] });

      if (!current || !current.windowId) {
        const boot = bootstrapBallot(nowMs, cfg, stackOptions);
        try {
          await persistWindow(kv, boot);
        } catch (err) {
          return await fail("persist_failed", {
            detail: safeErrorDetail(err),
            nextWindowId: boot.windowId
          });
        }
        committed = {
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
        durablyMutated = true;
      } else {
        const closesMs = parseIso(current.closesAt);
        const opensMs = parseIso(current.opensAt);
        if (!Number.isFinite(closesMs) || !Number.isFinite(opensMs)) {
          return await fail("invalid_window", { settledWindowId: current.windowId });
        }

        const tallies = (await kv.get("tally:" + current.windowId, "json")) || emptyTallies();
        const settled = settleFromTallies(current, arsenal || { sections: [] }, {
          ok: true,
          voteCount: Number(tallies.voteCount) || 0,
          tallies: tallies
        }, nowMs);

        const next = nextBallotSnapshot(nowMs, closesMs, current, cfg, stackOptions);
        // persistWindow FIRST. Never report rotated if the next window did not land.
        try {
          await persistWindow(kv, next);
        } catch (err) {
          return await fail("persist_failed", {
            detail: safeErrorDetail(err),
            settledWindowId: current.windowId,
            nextWindowId: next.windowId
          });
        }
        const pendingMarker = {
          settledWindowId: settled.ledger.settledWindowId,
          nextWindowId: next.windowId,
          ballot: compactPendingBallot(current),
          failCount: 0
        };
        // Crash-safe: pending must land before vote-ledger so a thrown put
        // cannot orphan the settlement (re-repair is idempotent).
        try {
          await putJson(kv, PENDING_LEDGER_KEY, pendingMarker, STATUS_TTL_S);
        } catch (_) {
          /* failLedger still retries the marker */
        }
        try {
          await putJson(kv, "vote-ledger", settled.ledger, LEDGER_TTL_S);
        } catch (err) {
          return await failLedger(err, pendingMarker);
        }
        committed = {
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
        if (repairResult && repairResult.exhausted && repairResult.status) {
          committed.exhaustedPendingLedger = repairResult.status.exhaustedPendingLedger;
          committed.ledgerRepairFailures = repairResult.status.ledgerRepairFailures;
        }
        durablyMutated = true;
      }
    } catch (err) {
      if (durablyMutated) {
        const status = committed || {
          version: 1,
          at: started,
          cron: cron,
          scheduledTime: isoZ(Number(options.scheduledTime) || nowMs),
          ok: true,
          action: "rotated",
          needsGitPush: true,
          needsXIngest: true
        };
        return await writeCommittedStatus(status);
      }
      return await fail("rotate_failed", { detail: safeErrorDetail(err) });
    }

    if (committed) {
      return await writeCommittedStatus(committed);
    }
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
