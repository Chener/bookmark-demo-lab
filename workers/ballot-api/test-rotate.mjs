import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  containingWindow,
  windowIdFor,
  isoZ,
  nextWindowAfter,
  plurality,
  settleFromTallies,
  nextBallotSnapshot,
  bootstrapBallot,
  defaultConfig,
  runRotate,
  ackRotateFlags,
  periodHours,
  voteWindowMinutes,
  CRON_UTC,
  loadRotateConfig,
  LOCK_TTL_S,
  KV_MIN_TTL_S,
  kvTtl,
  safeErrorDetail,
  PENDING_LEDGER_KEY,
  pendingLedgerFrom,
  LEDGER_REPAIR_MAX_FAILURES
} from "./src/rotate.js";

const CFG = {
  timezone: "Asia/Shanghai",
  periodHours: 8,
  slotHours: [0, 8, 16]
};

function parseIso(value) {
  return Date.parse(value);
}

class MemKV {
  constructor() {
    this.map = new Map();
    this.puts = [];
  }
  async get(key, type) {
    const v = this.map.get(key);
    if (v == null) return null;
    if (type === "json") return JSON.parse(v);
    return v;
  }
  async put(key, value, options) {
    this.puts.push({ key: key, value: value, options: options || {} });
    this.map.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

function fixture(pathname) {
  if (pathname.endsWith("rotate-config.json")) {
    return {
      timezone: "Asia/Shanghai",
      periodHours: 8,
      slotHours: [0, 8, 16]
    };
  }
  if (pathname.endsWith("arsenal.json")) {
    return {
      sections: [
        {
          id: "fuel",
          items: [
            { nameZh: "Cursor Ultra", status: "active" },
            { nameZh: "OpenCode", status: "planned" }
          ]
        },
        {
          id: "harness",
          items: [{ nameZh: "Cursor Cloud Agent", status: "active" }]
        },
        {
          id: "environment",
          items: [{ nameZh: "Cursor Cloud Agent 托管机", status: "active" }]
        }
      ]
    };
  }
  if (pathname.endsWith("ballot-window.json")) {
    return {
      windowId: "2026-09-15-16",
      timezone: "Asia/Shanghai",
      periodHours: 8,
      opensAt: "2026-09-15T08:00:00.000Z",
      closesAt: "2026-09-15T16:00:00.000Z",
      candidates: [],
      options: {
        fuel: ["Cursor Ultra"],
        harness: ["Cursor Cloud Agent"],
        environment: ["Cursor Cloud Agent 托管机"]
      }
    };
  }
  return null;
}

function mockFetch() {
  return async function (url) {
    const u = new URL(url);
    const data = fixture(u.pathname);
    if (!data) return { ok: false, json: async () => null };
    return { ok: true, json: async () => data };
  };
}

test("window math matches rotate-beat.py self-test", () => {
  const now = parseIso("2026-09-15T12:29:00.000Z");
  const win = containingWindow(now, CFG);
  assert.equal(windowIdFor(win.startLocal), "2026-09-15-16");
  assert.equal(isoZ(win.startMs), "2026-09-15T08:00:00.000Z");
  assert.equal(isoZ(win.endMs), "2026-09-15T16:00:00.000Z");

  const cfg2 = {
    ...CFG,
    periodHours: 2,
    slotHours: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
  };
  const w2 = containingWindow(now, cfg2);
  assert.equal(windowIdFor(w2.startLocal), "2026-09-15-20");
  assert.equal(w2.endMs - w2.startMs, 2 * 3600 * 1000);

  const cfg1 = { ...CFG, periodHours: 1, slotHours: [...Array(24).keys()] };
  const w1 = containingWindow(now, cfg1);
  assert.equal(windowIdFor(w1.startLocal), "2026-09-15-20");
  assert.equal(w1.endMs - w1.startMs, 3600 * 1000);

  assert.equal(plurality({ A: 2, B: 2 }, ["B", "A"]), "B");
  assert.equal(plurality({}, ["A"]), null);

  const close = parseIso("2026-09-15T16:00:00.000Z");
  const nxt = nextWindowAfter(close, CFG);
  assert.equal(windowIdFor(nxt.startLocal), "2026-09-16-00");
  assert.equal(isoZ(nxt.startMs), "2026-09-15T16:00:00.000Z");
  assert.equal(isoZ(nxt.endMs), "2026-09-16T00:00:00.000Z");
  assert.equal(periodHours(CFG), 8);
});

test("cron UTC 00:00/08:00/16:00 lands on Shanghai slot boundaries", () => {
  const ticks = [
    ["2026-09-15T00:00:00.000Z", "2026-09-15-08"],
    ["2026-09-15T08:00:00.000Z", "2026-09-15-16"],
    ["2026-09-15T16:00:00.000Z", "2026-09-16-00"]
  ];
  ticks.forEach(function (row) {
    const win = containingWindow(parseIso(row[0]), CFG);
    assert.equal(windowIdFor(win.startLocal), row[1]);
    assert.equal(isoZ(win.startMs), row[0]);
  });
});

test("zero votes set autoPick", () => {
  const ballot = { windowId: "2026-09-15-16", candidates: [] };
  const arsenal = fixture("/tracking/arsenal.json");
  const settled = settleFromTallies(ballot, arsenal, {
    voteCount: 0,
    tallies: { fuel: {}, harness: {}, environment: {}, candidate: {} }
  }, parseIso("2026-09-15T16:00:00.000Z"));
  assert.equal(settled.ledger.winningStack.autoPick, true);
  assert.equal(settled.ledger.tallySource, "kv");
});

test("plurality among active names; planned ignored", () => {
  const ballot = { windowId: "w", candidates: [{ id: "c1" }, { id: "c2" }] };
  const arsenal = fixture("/tracking/arsenal.json");
  const settled = settleFromTallies(ballot, arsenal, {
    voteCount: 3,
    tallies: {
      fuel: { "Cursor Ultra": 2, OpenCode: 9 },
      harness: { "Cursor Cloud Agent": 3 },
      environment: { "Cursor Cloud Agent 托管机": 3 },
      candidate: { c2: 2, c1: 1 }
    }
  }, Date.now());
  assert.equal(settled.ledger.winningStack.fuel, "Cursor Ultra");
  assert.equal(settled.ledger.winningStack.autoPick, false);
  assert.equal(settled.ledger.winningCandidateId, "c2");
});

test("next snapshot uses config periodHours/slotHours", () => {
  const ballot = { windowId: "2026-09-15-16" };
  const close = parseIso("2026-09-15T16:00:00.000Z");
  const now = close;
  const next = nextBallotSnapshot(now, close, ballot, CFG, { fuel: ["Cursor Ultra"] });
  assert.equal(next.windowId, "2026-09-16-00");
  assert.equal(next.periodHours, 8);
  assert.equal(next.candidates.length, 0);
  assert.match(next.ingestNoteZh, /不抓 X/);
});

const CFG10 = {
  timezone: "Asia/Shanghai",
  voteWindowMinutes: 10,
  periodHours: 8,
  slotHours: [0, 8, 16]
};

test("10-minute voteWindowMinutes sets closesAt = opensAt + 10m", () => {
  assert.equal(voteWindowMinutes(CFG10), 10);
  assert.equal(voteWindowMinutes(CFG), 8 * 60);
  assert.equal(CRON_UTC, "*/5 * * * *");

  const now = parseIso("2026-09-16T00:03:00.000Z");
  const win = containingWindow(now, CFG10);
  assert.equal(isoZ(win.startMs), "2026-09-16T00:00:00.000Z");
  assert.equal(isoZ(win.endMs), "2026-09-16T00:10:00.000Z");
  assert.equal(win.endMs - win.startMs, 10 * 60 * 1000);
  assert.equal(windowIdFor(win.startLocal), "2026-09-16-0800");

  const now2 = parseIso("2026-09-16T00:14:00.000Z");
  const w2 = containingWindow(now2, CFG10);
  assert.equal(isoZ(w2.startMs), "2026-09-16T00:10:00.000Z");
  assert.equal(isoZ(w2.endMs), "2026-09-16T00:20:00.000Z");
  assert.equal(windowIdFor(w2.startLocal), "2026-09-16-0810");

  const close = parseIso("2026-09-16T00:10:00.000Z");
  const nxt = nextWindowAfter(close, CFG10);
  assert.equal(isoZ(nxt.startMs), "2026-09-16T00:10:00.000Z");
  assert.equal(isoZ(nxt.endMs), "2026-09-16T00:20:00.000Z");
  assert.equal(windowIdFor(nxt.startLocal), "2026-09-16-0810");

  const ballot = { windowId: "2026-09-16-0800" };
  const next = nextBallotSnapshot(close, close, ballot, CFG10, { fuel: ["Cursor Ultra"] });
  assert.equal(next.opensAt, "2026-09-16T00:10:00.000Z");
  assert.equal(next.closesAt, "2026-09-16T00:20:00.000Z");
  assert.equal(Date.parse(next.closesAt) - Date.parse(next.opensAt), 10 * 60 * 1000);
  assert.equal(next.voteWindowMinutes, 10);
  assert.equal(next.candidates.length, 0);

  const boot = bootstrapBallot(now, CFG10, { fuel: [] });
  assert.equal(boot.opensAt, "2026-09-16T00:00:00.000Z");
  assert.equal(boot.closesAt, "2026-09-16T00:10:00.000Z");
  assert.equal(boot.voteWindowMinutes, 10);
  assert.equal(boot.windowId, "2026-09-16-0800");
});

test("defaultConfig stays legacy periodHours until rotate-config is fetched", () => {
  const cold = defaultConfig();
  assert.equal(cold.periodHours, 8);
  assert.equal(cold.voteWindowMinutes, undefined);
  assert.equal(cold.slotHours, undefined);
  assert.equal(voteWindowMinutes(cold), 8 * 60);
  const boot = bootstrapBallot(parseIso("2026-09-16T00:03:00.000Z"), cold, {});
  assert.equal(boot.closesAt, "2026-09-16T08:00:00.000Z");
  assert.notEqual(Date.parse(boot.closesAt) - Date.parse(boot.opensAt), 10 * 60 * 1000);
});

test("runRotate skips while window still open", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "skipped_open");
  assert.equal(status.needsGitPush, false);
  assert.equal(status.needsXIngest, false);
  const still = await kv.get("current-window", "json");
  assert.equal(still.windowId, "2026-09-15-16");
});

