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
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
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
INBOX_DIR = TRACKING / "inbox"
SLIM_LATEST_PATH = INBOX_DIR / "x-bookmarks-slim-latest.json"
SLIM_FALLBACK_PATH = INBOX_DIR / "x-bookmarks-slim.json"
SLUG_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Candidate shape for hub「待投票」— never write this placeholder row into ballot-window.json.
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


def window_rank(window: dict | None) -> tuple[float | None, str] | None:
    """Comparable rank: opensAt epoch when parseable, then sortable windowId (YYYY-MM-DD-HH)."""
    if not isinstance(window, dict):
        return None
    wid = str(window.get("windowId") or "").strip()
    if not wid:
        return None
    opens_raw = str(window.get("opensAt") or "").strip()
    ts: float | None = None
    if opens_raw:
        try:
            ts = parse_iso(opens_raw).timestamp()
        except (TypeError, ValueError, OSError):
            ts = None
    return (ts, wid)


def is_strictly_ahead(candidate: dict | None, baseline: dict | None) -> bool:
    """True only if candidate is strictly after baseline (not mere windowId inequality)."""
    cr = window_rank(candidate)
    br = window_rank(baseline)
    if cr is None or br is None:
        return False
    c_ts, c_id = cr
    b_ts, b_id = br
    if c_id == b_id:
        return False
    if c_ts is not None and b_ts is not None and c_ts != b_ts:
        return c_ts > b_ts
    return c_id > b_id


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
    git_result = maybe_commit_push(
        f"rotate: sync KV window {ballot_file['windowId']} to git",
        no_git=no_git,
        no_push=no_push,
        dry_run=dry_run,
    )
    if git_result == "pushed":
        ack_rotate_flags(
            base,
            os.environ.get("BALLOT_ADMIN_TOKEN", "").strip(),
            needs_git_push=False,
        )
    else:
        print(
            f"ack needsGitPush skipped (git result={git_result}; "
            "only ack after tracking JSON is committed and pushed)",
            file=sys.stderr,
        )
    if git_result == "failed":
        return 2
    return 0


def resolve_slim_path(explicit: Path | str | None = None) -> Path | None:
    """Firstmate X MCP slim JSON: env override, else inbox latest / fallback."""
    if explicit is not None:
        path = Path(explicit)
        return path if path.exists() else None
    env = os.environ.get("X_BOOKMARKS_SLIM_PATH", "").strip()
    if env:
        path = Path(env).expanduser()
        if not path.is_absolute():
            path = ROOT / path
        return path if path.exists() else None
    for path in (SLIM_LATEST_PATH, SLIM_FALLBACK_PATH):
        if path.exists():
            return path
    return None


