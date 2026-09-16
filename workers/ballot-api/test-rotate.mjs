import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containingWindow,
  windowIdFor,
  isoZ,
  nextWindowAfter,
  plurality,
  settleFromTallies,
  nextBallotSnapshot,
  runRotate,
  ackRotateFlags,
  periodHours,
  LOCK_TTL_S,
  KV_MIN_TTL_S,
  kvTtl
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
  assert.equal(storedSkip.needsGitPush, true);
  assert.equal(storedSkip.needsXIngest, true);

  await kv.put("rotate-lock", "held-by-other");
  const locked = await runRotate(env, {
    nowMs: parseIso("2026-09-15T20:00:00.000Z"),
    skipLock: false,
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
    nowMs: parseIso("2026-09-15T12:29:00.000Z"),
    skipLock: false,
    fetchImpl: mockFetch()
  });
  assert.equal(status.action, "skipped_open");
  const lockPuts = kv.puts.filter(function (p) { return p.key === "rotate-lock"; });
  assert.ok(lockPuts.length >= 1);
  const ttl = lockPuts[0].options.expirationTtl;
  assert.ok(ttl >= 60);
  assert.equal(ttl, kvTtl(LOCK_TTL_S));
  assert.equal(await kv.get("rotate-lock"), null);
});

test("runRotate unexpected throw writes fail status instead of bubbling", async () => {
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
  assert.equal(status.error, "kv_unavailable");
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, true);
  const stored = await origGet("rotate-status", "json");
  assert.equal(stored.ok, false);
  assert.equal(stored.error, "kv_unavailable");
  assert.equal(stored.needsGitPush, true);
  assert.equal(stored.needsXIngest, true);
});

test("claimLock KV put throw writes rotate-status instead of bubbling", async () => {
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
  assert.match(status.error, /Expiration TTL must be at least 60/);
  assert.equal(status.needsGitPush, true);
  assert.equal(status.needsXIngest, false);
  const stored = await kv.get("rotate-status", "json");
  assert.equal(stored.ok, false);
  assert.match(stored.error, /Expiration TTL must be at least 60/);
});