test("runRotate settles previous KV tallies and opens next window", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 2,
    fuel: { "Cursor Ultra": 2 },
    harness: { "Cursor Cloud Agent": 2 },
    environment: { "Cursor Cloud Agent 托管机": 2 },
    candidate: {}
  }));
  const env = {
    BALLOT_KV: kv,
    ORIGIN: "https://bookmark-demo-lab.pages.dev",
    RAW_BASE: "https://raw.githubusercontent.com/Chener/bookmark-demo-lab/main"
  };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    cron: "0 0,8,16 * * *",
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.settledWindowId, "2026-09-15-16");
  assert.equal(status.nextWindowId, "2026-09-16-00");
  assert.equal(status.voteCount, 2);
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.equal(status.winningStack.fuel, "Cursor Ultra");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.tallySource, "kv");
  const flag = await kv.get("rotate-status", "json");
  assert.equal(flag.needsXIngest, true);
});

test("periodHours come from fetched rotate-config, else KV cache", async () => {
  const kv = new MemKV();
  const cfg2 = {
    timezone: "Asia/Shanghai",
    periodHours: 2,
    slotHours: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]
  };
  const fetchImpl = async function (url) {
    const u = new URL(url);
    if (u.pathname.endsWith("rotate-config.json")) {
      return { ok: true, json: async () => cfg2 };
    }
    return mockFetch()(url);
  };
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: [], harness: [], environment: [] }
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://example.test" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: fetchImpl
  });
  assert.equal(status.ok, true);
  const next = await kv.get("current-window", "json");
  assert.equal(next.periodHours, 2);
  const cached = await kv.get("rotate-config", "json");
  assert.equal(cached.periodHours, 2);

  const fetchFail = async function () {
    return { ok: false, json: async () => null };
  };
  const status2 = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    force: true,
    fetchImpl: fetchFail
  });
  assert.equal(status2.ok, true);
  const next2 = await kv.get("current-window", "json");
  assert.equal(next2.periodHours, 2);
});