class IngestError(Exception):
    """Bookmark ingest aborted (fail closed)."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


@dataclass
class SlimIngestResult:
    incoming: list[dict[str, Any]]
    path: Path | None
    slim_found: bool
    has_more: bool
    skipped_seen: int = 0
    skipped_window: int = 0
    skipped_bad: int = 0


def load_seen_ids(seen_path: Path | None = None) -> set[str]:
    """Load processed bookmark ids. Missing file → empty set. Corrupt file → fail closed."""
    path = seen_path if seen_path is not None else SEEN_PATH
    ids: set[str] = set()
    if not path.exists():
        return ids
    try:
        seen = load_json(path)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as exc:
        raise IngestError("seen_corrupt", f"failed to read {path}: {exc}") from exc
    items = seen.get("items") if isinstance(seen, dict) else None
    if not isinstance(items, list):
        raise IngestError("seen_corrupt", f"{path} missing list field items")
    for item in items:
        if isinstance(item, dict) and item.get("id"):
            ids.add(str(item["id"]).strip())
    return ids


def slim_item_rows(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        items = data.get("items")
        if isinstance(items, list):
            return [row for row in items if isinstance(row, dict)]
    return []


def item_period_timestamp(item: dict[str, Any]) -> tuple[str, datetime] | None:
    """Prefer bookmarked_at / bookmarkedAt, else created_at / createdAt."""
    for field in ("bookmarked_at", "bookmarkedAt", "created_at", "createdAt"):
        raw = item.get(field)
        if raw is None:
            continue
        text = str(raw).strip()
        if not text:
            continue
        try:
            return field, parse_iso(text)
        except (TypeError, ValueError, OSError):
            continue
    return None


def draft_title_zh(text: str) -> str:
    first = " ".join((text or "").strip().splitlines()[0].split()) if (text or "").strip() else ""
    if not first:
        return "未命名书签演示"
    if len(first) > 42:
        return first[:42].rstrip() + " …"
    return first


def draft_suggested_slug(text: str, tweet_id: str) -> str:
    first = (text or "").strip().splitlines()[0] if text else ""
    words = SLUG_TOKEN_RE.findall(first.lower())
    slug = "-".join(words).strip("-")
    if not slug:
        return f"x-{tweet_id}"
    if len(slug) > 40:
        slug = slug[:40].rstrip("-")
        if "-" in slug:
            cut = slug.rsplit("-", 1)[0]
            if cut:
                slug = cut
    return slug or f"x-{tweet_id}"


def draft_plan_zh(author: str, text: str) -> str:
    first = " ".join((text or "").strip().splitlines()[0].split()) if (text or "").strip() else ""
    snippet = first[:36].rstrip() if first else "原帖"
    handle = f"@{author}" if author else "原帖"
    return (
        f"把 {handle} 这条关于「{snippet}」的演示做成可点 sticky demo："
        "保留原帖核心交互/视觉，中文说明 + 一页可玩。"
        "技术栈待枢纽投票（燃料/harness/7×24）。"
    )


def candidate_from_slim_item(item: dict[str, Any]) -> dict[str, Any] | None:
    tweet_id = str(item.get("id") or "").strip()
    url = str(item.get("url") or "").strip()
    if not tweet_id or not url:
        return None
    author = str(item.get("author") or "").strip().lstrip("@")
    text = str(item.get("text") or item.get("title") or "").strip()
    return {
        "id": tweet_id,
        "url": url,
        "titleZh": draft_title_zh(text),
        "author": author,
        "planZh": draft_plan_zh(author, text),
        "suggestedSlug": draft_suggested_slug(text, tweet_id),
        "status": "open",
    }


def ingest_note_zh(
    candidate_count: int,
    *,
    slim_found: bool,
    parse_failed: bool = False,
    has_more: bool = False,
    merged: bool = False,
) -> str:
    if parse_failed:
        return (
            "本窗书签 ingest 失败：Firstmate X MCP slim JSON 存在但读取/解析失败，未整表替换候选。"
            "Worker Cron 不抓 X。绝不伪造书签。仍可投燃料 / harness / 7×24。"
        )
    more = "slim 标注 has_more=true（可能还有后续页）。" if has_more else ""
    mode = (
        "已按 id 合并，未删除 slim 中未出现的既有候选。"
        if merged
        else "已按 slim 全量替换候选。"
    )
    if candidate_count > 0:
        return (
            f"已摄入 {candidate_count} 条本窗书签候选（Firstmate X MCP slim）。{more}{mode}"
            "仍可投燃料 / harness / 7×24。"
        )
    if not slim_found:
        return (
            "本窗无新书签增量：未找到 Firstmate X MCP slim JSON"
            "（X_BOOKMARKS_SLIM_PATH 或 tracking/inbox/x-bookmarks-slim-latest.json）。"
            "Worker Cron 不抓 X。官方自建 X App / X_BEARER_TOKEN 非主线（船长 2026-09-16）。"
            "仍可投燃料 / harness / 7×24。"
        )
    keep = "保留既有候选。" if merged else ""
    return (
        f"本窗无新书签增量：Firstmate X MCP slim 已读，{more}本窗无未见过的书签 id。{keep}"
        "Worker Cron 不抓 X。绝不伪造书签。仍可投燃料 / harness / 7×24。"
    )


def slim_has_more(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    flag = data.get("has_more")
    return flag is True or flag == 1 or str(flag).strip().lower() == "true"


def merge_candidates_by_id(
    existing: list[Any],
    incoming: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Add/update slim ids; never drop existing open rows absent from this page."""
    incoming_by_id: dict[str, dict[str, Any]] = {}
    incoming_order: list[str] = []
    for row in incoming:
        cid = str(row.get("id") or "").strip()
        if not cid or cid in incoming_by_id:
            continue
        incoming_by_id[cid] = row
        incoming_order.append(cid)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in existing:
        if not isinstance(raw, dict):
            continue
        cid = str(raw.get("id") or "").strip()
        if cid and cid in incoming_by_id:
            out.append(incoming_by_id[cid])
            seen.add(cid)
        else:
            out.append(dict(raw))
            if cid:
                seen.add(cid)
    for cid in incoming_order:
        if cid not in seen:
            out.append(incoming_by_id[cid])
    return out


