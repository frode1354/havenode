"""Persist scheduled crew jobs under backend/data/schedules.json."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from pydantic import BaseModel, Field

from .models import CrewPlan, TaskSchedule

_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
_PATH = os.path.join(_DATA_DIR, "schedules.json")
_lock = threading.Lock()


def _now() -> datetime:
    """Local wall clock with tzinfo — user-set times are local."""
    return datetime.now().astimezone()


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc).astimezone()
    return dt.isoformat()


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_now().tzinfo)
        return dt.astimezone()
    except ValueError:
        return None


class ScheduleJob(BaseModel):
    id: str = Field(default_factory=lambda: f"job_{uuid.uuid4().hex[:10]}")
    plan_name: str = ""
    title: str = ""
    plan: CrewPlan
    inputs: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    mode: str = "interval"  # interval | cron | once
    interval_minutes: int | None = 60
    cron: str | None = None
    run_at: str | None = None
    label: str = "定时运行"
    next_run_at: str | None = None
    last_run_at: str | None = None
    last_status: str | None = None  # ok | error | running
    last_error: str | None = None
    run_count: int = 0
    created_at: str = Field(default_factory=lambda: _iso(_now()) or "")
    updated_at: str = Field(default_factory=lambda: _iso(_now()) or "")


def extract_schedule_from_plan(plan: CrewPlan) -> TaskSchedule | None:
    """Prefer Start node schedule, else first enabled task schedule."""
    start = getattr(plan, "start", None)
    if start and start.schedule and start.schedule.enabled:
        return start.schedule
    if start and getattr(start, "trigger", None) == "schedule" and start.schedule:
        return start.schedule
    for task in plan.tasks:
        if task.schedule and task.schedule.enabled:
            return task.schedule
    return None


def compute_next_run(
    *,
    mode: str,
    interval_minutes: int | None,
    cron: str | None,
    run_at: str | None = None,
    from_dt: datetime | None = None,
) -> datetime | None:
    now = from_dt or _now()
    if now.tzinfo is None:
        now = now.replace(tzinfo=_now().tzinfo)

    if mode == "once":
        target = _parse_iso(run_at)
        if target is None:
            return None
        return target if target > now else None

    if mode == "cron" and cron and cron.strip():
        nxt = _next_cron(now, cron.strip())
        if nxt:
            return nxt

    minutes = max(1, int(interval_minutes or 60))
    return now + timedelta(minutes=minutes)


def _match_field(field: str, value: int) -> bool:
    field = field.strip()
    if field == "*":
        return True
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("*/"):
            try:
                step = int(part[2:])
                if step > 0 and value % step == 0:
                    return True
            except ValueError:
                continue
        elif "-" in part:
            try:
                a, b = part.split("-", 1)
                if int(a) <= value <= int(b):
                    return True
            except ValueError:
                continue
        else:
            try:
                if int(part) == value:
                    return True
            except ValueError:
                continue
    return False


def _cron_matches(dt: datetime, expr: str) -> bool:
    """Minimal 5-field cron against local wall time: minute hour dom month dow."""
    parts = expr.split()
    if len(parts) != 5:
        return False
    minute, hour, dom, month, dow = parts
    local = dt.astimezone()
    # Python weekday: Mon=0 … Sun=6 → cron often Sun=0
    cron_dow = (local.weekday() + 1) % 7
    return (
        _match_field(minute, local.minute)
        and _match_field(hour, local.hour)
        and _match_field(dom, local.day)
        and _match_field(month, local.month)
        and (_match_field(dow, cron_dow) or _match_field(dow, local.weekday() + 1))
    )


def _next_cron(after: datetime, expr: str) -> datetime | None:
    local = after.astimezone()
    cursor = local.replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(60 * 24 * 8):  # search up to ~8 days
        if _cron_matches(cursor, expr):
            return cursor
        cursor += timedelta(minutes=1)
    return None


def _load_raw() -> list[dict[str, Any]]:
    if not os.path.exists(_PATH):
        return []
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


def _save_raw(jobs: list[dict[str, Any]]) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    with open(_PATH, "w", encoding="utf-8") as f:
        json.dump(jobs, f, ensure_ascii=False, indent=2)


def list_jobs() -> list[ScheduleJob]:
    with _lock:
        out: list[ScheduleJob] = []
        for item in _load_raw():
            try:
                out.append(ScheduleJob.model_validate(item))
            except Exception:  # noqa: BLE001
                continue
        return out


def get_job(job_id: str) -> ScheduleJob | None:
    for job in list_jobs():
        if job.id == job_id:
            return job
    return None


def upsert_job(job: ScheduleJob) -> ScheduleJob:
    job.updated_at = _iso(_now()) or job.updated_at
    with _lock:
        raw = _load_raw()
        found = False
        for i, item in enumerate(raw):
            if item.get("id") == job.id:
                raw[i] = job.model_dump(mode="json")
                found = True
                break
        if not found:
            raw.append(job.model_dump(mode="json"))
        _save_raw(raw)
    return job


def delete_job(job_id: str) -> bool:
    with _lock:
        raw = _load_raw()
        nxt = [j for j in raw if j.get("id") != job_id]
        if len(nxt) == len(raw):
            return False
        _save_raw(nxt)
        return True


def create_job_from_plan(
    plan: CrewPlan,
    inputs: dict[str, str] | None = None,
    *,
    enabled: bool = True,
    mode: str | None = None,
    interval_minutes: int | None = None,
    cron: str | None = None,
    run_at: str | None = None,
    label: str | None = None,
) -> ScheduleJob:
    sched = extract_schedule_from_plan(plan)
    resolved_mode = mode or (sched.mode if sched else "interval") or "interval"
    interval = (
        interval_minutes
        if interval_minutes is not None
        else ((sched.interval_minutes if sched else 60) or 60)
    )
    resolved_cron = cron if cron is not None else (sched.cron if sched else None)
    resolved_run_at = run_at if run_at is not None else (sched.run_at if sched else None)
    resolved_label = label or (sched.label if sched else None) or "定时运行"
    now = _now()
    next_run = compute_next_run(
        mode=resolved_mode,
        interval_minutes=interval,
        cron=resolved_cron,
        run_at=resolved_run_at,
        from_dt=now,
    )

    from .plan_inputs import merge_kickoff_inputs

    merged_inputs = {
        str(k): str(v) for k, v in merge_kickoff_inputs(plan, inputs or {}).items()
    }

    job = ScheduleJob(
        plan_name=plan.name,
        title=plan.title,
        plan=plan,
        inputs=merged_inputs,
        enabled=enabled,
        mode=resolved_mode,
        interval_minutes=interval,
        cron=resolved_cron,
        run_at=resolved_run_at,
        label=resolved_label,
        next_run_at=_iso(next_run),
    )
    return upsert_job(job)


def mark_job_running(job_id: str) -> ScheduleJob | None:
    job = get_job(job_id)
    if not job:
        return None
    job.last_status = "running"
    job.updated_at = _iso(_now()) or ""
    return upsert_job(job)


def mark_job_finished(
    job_id: str,
    *,
    ok: bool,
    error: str | None = None,
) -> ScheduleJob | None:
    job = get_job(job_id)
    if not job:
        return None
    now = _now()
    job.last_run_at = _iso(now)
    job.last_status = "ok" if ok else "error"
    job.last_error = error
    job.run_count = int(job.run_count or 0) + 1
    if job.mode == "once":
        job.enabled = False
        job.next_run_at = None
    else:
        job.next_run_at = _iso(
            compute_next_run(
                mode=job.mode,
                interval_minutes=job.interval_minutes,
                cron=job.cron,
                run_at=job.run_at,
                from_dt=now,
            )
        )
    job.updated_at = _iso(now) or ""
    return upsert_job(job)


def due_jobs(now: datetime | None = None) -> list[ScheduleJob]:
    now = now or _now()
    due: list[ScheduleJob] = []
    for job in list_jobs():
        if not job.enabled:
            continue
        if job.last_status == "running":
            continue
        nxt = _parse_iso(job.next_run_at)
        if nxt is None or nxt <= now:
            due.append(job)
    return due