test("config fetch fallback to GitHub raw URL", async () => {
  const kv = new MemKV();
  const fetchImpl = async function (url) {
    if (String(url).includes("pages.dev")) {
      throw new Error("pages down");
    }
    return mockFetch()(url);
  };
  const env = {
    BALLOT_KV: kv,
    ORIGIN: "https://bookmark-demo-lab.pages.dev",
    RAW_BASE: "https://raw.githubusercontent.com/Chener/bookmark-demo-lab/main"
  };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:05:00.000Z"),
    skipLock: true,
    fetchImpl: fetchImpl
  });
  assert.equal(status.ok, true);
  assert.ok(status.action === "rotated" || status.action === "bootstrapped");
});

test("skip/lock/fail preserve prior needsGitPush and needsXIngest", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    needsGitPush: true,
    needsXIngest: true,
    nextWindowId: "2026-09-16-00"
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const skipped = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(skipped.action, "skipped_open");
  assert.equal(skipped.needsGitPush, true);
  assert.equal(skipped.needsXIngest, true);
  const storedSkip = await kv.get("rotate-status", "json");
  assert.equal(storedSkip.action, "rotated");
  assert.equal(storedSkip.needsGitPush, true);
  assert.equal(storedSkip.needsXIngest, true);

  await kv.put("rotate-lock", "held-by-other");
  const skippedDespiteLock = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(skippedDespiteLock.action, "skipped_open");
  assert.equal(await kv.get("rotate-lock"), "held-by-other");

  const locked = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: false,
    force: true,
    fetchImpl: mockFetch()
  });
  assert.equal(locked.error, "locked");
  assert.equal(locked.needsGitPush, true);
  assert.equal(locked.needsXIngest, true);
  const storedLock = await kv.get("rotate-status", "json");
  assert.equal(storedLock.needsGitPush, true);
  assert.equal(storedLock.needsXIngest, true);

  await kv.put("current-window", JSON.stringify({
    windowId: "bad",
    opensAt: "not-a-date",
    closesAt: "also-bad"
  }));
  const failed = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "invalid_window");
  assert.equal(failed.needsGitPush, true);
  assert.equal(failed.needsXIngest, true);
});

test("ack endpoint clears only requested harness flags", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    needsGitPush: true,
    needsXIngest: true
  }));
  const gitOnly = await ackRotateFlags(kv, { needsGitPush: false });
  assert.equal(gitOnly.ok, true);
  assert.equal(gitOnly.status.needsGitPush, false);
  assert.equal(gitOnly.status.needsXIngest, true);
  const both = await ackRotateFlags(kv, { needsGitPush: false, needsXIngest: false });
  assert.equal(both.status.needsGitPush, false);
  assert.equal(both.status.needsXIngest, false);
  const missing = await ackRotateFlags(new MemKV(), { needsGitPush: false });
  assert.equal(missing.ok, false);
});

test("ack refuses to clear flags while pendingLedger is set", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00"
    }
  }));
  const result = await ackRotateFlags(kv, { needsGitPush: false, needsXIngest: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "pending_ledger");
  assert.equal(result.status.needsGitPush, true);
  assert.equal(result.status.needsXIngest, true);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  assert.equal(stored.ackedAt, undefined);
  assert.equal(stored.pendingLedger.settledWindowId, "2026-09-15-16");
});

test("ack refuses when only PENDING_LEDGER_KEY is set", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    needsGitPush: true,
    needsXIngest: true
  }));
  await kv.put(PENDING_LEDGER_KEY, JSON.stringify({
    settledWindowId: "2026-09-15-16",
    nextWindowId: "2026-09-16-00"
  }));
  const result = await ackRotateFlags(kv, { needsGitPush: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "pending_ledger");
  assert.equal(result.status.needsGitPush, true);
  assert.equal(result.status.needsXIngest, true);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.ackedAt, undefined);
});