def apply_ingest_candidates(
    existing: list[Any],
    incoming: list[dict[str, Any]],
    *,
    replace: bool,
    has_more: bool,
) -> list[dict[str, Any]]:
    if replace:
        if has_more:
            raise IngestError(
                "incomplete_replace",
                "slim has_more=true; refusing to wholesale replace candidates with a partial page "
                "(omit --replace-candidates to merge by id)",
            )
        return [dict(row) for row in incoming]
    return merge_candidates_by_id(existing, incoming)


def ingest_x_bookmark_increments(
    period_start: datetime,
    period_end: datetime,
    *,
    slim_path: Path | str | None = None,
    seen_path: Path | None = None,
) -> SlimIngestResult:
    """Read Firstmate-side X MCP slim JSON; never invent tweet ids/urls.

    Path: env X_BOOKMARKS_SLIM_PATH, else tracking/inbox/x-bookmarks-slim-latest.json,
    else tracking/inbox/x-bookmarks-slim.json. Official X App / X_BEARER_TOKEN is
    not mainline (captain order 2026-09-16). Missing file → incoming=[].

    Period filter is [period_start, period_end) on bookmarked_at/bookmarkedAt,
    else created_at. Skip tracking/seen-bookmarks.json ids.
    Corrupt seen file or unreadable slim JSON raises IngestError (fail closed).
    """
    path = resolve_slim_path(slim_path)
    if path is None:
        print(
            "X ingest: skipped (no Firstmate X MCP slim JSON at "
            "X_BOOKMARKS_SLIM_PATH / tracking/inbox/x-bookmarks-slim-latest.json / "
            "tracking/inbox/x-bookmarks-slim.json); incoming=[]",
            file=sys.stderr,
        )
        return SlimIngestResult(incoming=[], path=None, slim_found=False, has_more=False)

    try:
        data = load_json(path)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError, TypeError, ValueError) as exc:
        print(f"X ingest: failed to parse {path}: {exc}", file=sys.stderr)
        raise IngestError("parse_failed", f"failed to read/parse {path}: {exc}") from exc

    start = period_start.astimezone(timezone.utc)
    end = period_end.astimezone(timezone.utc)
    seen_ids = load_seen_ids(seen_path)
    skipped_seen = 0
    skipped_window = 0
    skipped_bad = 0
    incoming: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    has_more = slim_has_more(data)

    for item in slim_item_rows(data):
        stamp = item_period_timestamp(item)
        if stamp is None:
            skipped_bad += 1
            continue
        _field, when = stamp
        if when < start or when >= end:
            skipped_window += 1
            continue
        tweet_id = str(item.get("id") or "").strip()
        if tweet_id and tweet_id in seen_ids:
            skipped_seen += 1
            continue
        if tweet_id and tweet_id in used_ids:
            skipped_seen += 1
            continue
        row = candidate_from_slim_item(item)
        if row is None:
            skipped_bad += 1
            continue
        used_ids.add(row["id"])
        incoming.append(row)

    print(
        f"X ingest: {path} period {iso_z(start)} .. {iso_z(end)}; "
        f"incoming={len(incoming)} has_more={has_more} skipped_seen={skipped_seen} "
        f"skipped_out_of_window={skipped_window} skipped_bad={skipped_bad}",
        file=sys.stderr,
    )
    return SlimIngestResult(
        incoming=incoming,
        path=path,
        slim_found=True,
        has_more=has_more,
        skipped_seen=skipped_seen,
        skipped_window=skipped_window,
        skipped_bad=skipped_bad,
    )


