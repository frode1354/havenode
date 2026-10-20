"""Background scheduler: run enabled crew jobs when due."""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from .models import RunRequest
from .schedule_store import due_jobs, mark_job_finished, mark_job_running

logger = logging.getLogger(__name__)

_stop = threading.Event()
_thread: threading.Thread | None = None
_tick_seconds = 20
_run_lock = threading.Lock()


def _execute_job(job_id: str) -> None:
    from .sandbox import run_crew_sandbox

    job = mark_job_running(job_id)
    if job is None:
        return
    try:
        result = run_crew_sandbox(
            RunRequest(plan=job.plan, inputs=dict(job.inputs or {}))
        )
        mark_job_finished(
            job_id,
            ok=bool(result.ok),
            error=None if result.ok else (result.error or "run failed"),
        )
        logger.info(
            "schedule job %s finished ok=%s title=%s",
            job_id,
            result.ok,
            job.title,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("schedule job %s failed", job_id)
        mark_job_finished(job_id, ok=False, error=str(exc))


def _loop() -> None:
    logger.info("crew scheduler started (tick=%ss)", _tick_seconds)
    while not _stop.wait(_tick_seconds):
        try:
            jobs = due_jobs()
        except Exception:  # noqa: BLE001
            logger.exception("due_jobs failed")
            continue
        for job in jobs:
            if _stop.is_set():
                break
            # One at a time to avoid hammering the LLM API
            with _run_lock:
                if _stop.is_set():
                    break
                _execute_job(job.id)
    logger.info("crew scheduler stopped")


def start_scheduler() -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="crew-scheduler", daemon=True)
    _thread.start()


def stop_scheduler() -> None:
    _stop.set()
    t = _thread
    if t and t.is_alive():
        t.join(timeout=2.0)


def scheduler_status() -> dict:
    alive = bool(_thread and _thread.is_alive())
    return {
        "running": alive,
        "tick_seconds": _tick_seconds,
    }


def run_job_now(job_id: str) -> None:
    """Fire a job immediately in a background thread."""

    def _go() -> None:
        with _run_lock:
            _execute_job(job_id)

    threading.Thread(target=_go, name=f"job-now-{job_id}", daemon=True).start()