test("kvTtl clamps Cloudflare KV expirationTtl to at least 60s", () => {
  assert.equal(KV_MIN_TTL_S, 60);
  assert.ok(LOCK_TTL_S >= 60);
  assert.equal(kvTtl(8), 60);
  assert.equal(kvTtl(25), 60);
  assert.equal(kvTtl(59), 60);
  assert.equal(kvTtl(60), 60);
  assert.equal(kvTtl(90), 90);
  assert.equal(kvTtl(NaN), 60);
});

test("claimLock puts rotate-lock with clamped TTL >= 60 and releases it", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const lockPuts = kv.puts.filter(function (p) { return p.key === "rotate-lock"; });
  assert.ok(lockPuts.length >= 1);
  const ttl = lockPuts[0].options.expirationTtl;
  assert.ok(ttl >= 60);
  assert.equal(ttl, kvTtl(LOCK_TTL_S));
  assert.equal(await kv.get("rotate-lock"), null);
});

test("runRotate unexpected throw writes opaque rotate_failed instead of bubbling", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    needsGitPush: true,
    needsXIngest: true
  }));
  const origGet = kv.get.bind(kv);
  kv.get = async function (key, type) {
    if (key === "current-window") throw new Error("kv_unavailable");
    return origGet(key, type);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.action, "error");
  assert.equal(status.error, "rotate_failed");
  assert.equal(status.detail, "Error");
  assert.doesNotMatch(String(status.detail), /kv_unavailable|Bearer|token|secret/i);
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const stored = await origGet("rotate-status", "json");
  assert.equal(stored.ok, false);
  assert.equal(stored.error, "rotate_failed");
  assert.equal(stored.detail, "Error");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
});

test("claimLock KV put throw writes opaque rotate_failed instead of bubbling", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    needsGitPush: true,
    needsXIngest: false
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "rotate-lock") throw new Error("Expiration TTL must be at least 60.");
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.action, "error");
  assert.equal(status.error, "rotate_failed");
  assert.equal(status.detail, "Error");
  assert.doesNotMatch(String(status.detail), /Expiration TTL|Bearer|token|secret/i);
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, false);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.ok, false);
  assert.equal(stored.error, "rotate_failed");
  assert.equal(stored.detail, "Error");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, false);
});

test("writeStatus fail after persistWindow does not claim 未改窗 or clear harness flags", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 2,
    fuel: { "Cursor Ultra": 2 },
    harness: { "Cursor Cloud Agent": 2 },
    environment: { "Cursor Cloud Agent 托管机": 2 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    ok: false,
    error: "rotate_failed",
    needsGitPush: false,
    needsXIngest: false,
    nextWindowId: "2026-09-15-16",
    noteZh: "Worker Cron 失败，未改窗。勿在 Worker 内补跑 git / X / agy。"
  }));
  const origPut = kv.put.bind(kv);
  let statusPuts = 0;
  kv.put = async function (key, value, options) {
    if (key === "rotate-status") {
      statusPuts += 1;
      if (statusPuts <= 1) throw new Error("status_put_failed");
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.equal(status.settledWindowId, "2026-09-15-16");
  assert.equal(status.nextWindowId, "2026-09-16-00");
  assert.doesNotMatch(String(status.noteZh || ""), /未改窗/);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "rotated");
  assert.equal(stored.ok, true);
  assert.equal(stored.error, undefined);
  assert.doesNotMatch(String(stored.noteZh || ""), /未改窗/);
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
});

test("persistWindow throw returns persist_failed not rotated and skips ledger", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    ok: true,
    needsGitPush: true,
    needsXIngest: true
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "current-window") {
      const err = new Error("window_put_failed Bearer supersecret");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.action, "error");
  assert.equal(status.error, "persist_failed");
  assert.equal(status.detail, "KvError");
  assert.doesNotMatch(String(status.detail), /supersecret|Bearer|window_put_failed/);
  assert.notEqual(status.action, "rotated");
  const still = await kv.get("current-window", "json");
  assert.equal(still.windowId, "2026-09-15-16");
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger, null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.error, "persist_failed");
  assert.equal(stored.ok, false);
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
});

test("window-meta put throw after current-window still sets harness flags true", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    ok: true,
    needsGitPush: false,
    needsXIngest: false
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (String(key).indexOf("window-meta:") === 0) throw new Error("meta_put_failed");
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.doesNotMatch(String(status.noteZh || ""), /未改窗/);
  const stored = await kv.get("rotate-status", "json");
  assert.notEqual(stored.action, "error");
  assert.doesNotMatch(String(stored.noteZh || ""), /未改窗/);
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
});

test("priorStatus get throw does not write fail status that clears harness flags", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    ok: true,
    needsGitPush: true,
    needsXIngest: true
  }));
  const origGet = kv.get.bind(kv);
  kv.get = async function (key, type) {
    if (key === "rotate-status") throw new Error("status_unavailable");
    return origGet(key, type);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.error, "rotate_failed");
  assert.equal(status.detail, "Error");
  const stored = await origGet("rotate-status", "json");
  assert.equal(stored.action, "rotated");
  assert.equal(stored.ok, true);
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  assert.doesNotMatch(String(stored.noteZh || ""), /未改窗/);
});