def run_ingest_only(*, dry_run: bool, replace_candidates: bool) -> int:
    """Refresh current ballot-window.json candidates from slim JSON; do not settle.

    Default is merge-by-id (keep existing open candidates absent from this slim page).
    """
    ballot = load_json(BALLOT_PATH)
    existing = list(ballot.get("candidates") or [])
    opens = parse_iso(str(ballot["opensAt"]))
    closes = parse_iso(str(ballot["closesAt"]))
    slim = resolve_slim_path()
    if slim is None:
        print(
            "ingest-only: slim JSON missing; leaving tracking/ballot-window.json candidates unchanged",
            file=sys.stderr,
        )
        return 0
    try:
        result = ingest_x_bookmark_increments(opens, closes)
        candidates = apply_ingest_candidates(
            existing,
            result.incoming,
            replace=replace_candidates,
            has_more=result.has_more,
        )
    except IngestError as exc:
        print(f"ABORT ingest-only: {exc}", file=sys.stderr)
        if exc.code == "parse_failed" and not dry_run:
            ballot["ingestNoteZh"] = ingest_note_zh(
                len(existing), slim_found=True, parse_failed=True, merged=not replace_candidates
            )
            dump_json(BALLOT_PATH, ballot)
        return 2
    note = ingest_note_zh(
        len(result.incoming),
        slim_found=True,
        has_more=result.has_more,
        merged=not replace_candidates,
    )
    summary = {
        "action": "ingest_only",
        "windowId": ballot.get("windowId"),
        "opensAt": ballot.get("opensAt"),
        "closesAt": ballot.get("closesAt"),
        "slimPath": str(result.path or slim),
        "hasMore": result.has_more,
        "replaceCandidates": replace_candidates,
        "candidateCount": len(candidates),
        "candidateIds": [c.get("id") for c in candidates],
        "incomingIds": [c.get("id") for c in result.incoming],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if dry_run:
        print("dry-run: would update tracking/ballot-window.json candidates + ingestNoteZh")
        return 0
    ballot["candidates"] = candidates
    ballot["ingestNoteZh"] = note
    dump_json(BALLOT_PATH, ballot)
    return 0


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


def maybe_commit_push(message: str, no_git: bool, no_push: bool, dry_run: bool) -> str:
    if dry_run:
        print("git skipped (dry-run)")
        return "dry_run"
    if no_git:
        print("git skipped")
        return "no_git"
    try:
        git(["add", "tracking/ballot-window.json", "tracking/vote-ledger.json"])
        status = git(["status", "--porcelain"], check=True)
        if status.stdout.strip():
            git(["commit", "-m", message])
            print(f"git commit: {message}")
        else:
            print("git: nothing to commit")
        if no_push:
            print("git push skipped (--no-push)")
            return "no_push"
        git(["push", "origin", "HEAD"])
        print("git push: origin HEAD")
        return "pushed"
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr or exc.stdout or str(exc) or "")
        print("git commit/push failed", file=sys.stderr)
        return "failed"


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
    git_w = {
        "windowId": "2026-09-15-16",
        "opensAt": "2026-09-15T08:00:00.000Z",
    }
    worker_newer = {
        "windowId": "2026-09-16-00",
        "opensAt": "2026-09-15T16:00:00.000Z",
    }
    worker_older = {
        "windowId": "2026-09-15-08",
        "opensAt": "2026-09-15T00:00:00.000Z",
    }
    assert is_strictly_ahead(worker_newer, git_w)
    assert not is_strictly_ahead(git_w, worker_newer)
    assert not is_strictly_ahead(worker_older, git_w)
    assert is_strictly_ahead(git_w, worker_older)
    assert not is_strictly_ahead(git_w, git_w)
    assert not is_strictly_ahead(git_w, {"windowId": "2026-09-15-16", "opensAt": "2026-09-15T08:00:00.000Z"})
    # Mere inequality of ids is not enough if git is later.
    assert not is_strictly_ahead(
        {"windowId": "2026-09-15-08", "opensAt": "2026-09-15T00:00:00.000Z"},
        {"windowId": "2026-09-15-16", "opensAt": "2026-09-15T08:00:00.000Z"},
    )
    assert maybe_commit_push("x", no_git=True, no_push=False, dry_run=False) == "no_git"
    assert maybe_commit_push("x", no_git=False, no_push=False, dry_run=True) == "dry_run"
    self_test_ingest()
    print("self-test ok")
    return 0


