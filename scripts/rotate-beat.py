#!/usr/bin/env python3
"""Manual / admin fallback for ballot rotate.

Primary scheduler is Cloudflare Workers Cron Triggers on workers/ballot-api
(UTC 0 0,8,16 * * *). This script is not crontab and not a Grok Bot routine.

Use when Cron failed or you need to git-sync KV snapshots. Does not use GitHub Issues.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import quote
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TRACKING = ROOT / "tracking"
CONFIG_PATH = TRACKING / "rotate-config.json"
ARSENAL_PATH = TRACKING / "arsenal.json"
BALLOT_PATH = TRACKING / "ballot-window.json"
LEDGER_PATH = TRACKING / "vote-ledger.json"
SEEN_PATH = TRACKING / "seen-bookmarks.json"

# TODO(X ingest) sample candidate shape — do not write this fake row into ballot-window.json.
SAMPLE_CANDIDATE = {
    "id": "<tweet-id>",
    "url": "https://x.com/<handle>/status/<tweet-id>",
    "titleZh": "<中文标题>",
    "author": "<handle>",
    "planZh": "<自动起草的演示计划预览：做什么、交互、技术栈建议>",
    "suggestedSlug": "<kebab-case-slug>",
    "status": "open",
}


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, data: Any) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    if not path.parent.exists():
        path.parent.mkdir(parents=True)
    path.write_text(text, encoding="utf-8")


def iso_z(dt: datetime) -> str:
    utc = dt.astimezone(timezone.utc)
    return utc.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_iso(value: str) -> datetime:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    return datetime.fromisoformat(raw).astimezone(timezone.utc)


def slot_hours(cfg: dict) -> list[int]:
    slots = cfg.get("slotHours")
    if isinstance(slots, list) and slots:
        return sorted({int(h) % 24 for h in slots})
    period = int(cfg.get("periodHours") or 8)
    if period <= 0:
        period = 8
    return list(range(0, 24, period))


def tzinfo(cfg: dict) -> ZoneInfo:
    return ZoneInfo(str(cfg.get("timezone") or "Asia/Shanghai"))


def period_hours(cfg: dict) -> int:
    n = int(cfg.get("periodHours") or 8)
    return n if n > 0 else 8


def window_id_for(start_local: datetime) -> str:
    return start_local.strftime("%Y-%m-%d-") + f"{start_local.hour:02d}"


def containing_window(now_utc: datetime, cfg: dict) -> tuple[datetime, datetime]:
    tz = tzinfo(cfg)
    period = period_hours(cfg)
    slots = slot_hours(cfg)
    now_local = now_utc.astimezone(tz)
    hour = now_local.hour
    if hour < slots[0]:
        start = now_local.replace(hour=slots[-1], minute=0, second=0, microsecond=0) - timedelta(days=1)
    else:
        start_h = max(s for s in slots if s <= hour)
        start = now_local.replace(hour=start_h, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=period)
    return start, end


def next_window_after(close_utc: datetime, cfg: dict) -> tuple[datetime, datetime]:
    start, end = containing_window(close_utc, cfg)
    if start.astimezone(timezone.utc) < close_utc:
        start, end = containing_window(close_utc + timedelta(seconds=1), cfg)
    return start, end


def active_options(arsenal: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {"fuel": [], "harness": [], "environment": []}
    for sec in arsenal.get("sections") or []:
        kind = sec.get("id")
        if kind not in out:
            continue
        for item in sec.get("items") or []:
            if item.get("status") != "active":
                continue
            name = str(item.get("nameZh") or item.get("name") or "").strip()
            if name:
                out[kind].append(name)
    return out


def plurality(counts: dict[str, int], allowed: list[str]) -> str | None:
    if not counts:
        return None
    best_n = -1
    best: str | None = None
    for name in allowed:
        n = int(counts.get(name) or 0)
        if n > best_n:
            best_n = n
            best = name
    if best_n <= 0:
        return None
    return best


class TallyFetchError(Exception):
    """Vote API was not reached or did not return a usable tally payload."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


def vote_api_base(cfg: dict) -> str:
    env = os.environ.get("VOTE_API_BASE", "").strip()
    if env:
        return env.rstrip("/")
    return str(cfg.get("voteApiBase") or "").strip().rstrip("/")


def fetch_worker_json(base: str, path: str) -> dict[str, Any] | None:
    if not base:
        return None
    url = f"{base}{path}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            data = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict) or not data.get("ok"):
        return None
    return data