test("runRotate with voteWindowMinutes opens a 10-minute next window", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-0800",
    opensAt: "2026-09-16T00:00:00.000Z",
    closesAt: "2026-09-16T00:10:00.000Z",
    periodHours: 8,
    voteWindowMinutes: 10,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-16-0800", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  const fetchImpl = async function (url) {
    const u = new URL(url);
    if (u.pathname.endsWith("rotate-config.json")) {
      return { ok: true, json: async () => CFG10 };
    }
    return mockFetch()(url);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-16T00:10:00.000Z"),
    cron: "*/10 * * * *",
    skipLock: true,
    fetchImpl: fetchImpl
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.settledWindowId, "2026-09-16-0800");
  assert.equal(status.nextWindowId, "2026-09-16-0810");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-0810");
  assert.equal(next.opensAt, "2026-09-16T00:10:00.000Z");
  assert.equal(next.closesAt, "2026-09-16T00:20:00.000Z");
  assert.equal(next.voteWindowMinutes, 10);
  assert.equal(Date.parse(next.closesAt) - Date.parse(next.opensAt), 10 * 60 * 1000);
  assert.equal(next.candidates.length, 0);
});

test("safeErrorDetail is the error name and never echoes secrets", () => {
  assert.equal(safeErrorDetail(null), "unknown");
  const generic = new Error("Authorization: Bearer supersecret");
  assert.equal(safeErrorDetail(generic), "Error");
  assert.doesNotMatch(safeErrorDetail(generic), /Bearer|supersecret/i);
  const named = new Error("quota exceeded token=abc");
  named.name = "KvError";
  assert.equal(safeErrorDetail(named), "KvError");
  const dirty = new Error("x");
  dirty.name = "Err<script>alert(1)</script>";
  assert.equal(safeErrorDetail(dirty), "Errscriptalert1script");
});

test("CRON_UTC and wrangler example fire every 5 minutes", () => {
  assert.equal(CRON_UTC, "*/5 * * * *");
  const here = dirname(fileURLToPath(import.meta.url));
  const toml = readFileSync(join(here, "wrangler.toml.example"), "utf8");
  assert.match(toml, /crons\s*=\s*\["\*\/5 \* \* \* \*"\]/);
  assert.doesNotMatch(toml, /\["\*\/1 \* \* \* \*"\]/);
});

test("skipped_open does not put rotate-status", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    needsGitPush: true,
    needsXIngest: true,
    nextWindowId: "2026-09-15-16"
  }));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "skipped_open");
  const statusPuts = kv.puts.filter(function (p) { return p.key === "rotate-status"; });
  assert.equal(statusPuts.length, 0);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "rotated");
});

test("runRotate puts current-window then pending-ledger then vote-ledger", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 2,
    fuel: { "Cursor Ultra": 2 },
    harness: { "Cursor Cloud Agent": 2 },
    environment: { "Cursor Cloud Agent 托管机": 2 },
    candidate: {}
  }));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const keys = kv.puts.map(function (p) { return p.key; });
  const winIdx = keys.indexOf("current-window");
  const pendingIdx = keys.indexOf(PENDING_LEDGER_KEY);
  const ledgerIdx = keys.indexOf("vote-ledger");
  assert.ok(winIdx >= 0);
  assert.ok(pendingIdx >= 0);
  assert.ok(ledgerIdx >= 0);
  assert.ok(winIdx < pendingIdx);
  assert.ok(pendingIdx < ledgerIdx);
  const statusBeforeLedger = kv.puts
    .slice(0, ledgerIdx)
    .filter(function (p) { return p.key === "rotate-status"; });
  assert.equal(statusBeforeLedger.length, 0);
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
});

test("vote-ledger put throw after persist returns ledger_failed not rotated", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "rotated",
    ok: true,
    needsGitPush: false,
    needsXIngest: false
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      const err = new Error("ledger_put_failed token=abc");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.action, "error");
  assert.equal(status.error, "ledger_failed");
  assert.equal(status.detail, "KvError");
  assert.doesNotMatch(String(status.detail), /token=abc|ledger_put_failed/);
  assert.notEqual(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.doesNotMatch(String(status.noteZh || ""), /未改窗/);
  assert.equal(status.pendingLedger.settledWindowId, "2026-09-15-16");
  assert.equal(status.pendingLedger.nextWindowId, "2026-09-16-00");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger, null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.error, "ledger_failed");
  assert.equal(stored.ok, false);
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  assert.equal(stored.pendingLedger.settledWindowId, "2026-09-15-16");
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.equal(marker.settledWindowId, "2026-09-15-16");
});

test("skipped_open does not put or delete rotate-lock", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  kv.puts = [];
  kv.deletes = [];
  const origDelete = kv.delete.bind(kv);
  kv.delete = async function (key) {
    kv.deletes.push(key);
    return origDelete(key);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "skipped_open");
  const lockPuts = kv.puts.filter(function (p) { return p.key === "rotate-lock"; });
  assert.equal(lockPuts.length, 0);
  assert.equal(kv.deletes.filter(function (k) { return k === "rotate-lock"; }).length, 0);
  assert.equal(await kv.get("rotate-lock"), null);
});