def self_test_ingest() -> None:
    """Temp slim fixture: 1 in-window + 1 out-of-window + 1 seen → only the unknown in-window."""
    start = parse_iso("2026-09-16T00:00:00.000Z")
    end = parse_iso("2026-09-16T08:00:00.000Z")
    in_id = "1999000000000000001"
    out_id = "1999000000000000002"
    seen_id = "1999000000000000003"
    payload = {
        "source": "self-test fixture",
        "items": [
            {
                "id": in_id,
                "url": f"https://x.com/alice/status/{in_id}",
                "created_at": "2026-09-16T03:00:00.000Z",
                "author": "alice",
                "text": "Realtime canvas particles for a tiny playable demo",
            },
            {
                "id": out_id,
                "url": f"https://x.com/bob/status/{out_id}",
                "created_at": "2026-09-15T12:00:00.000Z",
                "author": "bob",
                "text": "Yesterday's post should be excluded",
            },
            {
                "id": seen_id,
                "url": f"https://x.com/carol/status/{seen_id}",
                "bookmarked_at": "2026-09-16T04:00:00.000Z",
                "created_at": "2026-09-16T04:00:00.000Z",
                "author": "carol",
                "text": "Already processed bookmark",
            },
        ],
    }
    previous_env = os.environ.get("X_BOOKMARKS_SLIM_PATH")
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        slim = tmp_path / "slim.json"
        seen = tmp_path / "seen.json"
        dump_json(slim, payload)
        dump_json(seen, {"version": 1, "items": [{"id": seen_id}]})

        missing = ingest_x_bookmark_increments(
            start, end, slim_path=tmp_path / "missing.json", seen_path=seen
        )
        assert missing.incoming == []
        assert missing.slim_found is False

        got = ingest_x_bookmark_increments(start, end, slim_path=slim, seen_path=seen)
        assert [row["id"] for row in got.incoming] == [in_id], [row["id"] for row in got.incoming]
        row = got.incoming[0]
        assert row["url"] == f"https://x.com/alice/status/{in_id}"
        assert row["author"] == "alice"
        assert row["status"] == "open"
        assert set(row) == {"id", "url", "titleZh", "author", "planZh", "suggestedSlug", "status"}
        assert in_id in row["suggestedSlug"] or row["suggestedSlug"].startswith("realtime-canvas")
        assert "alice" in row["planZh"]
        assert "伪造" not in row["titleZh"]

        os.environ["X_BOOKMARKS_SLIM_PATH"] = str(slim)
        try:
            via_env = ingest_x_bookmark_increments(start, end, seen_path=seen)
            assert [row["id"] for row in via_env.incoming] == [in_id]
        finally:
            if previous_env is None:
                os.environ.pop("X_BOOKMARKS_SLIM_PATH", None)
            else:
                os.environ["X_BOOKMARKS_SLIM_PATH"] = previous_env

        # Prefer bookmarked_at over created_at: in-window created_at must not override out-of-window bookmark time.
        prefer = tmp_path / "prefer.json"
        dump_json(
            prefer,
            {
                "items": [
                    {
                        "id": "1999000000000000004",
                        "url": "https://x.com/dave/status/1999000000000000004",
                        "bookmarked_at": "2026-09-15T20:00:00.000Z",
                        "created_at": "2026-09-16T03:00:00.000Z",
                        "author": "dave",
                        "text": "created in window but bookmarked earlier",
                    }
                ]
            },
        )
        assert ingest_x_bookmark_increments(start, end, slim_path=prefer, seen_path=seen).incoming == []

        camel = tmp_path / "camel.json"
        dump_json(
            camel,
            {
                "items": [
                    {
                        "id": "1999000000000000005",
                        "url": "https://x.com/erin/status/1999000000000000005",
                        "bookmarkedAt": "2026-09-16T01:00:00.000Z",
                        "created_at": "2026-09-15T01:00:00.000Z",
                        "author": "erin",
                        "text": "书签时间在窗内，发帖时间在窗外",
                    }
                ]
            },
        )
        camel_got = ingest_x_bookmark_increments(start, end, slim_path=camel, seen_path=seen)
        assert [row["id"] for row in camel_got.incoming] == ["1999000000000000005"]
        assert camel_got.incoming[0]["titleZh"] == "书签时间在窗内，发帖时间在窗外"

        # Merge-by-id keeps existing open candidates absent from a partial has_more page.
        existing_keep = {
            "id": "1999000000000000009",
            "url": "https://x.com/keep/status/1999000000000000009",
            "titleZh": "既有候选",
            "author": "keep",
            "planZh": "保留",
            "suggestedSlug": "keep",
            "status": "open",
        }
        payload_more = dict(payload)
        payload_more["has_more"] = True
        dump_json(slim, payload_more)
        partial = ingest_x_bookmark_increments(start, end, slim_path=slim, seen_path=seen)
        assert partial.has_more is True
        merged = apply_ingest_candidates(
            [existing_keep], partial.incoming, replace=False, has_more=True
        )
        assert [row["id"] for row in merged] == ["1999000000000000009", in_id]
        try:
            apply_ingest_candidates([existing_keep], partial.incoming, replace=True, has_more=True)
            raise AssertionError("replace + has_more must refuse")
        except IngestError as exc:
            assert exc.code == "incomplete_replace"
        replaced = apply_ingest_candidates(
            [existing_keep], partial.incoming, replace=True, has_more=False
        )
        assert [row["id"] for row in replaced] == [in_id]

        # ingest-only note counts newly incoming rows, not post-merge kept total.
        keep_only = apply_ingest_candidates(
            [existing_keep], [], replace=False, has_more=True
        )
        assert [row["id"] for row in keep_only] == ["1999000000000000009"]
        keep_note = ingest_note_zh(0, slim_found=True, has_more=True, merged=True)
        assert "无未见过的书签 id" in keep_note
        assert "保留既有候选" in keep_note
        assert "已摄入" not in keep_note
        assert "已摄入" in ingest_note_zh(len(keep_only), slim_found=True, merged=True)

        # Corrupt seen file fails closed (does not treat as empty seen).
        bad_seen = tmp_path / "seen-bad.json"
        bad_seen.write_text("{not json", encoding="utf-8")
        try:
            ingest_x_bookmark_increments(start, end, slim_path=slim, seen_path=bad_seen)
            raise AssertionError("corrupt seen must abort")
        except IngestError as exc:
            assert exc.code == "seen_corrupt"
        bad_seen.write_text('{"version":1}\n', encoding="utf-8")
        try:
            load_seen_ids(bad_seen)
            raise AssertionError("seen missing items must abort")
        except IngestError as exc:
            assert exc.code == "seen_corrupt"

        # Slim exists but parse fails: note says 读取/解析失败, never 「无未见 id」.
        bad_slim = tmp_path / "slim-bad.json"
        bad_slim.write_text("{not json", encoding="utf-8")
        try:
            ingest_x_bookmark_increments(start, end, slim_path=bad_slim, seen_path=seen)
            raise AssertionError("unreadable slim must abort")
        except IngestError as exc:
            assert exc.code == "parse_failed"
        parse_note = ingest_note_zh(0, slim_found=True, parse_failed=True)
        assert "解析失败" in parse_note or "读取" in parse_note
        assert "无未见" not in parse_note


