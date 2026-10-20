"""Async sandbox / LangGraph run jobs — start immediately, poll for status/events."""

from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from .deploy_store import get_deployment, upsert_deployment
from .models import CrewPlan, RunResponse
from .workflow_plan import ensure_workflow_plan

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _snapshot(job: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(job)


def get_run(run_id: str) -> dict[str, Any] | None:
    with _lock:
        job = _jobs.get(run_id)
        if not job:
            return None
        return _snapshot(job)


def _apply_response(job: dict[str, Any], resp: RunResponse) -> None:
    if resp.waiting_human:
        job["status"] = "waiting_human"
        job["ok"] = False
        job["waiting_human"] = True
        job["interrupt_module_id"] = resp.interrupt_module_id
        job["_resume_state"] = {
            "interrupt_module_id": resp.interrupt_module_id,
            "module_results": resp.module_results,
            "tokens_used": resp.tokens_used,
            "status": "waiting_human",
        }
    else:
        job["status"] = "ok" if resp.ok else "error"
        job["ok"] = resp.ok
        job["waiting_human"] = False
    job["result"] = resp.result
    job["error"] = resp.error
    job["logs"] = resp.logs
    job["events"] = list(resp.events)
    job["task_results"] = [t.model_dump(mode="json") for t in resp.task_results]
    job["output_dir"] = resp.output_dir or ""
    job["saved_files"] = list(resp.saved_files or [])
    job["tokens_used"] = resp.tokens_used
    job["token_estimate"] = (
        resp.token_estimate.model_dump(mode="json") if resp.token_estimate else None
    )
    job["circuit_broken"] = resp.circuit_broken
    job["module_results"] = dict(resp.module_results or {})
    job["updated_at"] = _now_iso()


def start_run(
    plan: CrewPlan,
    inputs: dict[str, str] | None = None,
    *,
    deployment_id: str | None = None,
    module_id: str | None = None,
    subdag_only: bool = False,
) -> dict[str, Any]:
    """Enqueue a LangGraph / sandbox kickoff; returns immediately with status=running."""
    plan = ensure_workflow_plan(plan)
    run_id = str(uuid.uuid4())
    inputs = dict(inputs or {})
    job: dict[str, Any] = {
        "id": run_id,
        "status": "running",
        "ok": False,
        "result": "",
        "error": None,
        "logs": "",
        "events": [
            f"已排队 · {plan.orchestration} · crew={plan.name}",
            f"Agents={len(plan.agents)} · Tasks={len(plan.tasks)} · Modules={len(plan.modules)}",
            f"子DAG回放={bool(subdag_only or module_id)}"
            + (f" · module={module_id}" if module_id else ""),
            "后台线程启动中…",
        ],
        "task_results": [],
        "output_dir": "",
        "saved_files": [],
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "deployment_id": deployment_id,
        "tokens_used": 0,
        "token_estimate": None,
        "circuit_broken": False,
        "waiting_human": False,
        "interrupt_module_id": None,
        "module_results": {},
        "module_id": module_id,
        "_plan": plan.model_dump(mode="json"),
        "_inputs": inputs,
        "_resume_state": None,
    }
    with _lock:
        _jobs[run_id] = job

    def worker() -> None:
        from .langgraph_runtime import run_langgraph_workflow

        def on_event(msg: str) -> None:
            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                j["events"] = list(j.get("events") or []) + [msg]
                j["updated_at"] = _now_iso()

        try:
            with _lock:
                j = _jobs.get(run_id)
                if j is not None:
                    j["events"].append("LangGraph 编排执行中…")
                    j["updated_at"] = _now_iso()

            use_lg = plan.orchestration == "langgraph" or bool(module_id) or subdag_only
            if use_lg:
                resp = run_langgraph_workflow(
                    plan,
                    inputs,
                    module_id=module_id,
                    subdag_only=subdag_only,
                    on_event=on_event,
                )
            else:
                from .models import RunRequest
                from .sandbox import run_crew_sandbox

                resp = run_crew_sandbox(RunRequest(plan=plan, inputs=inputs))

            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                _apply_response(j, resp)

            if deployment_id and resp.ok and not resp.waiting_human:
                _persist_deployment_run(deployment_id, resp, plan)
        except Exception as exc:  # noqa: BLE001
            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                j["status"] = "error"
                j["ok"] = False
                j["error"] = str(exc)
                j["events"] = list(j.get("events") or []) + [f"失败 · {exc}"]
                j["updated_at"] = _now_iso()

    threading.Thread(target=worker, name=f"run-{run_id[:8]}", daemon=True).start()
    return _snapshot(job)


def resume_run(
    run_id: str,
    *,
    feedback: str = "",
    approved: bool = True,
) -> dict[str, Any] | None:
    """Resume a waiting_human job through LangGraph."""
    with _lock:
        job = _jobs.get(run_id)
        if not job or job.get("status") != "waiting_human":
            return None
        plan_data = job.get("_plan")
        inputs = dict(job.get("_inputs") or {})
        resume_state = dict(job.get("_resume_state") or {})
        job["status"] = "running"
        job["waiting_human"] = False
        job["events"] = list(job.get("events") or []) + [
            f"人工恢复 · approved={approved}",
        ]
        job["updated_at"] = _now_iso()

    if not plan_data:
        with _lock:
            j = _jobs.get(run_id)
            if j:
                j["status"] = "error"
                j["error"] = "无法恢复：运行未保存计划快照"
                j["updated_at"] = _now_iso()
            return _snapshot(j) if j else None

    plan = CrewPlan.model_validate(plan_data)

    def worker() -> None:
        from .langgraph_runtime import run_langgraph_workflow

        def on_event(msg: str) -> None:
            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                j["events"] = list(j.get("events") or []) + [msg]
                j["updated_at"] = _now_iso()

        try:
            resp = run_langgraph_workflow(
                plan,
                inputs,
                resume_state=resume_state,
                human_feedback=feedback,
                approved=approved,
                on_event=on_event,
            )
            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                _apply_response(j, resp)
        except Exception as exc:  # noqa: BLE001
            with _lock:
                j = _jobs.get(run_id)
                if j is None:
                    return
                j["status"] = "error"
                j["ok"] = False
                j["error"] = str(exc)
                j["events"] = list(j.get("events") or []) + [f"恢复失败 · {exc}"]
                j["updated_at"] = _now_iso()

    threading.Thread(target=worker, name=f"resume-{run_id[:8]}", daemon=True).start()
    return get_run(run_id)


def _persist_deployment_run(deployment_id: str, resp: RunResponse, plan: CrewPlan) -> None:
    rec = get_deployment(deployment_id)
    if not rec:
        return
    rec.last_run = resp.model_dump(mode="json")
    rec.run_count = int(rec.run_count or 0) + 1
    if not rec.plan:
        rec.plan = plan.model_dump(mode="json")
    if rec.status in {"prepared", "failed", "needs_login"}:
        rec.status = "local"
    upsert_deployment(rec)