def fetch_worker_window(base: str) -> dict[str, Any] | None:
    data = fetch_worker_json(base, "/api/window")
    if not data:
        return None
    window = data.get("window")
    return window if isinstance(window, dict) else None


def fetch_worker_ledger(base: str) -> dict[str, Any] | None:
    data = fetch_worker_json(base, "/api/ledger")
    if not data:
        return None
    ledger = data.get("ledger")
    return ledger if isinstance(ledger, dict) else None


def ballot_file_from_window(window: dict) -> dict[str, Any]:
    options = window.get("options") if isinstance(window.get("options"), dict) else {}
    candidates = window.get("candidates") if isinstance(window.get("candidates"), list) else []
    return {
        "version": int(window.get("version") or 1),
        "windowId": str(window.get("windowId") or ""),
        "timezone": str(window.get("timezone") or "Asia/Shanghai"),
        "periodHours": int(window.get("periodHours") or 8),
        "opensAt": str(window.get("opensAt") or ""),
        "closesAt": str(window.get("closesAt") or ""),
        "candidates": candidates,
        "options": {
            "fuel": list(options.get("fuel") or []),
            "harness": list(options.get("harness") or []),
            "environment": list(options.get("environment") or []),
        },
        "ingestNoteZh": str(
            window.get("ingestNoteZh")
            or "本窗无新书签增量：Worker Cron 不抓 X。仍可投燃料 / harness / 7×24。"
        ),
    }


def ledger_file_from_remote(ledger: dict) -> dict[str, Any]:
    return {
        "version": int(ledger.get("version") or 1),
        "lastSettleAt": ledger.get("lastSettleAt"),
        "settledWindowId": ledger.get("settledWindowId"),
        "voteCount": int(ledger.get("voteCount") or 0),
        "tallySource": ledger.get("tallySource"),
        "tallies": {
            "fuel": dict((ledger.get("tallies") or {}).get("fuel") or {}),
            "harness": dict((ledger.get("tallies") or {}).get("harness") or {}),
            "environment": dict((ledger.get("tallies") or {}).get("environment") or {}),
            "candidate": dict((ledger.get("tallies") or {}).get("candidate") or {}),
        },
        "winningStack": dict(ledger.get("winningStack") or {
            "fuel": None,
            "harness": None,
            "environment": None,
            "autoPick": True,
        }),
        "winningCandidateId": ledger.get("winningCandidateId"),
        "noteZh": str(ledger.get("noteZh") or ""),
    }