def main() -> int:
    parser = argparse.ArgumentParser(description="Settle ballot window and open the next Shanghai slot.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-git", action="store_true")
    parser.add_argument("--no-push", action="store_true")
    parser.add_argument("--force", action="store_true", help="Settle even if the current window is still open.")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument(
        "--ingest-only",
        action="store_true",
        help="Merge Firstmate X MCP slim JSON into current ballot-window.json candidates; do not settle.",
    )
    parser.add_argument(
        "--replace-candidates",
        action="store_true",
        help="Wholesale replace candidates from slim instead of merge-by-id. Refused when slim has_more=true.",
    )
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    if args.ingest_only:
        return run_ingest_only(dry_run=args.dry_run, replace_candidates=args.replace_candidates)

    cfg = load_json(CONFIG_PATH)
    arsenal = load_json(ARSENAL_PATH)
    ballot = load_json(BALLOT_PATH)
    now = datetime.now(timezone.utc)
    closes = parse_iso(str(ballot["closesAt"]))
    opens = parse_iso(str(ballot["opensAt"]))
    base = vote_api_base(cfg)

    if not args.force:
        remote_window = fetch_worker_window(base)
        if remote_window and remote_window.get("windowId"):
            if is_strictly_ahead(remote_window, ballot):
                print(
                    f"Worker Cron is strictly ahead ({remote_window.get('windowId')} "
                    f"opens {remote_window.get('opensAt')}; git JSON still "
                    f"{ballot.get('windowId')}); sync KV → git, skip python settle.",
                    file=sys.stderr,
                )
                return sync_worker_snapshots_to_git(
                    base,
                    remote_window,
                    dry_run=args.dry_run,
                    no_git=args.no_git,
                    no_push=args.no_push,
                )
            if is_strictly_ahead(ballot, remote_window):
                print(
                    f"git JSON is ahead of Worker ({ballot.get('windowId')} vs "
                    f"{remote_window.get('windowId')}); not overwriting tracking JSON; "
                    "not acking needsGitPush. Healing Worker via PUT /api/window.",
                    file=sys.stderr,
                )
                if not args.dry_run:
                    put_window(base, os.environ.get("BALLOT_ADMIN_TOKEN", "").strip(), ballot)

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
    try:
        result = ingest_x_bookmark_increments(ingest_start, ingest_end)
        candidates = apply_ingest_candidates(
            [],
            result.incoming,
            replace=args.replace_candidates,
            has_more=result.has_more,
        )
    except IngestError as exc:
        print(
            f"ABORT settle ingest: {exc}. "
            "Not writing next ballot-window or vote-ledger; no git push.",
            file=sys.stderr,
        )
        return 2
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
        "ingestNoteZh": ingest_note_zh(
            len(candidates),
            slim_found=result.slim_found,
            has_more=result.has_more,
            merged=not args.replace_candidates,
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
    git_result = maybe_commit_push(
        f"rotate: settle {settled['ledger']['settledWindowId']}, open {next_ballot['windowId']}",
        no_git=args.no_git,
        no_push=args.no_push,
        dry_run=args.dry_run,
    )
    if git_result == "failed":
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr or exc.stdout or str(exc))
        raise SystemExit(exc.returncode)