test("force while window is open still takes the lock path", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: false,
    force: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const lockPuts = kv.puts.filter(function (p) { return p.key === "rotate-lock"; });
  assert.ok(lockPuts.length >= 1);
  assert.equal(await kv.get("rotate-lock"), null);
});

test("pending ledger retries while next window is still open", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 2,
    fuel: { "Cursor Ultra": 2 },
    harness: { "Cursor Cloud Agent": 2 },
    environment: { "Cursor Cloud Agent 托管机": 2 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.settledWindowId, "2026-09-15-16");
  assert.equal(status.nextWindowId, "2026-09-16-00");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.equal(status.pendingLedger, undefined);
  assert.equal(status.voteCount, 2);
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-15-16");
  assert.equal(ledger.voteCount, 2);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "rotated");
  assert.equal(stored.pendingLedger, undefined);
  assert.equal(stored.error, undefined);
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
  const still = await kv.get("current-window", "json");
  assert.equal(still.windowId, "2026-09-16-00");
});

test("pending ledger KV key retries even if rotate-status lost the marker", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: false,
    needsXIngest: false
  }));
  await kv.put(PENDING_LEDGER_KEY, JSON.stringify({
    settledWindowId: "2026-09-15-16",
    nextWindowId: "2026-09-16-00",
    ballot: { windowId: "2026-09-15-16", candidates: [] }
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-15-16");
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
});

test("pending ledger retry that still fails does not skipped_open or drop the marker", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: false,
    needsXIngest: false,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      const err = new Error("still_quota");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.action, "error");
  assert.equal(status.error, "ledger_failed");
  assert.notEqual(status.action, "skipped_open");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.equal(status.pendingLedger.settledWindowId, "2026-09-15-16");
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger, null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.error, "ledger_failed");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
  assert.equal(stored.pendingLedger.settledWindowId, "2026-09-15-16");
  const still = await kv.get("current-window", "json");
  assert.equal(still.windowId, "2026-09-16-00");
});

test("pendingLedgerFrom prefers KEY identity and max(failCount)", () => {
  assert.equal(pendingLedgerFrom(null, null), null);
  const merged = pendingLedgerFrom({
    pendingLedger: { settledWindowId: "a", nextWindowId: "b", failCount: 1 }
  }, { settledWindowId: "a", nextWindowId: "b", failCount: 4, ballot: { windowId: "a" } });
  assert.equal(merged.settledWindowId, "a");
  assert.equal(merged.failCount, 4);
  const statusHigher = pendingLedgerFrom({
    pendingLedger: { settledWindowId: "a", failCount: 3 }
  }, { settledWindowId: "a", failCount: 1 });
  assert.equal(statusHigher.failCount, 3);
  const keyWinsId = pendingLedgerFrom({
    pendingLedger: { settledWindowId: "status", failCount: 1 }
  }, { settledWindowId: "kv", failCount: 2 });
  assert.equal(keyWinsId.settledWindowId, "kv");
  assert.equal(keyWinsId.failCount, 2);
  const fromKv = pendingLedgerFrom({ error: "ledger_failed" }, { settledWindowId: "kv" });
  assert.equal(fromKv.settledWindowId, "kv");
  assert.equal(LEDGER_REPAIR_MAX_FAILURES, 5);
});

test("fail(locked) during pending repair does not wipe pendingLedger", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  await kv.put("rotate-lock", "held-by-other");
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(status.error, "locked");
  assert.equal(status.pendingLedger.settledWindowId, "2026-09-15-16");
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.error, "locked");
  assert.equal(stored.pendingLedger.settledWindowId, "2026-09-15-16");
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.equal(marker.settledWindowId, "2026-09-15-16");
  assert.equal(await kv.get("rotate-lock"), "held-by-other");
});

test("fail(rotate_failed) preserves pendingLedger", async () => {
  const kv = new MemKV();
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const origGet = kv.get.bind(kv);
  kv.get = async function (key, type) {
    if (key === "tally:2026-09-15-16") throw new Error("tally_unavailable");
    return origGet(key, type);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.error, "rotate_failed");
  assert.equal(status.pendingLedger.settledWindowId, "2026-09-15-16");
  const stored = await origGet("rotate-status", "json");
  assert.equal(stored.error, "rotate_failed");
  assert.equal(stored.pendingLedger.settledWindowId, "2026-09-15-16");
});

test("pending repair then settles already-closed next window in the same tick", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 2,
    fuel: { "Cursor Ultra": 2 },
    harness: { "Cursor Cloud Agent": 2 },
    environment: { "Cursor Cloud Agent 托管机": 2 },
    candidate: {}
  }));
  await kv.put("tally:2026-09-16-00", JSON.stringify({
    voteCount: 3,
    fuel: { "Cursor Ultra": 3 },
    harness: { "Cursor Cloud Agent": 3 },
    environment: { "Cursor Cloud Agent 托管机": 3 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-16T00:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.settledWindowId, "2026-09-16-00");
  assert.equal(status.nextWindowId, "2026-09-16-08");
  assert.equal(status.voteCount, 3);
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-16-00");
  assert.equal(ledger.voteCount, 3);
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-08");
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "rotated");
  assert.equal(stored.pendingLedger, undefined);
});