def ack_rotate_flags(base: str, token: str, *, needs_git_push: bool | None = None, needs_x_ingest: bool | None = None) -> None:
    if not base or not token:
        print("POST /api/rotate-status/ack skipped (need VOTE_API_BASE / voteApiBase and BALLOT_ADMIN_TOKEN)", file=sys.stderr)
        return
    payload: dict[str, Any] = {}
    if needs_git_push is False:
        payload["needsGitPush"] = False
    if needs_x_ingest is False:
        payload["needsXIngest"] = False
    if not payload:
        return
    url = f"{base}/api/rotate-status/ack"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            print(f"POST /api/rotate-status/ack -> {res.status}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"POST /api/rotate-status/ack failed: {exc}", file=sys.stderr)


def fetch_tallies(base: str, window_id: str) -> dict[str, Any]:
    if not window_id:
        raise TallyFetchError("missing_window", "ballot-window.json has no windowId")
    if not base:
        raise TallyFetchError(
            "no_api",
            "voteApiBase / VOTE_API_BASE is empty; refusing to treat as zero votes",
        )
    url = f"{base}/api/vote?windowId={quote(window_id, safe='')}"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode("utf-8")
            data = json.loads(raw)
    except urllib.error.HTTPError as exc:
        raise TallyFetchError("unavailable", f"HTTP {exc.code} from {url}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise TallyFetchError("unavailable", f"transport error for {url}: {exc}") from exc
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise TallyFetchError("unavailable", f"invalid tally JSON from {url}: {exc}") from exc
    if not isinstance(data, dict) or not data.get("ok"):
        raise TallyFetchError("unavailable", f"tally payload not ok from {url}")
    return data


def put_window(base: str, token: str, ballot: dict) -> None:
    if not base or not token:
        print("PUT /api/window skipped (need VOTE_API_BASE / voteApiBase and BALLOT_ADMIN_TOKEN)", file=sys.stderr)
        return
    url = f"{base}/api/window"
    payload = json.dumps(ballot, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="PUT",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            print(f"PUT /api/window -> {res.status}", file=sys.stderr)
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"PUT /api/window failed: {exc}", file=sys.stderr)


def sync_worker_snapshots_to_git(
    base: str,
    remote_window: dict[str, Any],
    *,
    dry_run: bool,
    no_git: bool,
    no_push: bool,
) -> int:
    """Copy Worker KV window + ledger into tracking JSON. Never invent X bookmarks."""
    ballot_file = ballot_file_from_window(remote_window)
    if not ballot_file.get("windowId") or not ballot_file.get("opensAt") or not ballot_file.get("closesAt"):
        print("ABORT KV→git sync: Worker /api/window payload missing windowId/opensAt/closesAt", file=sys.stderr)
        return 2
    ledger = fetch_worker_ledger(base)
    summary = {
        "action": "sync_kv_to_git",
        "nextWindowId": ballot_file["windowId"],
        "opensAt": ballot_file["opensAt"],
        "closesAt": ballot_file["closesAt"],
        "candidateCount": len(ballot_file["candidates"]),
        "ledgerSettledWindowId": (ledger or {}).get("settledWindowId"),
        "hadLedger": bool(ledger),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if dry_run:
        print("dry-run: would write tracking/ballot-window.json and tracking/vote-ledger.json")
        return 0
    dump_json(BALLOT_PATH, ballot_file)
    if ledger:
        dump_json(LEDGER_PATH, ledger_file_from_remote(ledger))
    else:
        print("GET /api/ledger missing; left tracking/vote-ledger.json unchanged", file=sys.stderr)
    maybe_commit_push(
        f"rotate: sync KV window {ballot_file['windowId']} to git",
        no_git=no_git,
        no_push=no_push,
        dry_run=dry_run,
    )
    ack_rotate_flags(
        base,
        os.environ.get("BALLOT_ADMIN_TOKEN", "").strip(),
        needs_git_push=False,
    )
    return 0


def ingest_x_bookmark_increments(period_start: datetime, period_end: datetime) -> list[dict[str, Any]]:
    """TODO: pull X bookmarks created in [period_start, period_end).

    Env hooks (never invent posts if unset):
      X_BEARER_TOKEN
      X_BOOKMARKS_USER_ID

    Skip ids already present in tracking/seen-bookmarks.json.
    Auto-draft titleZh / planZh / suggestedSlug for hub「待投票」.
    """
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    user_id = os.environ.get("X_BOOKMARKS_USER_ID", "").strip()
    if not token or not user_id:
        print(
            "X ingest: skipped (missing X_BEARER_TOKEN / X_BOOKMARKS_USER_ID); candidates=[]",
            file=sys.stderr,
        )
        return []
    seen_ids = set()
    if SEEN_PATH.exists():
        seen = load_json(SEEN_PATH)
        for item in seen.get("items") or []:
            if item and item.get("id"):
                seen_ids.add(str(item["id"]))
    print(
        "X ingest: TODO not implemented; refusing to fake bookmarks; candidates=[] "
        f"(period {iso_z(period_start)} .. {iso_z(period_end)}; seen={len(seen_ids)})",
        file=sys.stderr,
    )
    return []


def settle(ballot: dict, arsenal: dict, cfg: dict) -> dict[str, Any]:
    window_id = ballot.get("windowId")
    options = active_options(arsenal)
    base = vote_api_base(cfg)
    remote = fetch_tallies(base, str(window_id) if window_id else "")
    tallies = remote.get("tallies") or empty_tallies()
    vote_count = int(remote.get("voteCount") or 0)
    source = "api"

    auto_pick = vote_count <= 0
    winning = {
        "fuel": None if auto_pick else plurality(tallies.get("fuel") or {}, options["fuel"]),
        "harness": None if auto_pick else plurality(tallies.get("harness") or {}, options["harness"]),
        "environment": None if auto_pick else plurality(tallies.get("environment") or {}, options["environment"]),
        "autoPick": auto_pick,
    }
    if not auto_pick:
        # If a dimension had votes but none matched active names, still autoPick that dim via None;
        # if all three missing, treat as autoPick so orchestrator can choose.
        if not any([winning["fuel"], winning["harness"], winning["environment"]]):
            winning["autoPick"] = True

    cand_counts = {str(k): int(v) for k, v in (tallies.get("candidate") or {}).items()}
    winning_candidate = plurality(
        cand_counts,
        [str(c.get("id")) for c in (ballot.get("candidates") or []) if c and c.get("id")],
    )
    marked = []
    for cand in ballot.get("candidates") or []:
        row = dict(cand)
        if winning_candidate and str(row.get("id")) == str(winning_candidate):
            row["status"] = "won"
        else:
            row["status"] = "skipped"
        marked.append(row)

    now = datetime.now(timezone.utc)
    ledger = {
        "version": 1,
        "lastSettleAt": iso_z(now),
        "settledWindowId": window_id,
        "voteCount": vote_count,
        "tallySource": source,
        "tallies": {
            "fuel": tallies.get("fuel") or {},
            "harness": tallies.get("harness") or {},
            "environment": tallies.get("environment") or {},
            "candidate": tallies.get("candidate") or {},
        },
        "winningStack": winning,
        "winningCandidateId": winning_candidate,
        "noteZh": (
            "零票，autoPick=true，编排器可从军火库启用项自选。"
            if winning["autoPick"]
            else "已按 Worker 计票选出本窗燃料 / harness / 7×24。"
        ),
    }
    return {"ledger": ledger, "candidates": marked}


def empty_tallies() -> dict[str, Any]:
    return {"voteCount": 0, "fuel": {}, "harness": {}, "environment": {}, "candidate": {}}


def git(args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=check,
        text=True,
        capture_output=True,
    )


def maybe_commit_push(message: str, no_git: bool, no_push: bool, dry_run: bool) -> None:
    if no_git or dry_run:
        print("git skipped" if no_git else "git skipped (dry-run)")
        return
    git(["add", "tracking/ballot-window.json", "tracking/vote-ledger.json"])
    status = git(["status", "--porcelain"], check=True)
    if not status.stdout.strip():
        print("git: nothing to commit")
        return
    git(["commit", "-m", message])
    print(f"git commit: {message}")
    if no_push:
        print("git push skipped (--no-push)")
        return
    git(["push", "origin", "HEAD"])
    print("git push: origin HEAD")


def self_test() -> int:
    cfg = {
        "timezone": "Asia/Shanghai",
        "periodHours": 8,
        "slotHours": [0, 8, 16],
    }
    now = parse_iso("2026-09-15T12:29:00.000Z")  # 20:29 CST
    start, end = containing_window(now, cfg)
    assert window_id_for(start) == "2026-09-15-16", window_id_for(start)
    assert iso_z(start) == "2026-09-15T08:00:00.000Z"
    assert iso_z(end) == "2026-09-15T16:00:00.000Z"

    cfg2 = {**cfg, "periodHours": 2, "slotHours": [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]}
    s2, e2 = containing_window(now, cfg2)
    assert window_id_for(s2) == "2026-09-15-20"
    assert (e2 - s2) == timedelta(hours=2)

    cfg1 = {**cfg, "periodHours": 1, "slotHours": list(range(24))}
    s1, e1 = containing_window(now, cfg1)
    assert window_id_for(s1) == "2026-09-15-20"
    assert (e1 - s1) == timedelta(hours=1)

    assert plurality({"A": 2, "B": 2}, ["B", "A"]) == "B"
    assert plurality({}, ["A"]) is None

    close = parse_iso("2026-09-15T16:00:00.000Z")
    nstart, nend = next_window_after(close, cfg)
    assert window_id_for(nstart) == "2026-09-16-00", window_id_for(nstart)
    assert iso_z(nstart) == "2026-09-15T16:00:00.000Z"
    assert iso_z(nend) == "2026-09-16T00:00:00.000Z"

    try:
        fetch_tallies("", "2026-09-15-16")
        raise AssertionError("empty voteApiBase must abort")
    except TallyFetchError as exc:
        assert exc.code == "no_api"
    try:
        fetch_tallies("https://example.invalid", "")
        raise AssertionError("missing windowId must abort")
    except TallyFetchError as exc:
        assert exc.code == "missing_window"
    assert fetch_worker_window("") is None
    assert fetch_worker_ledger("") is None
    mapped = ballot_file_from_window({
        "windowId": "2026-09-16-00",
        "timezone": "Asia/Shanghai",
        "periodHours": 8,
        "opensAt": "2026-09-15T16:00:00.000Z",
        "closesAt": "2026-09-16T00:00:00.000Z",
        "candidates": [],
        "options": {"fuel": ["Cursor Ultra"], "harness": ["Cursor Cloud Agent"], "environment": ["托管机"]},
        "ingestNoteZh": "Worker Cron 不抓 X",
    })
    assert mapped["windowId"] == "2026-09-16-00"
    assert mapped["candidates"] == []
    assert "伪造" not in mapped["ingestNoteZh"]
    ledger_mapped = ledger_file_from_remote({
        "settledWindowId": "2026-09-15-16",
        "voteCount": 2,
        "tallySource": "kv",
        "tallies": {"fuel": {"Cursor Ultra": 2}, "harness": {}, "environment": {}, "candidate": {}},
        "winningStack": {"fuel": "Cursor Ultra", "harness": None, "environment": None, "autoPick": False},
        "winningCandidateId": None,
        "noteZh": "ok",
    })
    assert ledger_mapped["settledWindowId"] == "2026-09-15-16"
    assert ledger_mapped["voteCount"] == 2
    print("self-test ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Settle ballot window and open the next Shanghai slot.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-git", action="store_true")
    parser.add_argument("--no-push", action="store_true")
    parser.add_argument("--force", action="store_true", help="Settle even if the current window is still open.")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return self_test()

    cfg = load_json(CONFIG_PATH)
    arsenal = load_json(ARSENAL_PATH)
    ballot = load_json(BALLOT_PATH)
    now = datetime.now(timezone.utc)
    closes = parse_iso(str(ballot["closesAt"]))
    opens = parse_iso(str(ballot["opensAt"]))
    base = vote_api_base(cfg)

    if not args.force:
        remote_window = fetch_worker_window(base)
        if remote_window and remote_window.get("windowId") and remote_window.get("windowId") != ballot.get("windowId"):
            print(
                f"Worker Cron already opened {remote_window.get('windowId')} "
                f"(git JSON still {ballot.get('windowId')}); sync KV → git, skip python settle.",
                file=sys.stderr,
            )
            return sync_worker_snapshots_to_git(
                base,
                remote_window,
                dry_run=args.dry_run,
                no_git=args.no_git,
                no_push=args.no_push,
            )

    if now < closes and not args.force:
        print(f"window {ballot.get('windowId')} still open until {ballot.get('closesAt')}; nothing to settle")
        return 0

    try:
        settled = settle(ballot, arsenal, cfg)
    except TallyFetchError as exc:
        print(
            f"ABORT settle: cannot read tallies ({exc}). "
            "Not treating as zero votes; leaving ballot-window and vote-ledger unchanged; no git push.",
            file=sys.stderr,
        )
        return 2
    want_start, want_end = containing_window(now, cfg)
    # Never reopen the window we just settled; if still inside it (or exactly on close), advance.
    if (
        want_start.astimezone(timezone.utc) <= closes
        or window_id_for(want_start) == ballot.get("windowId")
    ):
        want_start, want_end = next_window_after(closes, cfg)

    ingest_start, ingest_end = opens, closes
    candidates = ingest_x_bookmark_increments(ingest_start, ingest_end)
    options = active_options(arsenal)
    next_ballot = {
        "version": 1,
        "windowId": window_id_for(want_start),
        "timezone": cfg.get("timezone") or "Asia/Shanghai",
        "periodHours": period_hours(cfg),
        "opensAt": iso_z(want_start),
        "closesAt": iso_z(want_end),
        "candidates": candidates,
        "options": options,
        "ingestNoteZh": (
            "本窗无新书签增量：尚未配置 X 凭证或 ingest 未实现，cron 不会伪造书签。仍可投燃料 / harness / 7×24。"
            if not candidates
            else f"已摄入 {len(candidates)} 条刚结束时段的书签增量，作为本窗待投票。"
        ),
    }

    print(
        json.dumps(
            {
                "settledWindowId": settled["ledger"]["settledWindowId"],
                "voteCount": settled["ledger"]["voteCount"],
                "winningStack": settled["ledger"]["winningStack"],
                "nextWindowId": next_ballot["windowId"],
                "opensAt": next_ballot["opensAt"],
                "closesAt": next_ballot["closesAt"],
                "candidateCount": len(candidates),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    if args.dry_run:
        return 0

    dump_json(LEDGER_PATH, settled["ledger"])
    dump_json(BALLOT_PATH, next_ballot)
    put_window(vote_api_base(cfg), os.environ.get("BALLOT_ADMIN_TOKEN", "").strip(), next_ballot)
    maybe_commit_push(
        f"rotate: settle {settled['ledger']['settledWindowId']}, open {next_ballot['windowId']}",
        no_git=args.no_git,
        no_push=args.no_push,
        dry_run=args.dry_run,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr or exc.stdout or str(exc))
        raise SystemExit(exc.returncode)