test("ledger_repair_exhausted after N failures stops exclusive repair", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      failCount: LEDGER_REPAIR_MAX_FAILURES - 1,
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      const err = new Error("still_quota");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, false);
  assert.equal(status.error, "ledger_repair_exhausted");
  assert.equal(status.ledgerRepairFailures, LEDGER_REPAIR_MAX_FAILURES);
  assert.equal(status.pendingLedger, undefined);
  assert.equal(status.exhaustedPendingLedger.settledWindowId, "2026-09-15-16");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.error, "ledger_repair_exhausted");
  assert.equal(stored.pendingLedger, undefined);
  const still = await kv.get("current-window", "json");
  assert.equal(still.windowId, "2026-09-16-00");
});

test("ledger_repair_exhausted then settles already-closed current window same tick", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("tally:2026-09-16-00", JSON.stringify({
    voteCount: 4,
    fuel: { "Cursor Ultra": 4 },
    harness: { "Cursor Cloud Agent": 4 },
    environment: { "Cursor Cloud Agent 托管机": 4 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      failCount: LEDGER_REPAIR_MAX_FAILURES - 1,
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      const parsed = JSON.parse(value);
      if (parsed.settledWindowId === "2026-09-15-16") {
        const err = new Error("still_quota");
        err.name = "KvError";
        throw err;
      }
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-16T00:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.ok, true);
  assert.equal(status.action, "rotated");
  assert.equal(status.settledWindowId, "2026-09-16-00");
  assert.equal(status.nextWindowId, "2026-09-16-08");
  assert.equal(status.exhaustedPendingLedger.settledWindowId, "2026-09-15-16");
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-16-00");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-08");
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
});

test("pending-ledger KEY is written before vote-ledger even when ledger throws", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  const origPut = kv.put.bind(kv);
  kv.puts = [];
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      kv.puts.push({ key: key, value: value, options: options || {} });
      const err = new Error("crash_after_persist");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.error, "ledger_failed");
  const keys = kv.puts.map(function (p) { return p.key; });
  const pendingIdx = keys.indexOf(PENDING_LEDGER_KEY);
  const ledgerIdx = keys.indexOf("vote-ledger");
  assert.ok(pendingIdx >= 0);
  assert.ok(ledgerIdx >= 0);
  assert.ok(pendingIdx < ledgerIdx);
  const midStatus = kv.puts
    .slice(0, ledgerIdx)
    .filter(function (p) { return p.key === "rotate-status"; });
  assert.equal(midStatus.length, 0);
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.equal(marker.settledWindowId, "2026-09-15-16");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
});

test("pending-ledger key survives ledger throw plus rotate-status write failure", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "rotate-status" || key === "vote-ledger") {
      const err = new Error("kv_write_failed");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.notEqual(status.action, "rotated");
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.equal(marker.settledWindowId, "2026-09-15-16");
  assert.equal(marker.nextWindowId, "2026-09-16-00");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
  assert.equal(await kv.get("vote-ledger", "json"), null);
});

test("stale lower status failCount does not delay exhaustion vs KEY", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: true,
    needsXIngest: true,
    pendingLedger: {
      settledWindowId: "2026-09-15-16",
      nextWindowId: "2026-09-16-00",
      failCount: 1,
      ballot: { windowId: "2026-09-15-16", candidates: [] }
    }
  }));
  await kv.put(PENDING_LEDGER_KEY, JSON.stringify({
    settledWindowId: "2026-09-15-16",
    nextWindowId: "2026-09-16-00",
    failCount: LEDGER_REPAIR_MAX_FAILURES - 1,
    ballot: { windowId: "2026-09-15-16", candidates: [] }
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "vote-ledger") {
      const err = new Error("still_quota");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.error, "ledger_repair_exhausted");
  assert.equal(status.ledgerRepairFailures, LEDGER_REPAIR_MAX_FAILURES);
  assert.equal(status.pendingLedger, undefined);
});

test("rotate refreshes rotate-config and arsenal puts even when unchanged", async () => {
  const cfgPayload = fixture("/tracking/rotate-config.json");
  const arsenalPayload = fixture("/tracking/arsenal.json");
  const kv = new MemKV();
  await kv.put("rotate-config", JSON.stringify(cfgPayload));
  await kv.put("arsenal", JSON.stringify(arsenalPayload));
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const configPuts = kv.puts.filter(function (p) { return p.key === "rotate-config"; });
  const arsenalPuts = kv.puts.filter(function (p) { return p.key === "arsenal"; });
  assert.equal(configPuts.length, 1);
  assert.equal(arsenalPuts.length, 1);
  const metaPuts = kv.puts.filter(function (p) {
    return String(p.key).indexOf("window-meta:") === 0;
  });
  assert.equal(metaPuts.length, 1);
  assert.equal(metaPuts[0].key, "window-meta:" + status.nextWindowId);
});

test("loadRotateConfig refreshes put when fetch succeeds", async () => {
  const cfgPayload = fixture("/tracking/rotate-config.json");
  const kv = new MemKV();
  await kv.put("rotate-config", JSON.stringify(cfgPayload));
  kv.puts = [];
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const loaded = await loadRotateConfig(env, mockFetch());
  assert.equal(loaded.periodHours, cfgPayload.periodHours);
  assert.equal(kv.puts.filter(function (p) { return p.key === "rotate-config"; }).length, 1);
});

test("writeCommittedStatus keeps PENDING_LEDGER_KEY if rotate-status put fails after ledger", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "acked",
    ok: true,
    needsGitPush: false,
    needsXIngest: false
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "rotate-status") {
      const err = new Error("status_put_failed");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-15-16");
  const next = await kv.get("current-window", "json");
  assert.equal(next.windowId, "2026-09-16-00");
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.ok(marker);
  assert.equal(marker.settledWindowId, "2026-09-15-16");
  assert.equal(marker.nextWindowId, "2026-09-16-00");
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "acked");
  assert.equal(stored.needsGitPush, false);
  assert.equal(stored.needsXIngest, false);
});

test("writeCommittedStatus puts rotate-status before deleting PENDING_LEDGER_KEY", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-15-16",
    opensAt: "2026-09-15T08:00:00.000Z",
    closesAt: "2026-09-15T16:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  const ops = [];
  const origPut = kv.put.bind(kv);
  const origDelete = kv.delete.bind(kv);
  kv.put = async function (key, value, options) {
    ops.push({ op: "put", key: key });
    return origPut(key, value, options);
  };
  kv.delete = async function (key) {
    ops.push({ op: "delete", key: key });
    return origDelete(key);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T16:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const ledgerIdx = ops.findIndex(function (o) { return o.op === "put" && o.key === "vote-ledger"; });
  assert.ok(ledgerIdx >= 0);
  const afterLedger = ops.slice(ledgerIdx + 1);
  const statusIdx = afterLedger.findIndex(function (o) { return o.op === "put" && o.key === "rotate-status"; });
  const pendingDelIdx = afterLedger.findIndex(function (o) {
    return o.op === "delete" && o.key === PENDING_LEDGER_KEY;
  });
  assert.ok(statusIdx >= 0);
  assert.ok(pendingDelIdx >= 0);
  assert.ok(statusIdx < pendingDelIdx);
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
});

test("tryRepairPendingLedger keeps PENDING_LEDGER_KEY if rotate-status put fails after ledger", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "acked",
    ok: true,
    needsGitPush: false,
    needsXIngest: false
  }));
  await kv.put(PENDING_LEDGER_KEY, JSON.stringify({
    settledWindowId: "2026-09-15-16",
    nextWindowId: "2026-09-16-00",
    ballot: { windowId: "2026-09-15-16", candidates: [] }
  }));
  const origPut = kv.put.bind(kv);
  kv.put = async function (key, value, options) {
    if (key === "rotate-status") {
      const err = new Error("status_put_failed");
      err.name = "KvError";
      throw err;
    }
    return origPut(key, value, options);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const ledger = await kv.get("vote-ledger", "json");
  assert.equal(ledger.settledWindowId, "2026-09-15-16");
  const marker = await kv.get(PENDING_LEDGER_KEY, "json");
  assert.ok(marker);
  assert.equal(marker.settledWindowId, "2026-09-15-16");
  assert.equal(marker.nextWindowId, "2026-09-16-00");
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.action, "acked");
  assert.equal(stored.needsGitPush, false);
  assert.equal(stored.needsXIngest, false);
});

test("tryRepairPendingLedger puts rotate-status before deleting PENDING_LEDGER_KEY", async () => {
  const kv = new MemKV();
  await kv.put("current-window", JSON.stringify({
    windowId: "2026-09-16-00",
    opensAt: "2026-09-15T16:00:00.000Z",
    closesAt: "2026-09-16T00:00:00.000Z",
    periodHours: 8,
    candidates: [],
    options: { fuel: ["Cursor Ultra"], harness: ["Cursor Cloud Agent"], environment: ["Cursor Cloud Agent 托管机"] }
  }));
  await kv.put("tally:2026-09-15-16", JSON.stringify({
    voteCount: 1,
    fuel: { "Cursor Ultra": 1 },
    harness: { "Cursor Cloud Agent": 1 },
    environment: { "Cursor Cloud Agent 托管机": 1 },
    candidate: {}
  }));
  await kv.put("rotate-status", JSON.stringify({
    action: "error",
    error: "ledger_failed",
    ok: false,
    needsGitPush: false,
    needsXIngest: false
  }));
  await kv.put(PENDING_LEDGER_KEY, JSON.stringify({
    settledWindowId: "2026-09-15-16",
    nextWindowId: "2026-09-16-00",
    ballot: { windowId: "2026-09-15-16", candidates: [] }
  }));
  const ops = [];
  const origPut = kv.put.bind(kv);
  const origDelete = kv.delete.bind(kv);
  kv.put = async function (key, value, options) {
    ops.push({ op: "put", key: key });
    return origPut(key, value, options);
  };
  kv.delete = async function (key) {
    ops.push({ op: "delete", key: key });
    return origDelete(key);
  };
  const env = { BALLOT_KV: kv, ORIGIN: "https://bookmark-demo-lab.pages.dev" };
  const status = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: true,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "rotated");
  const ledgerIdx = ops.findIndex(function (o) { return o.op === "put" && o.key === "vote-ledger"; });
  assert.ok(ledgerIdx >= 0);
  const afterLedger = ops.slice(ledgerIdx + 1);
  const statusIdx = afterLedger.findIndex(function (o) { return o.op === "put" && o.key === "rotate-status"; });
  const pendingDelIdx = afterLedger.findIndex(function (o) {
    return o.op === "delete" && o.key === PENDING_LEDGER_KEY;
  });
  assert.ok(statusIdx >= 0);
  assert.ok(pendingDelIdx >= 0);
  assert.ok(statusIdx < pendingDelIdx);
  assert.equal(await kv.get(PENDING_LEDGER_KEY), null);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
});
