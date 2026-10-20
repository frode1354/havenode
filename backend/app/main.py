"""Crew Studio FastAPI application."""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .amp_deploy import deploy_to_amp
from .cline_handoff import open_in_cline
from .codegen import build_zip
from .deploy_store import get_deployment, list_deployments, upsert_deployment
from .langgraph_export import build_langgraph_zip
from .models import (
    ChatRequest,
    ChatResponse,
    CrewPlan,
    DeployRequest,
    DeployRunRequest,
    ExportRequest,
    OpenInClineRequest,
    ResumeRunRequest,
    ReviseRequest,
    ReviseResponse,
    RunJobResponse,
    RunRequest,
    RunResponse,
    ScheduleToggleRequest,
    StartRunRequest,
    SubDAGSaveRequest,
    TokenEstimateRequest,
    UpsertScheduleRequest,
    WorkflowDocsRequest,
    WorkflowDocsResponse,
)
from .run_jobs import get_run, resume_run, start_run
from .sandbox import run_crew_sandbox
from .subdag_store import get_subdag, import_subdag_into_plan, list_subdags, save_subdag
from .token_estimate import estimate_plan_tokens
from .workflow_docs import generate_workflow_docs
from .workflow_plan import ensure_workflow_plan
from .schedule_store import (
    ScheduleJob,
    compute_next_run,
    create_job_from_plan,
    delete_job,
    extract_schedule_from_plan,
    get_job,
    list_jobs,
    upsert_job,
)
from .scheduler import run_job_now, scheduler_status, start_scheduler, stop_scheduler
from .settings_store import (
    ApiProfile,
    StudioSettings,
    active_api,
    load_settings,
    public_settings,
    save_settings,
)
from .studio_llm import handle_chat, revise_plan

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    start_scheduler()
    try:
        yield
    finally:
        stop_scheduler()


app = FastAPI(title="Crew Studio", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    api = active_api()
    has_key = bool(api.api_key or os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY"))
    sched = scheduler_status()
    return {
        "ok": True,
        "model": api.model or os.getenv("MODEL", "deepseek/deepseek-chat"),
        "llm_configured": has_key or api.provider == "ollama",
        "sandbox": True,
        "provider": api.provider,
        "api_label": api.label,
        "scheduler": sched,
        "workflow_build": "full-v2",
    }


@app.get("/api/settings")
def get_settings() -> dict:
    return public_settings()


@app.put("/api/settings")
def put_settings(payload: dict) -> dict:
    """Accept multi-API payload (camelCase) from the frontend."""
    current = load_settings()
    current_by_id = {a.id: a for a in current.apis}

    raw_apis = payload.get("apis")
    if isinstance(raw_apis, list) and raw_apis:
        apis: list[ApiProfile] = []
        for item in raw_apis:
            if not isinstance(item, dict):
                continue
            aid = item.get("id") or f"api_{len(apis)+1}"
            prev = current_by_id.get(aid)
            key = item.get("api_key") or item.get("apiKey") or ""
            if (not str(key).strip()) or ("*" in str(key)):
                key = prev.api_key if prev else ""
            apis.append(
                ApiProfile(
                    id=str(aid),
                    label=str(item.get("label") or (prev.label if prev else "API")),
                    provider=str(item.get("provider") or (prev.provider if prev else "deepseek")),
                    model=str(item.get("model") or (prev.model if prev else "deepseek/deepseek-chat")),
                    api_key=str(key),
                    base_url=str(
                        item.get("base_url")
                        or item.get("baseUrl")
                        or (prev.base_url if prev else "")
                    ),
                )
            )
    else:
        apis = current.apis

    active_id = (
        payload.get("activeApiId")
        or payload.get("active_api_id")
        or current.active_api_id
    )
    if active_id not in {a.id for a in apis} and apis:
        active_id = apis[0].id

    editor_command = (
        payload.get("editorCommand")
        or payload.get("editor_command")
        or current.editor_command
        or "cursor"
    )
    merged = {
        "theme": payload.get("theme", current.theme),
        "active_api_id": active_id,
        "apis": [a.model_dump() for a in apis],
        "skills": payload.get("skills", [s.model_dump() for s in current.skills]),
        "tools": payload.get("tools", [t.model_dump() for t in current.tools]),
        "knowledge": payload.get("knowledge", [k.model_dump() for k in current.knowledge]),
        "editor_command": str(editor_command).strip() or "cursor",
    }
    try:
        settings = StudioSettings.model_validate(merged)
        save_settings(settings)
        return public_settings(settings)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if not req.messages:
        raise HTTPException(status_code=400, detail="messages required")
    try:
        return handle_chat(
            messages=req.messages,
            session_id=req.session_id,
            current_plan=req.plan,
            force_plan=bool(getattr(req, "force_plan", False)),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/plan/revise", response_model=ReviseResponse)
def plan_revise(req: ReviseRequest) -> ReviseResponse:
    if not req.feedback.strip():
        raise HTTPException(status_code=400, detail="feedback required")
    try:
        return revise_plan(
            plan=req.plan,
            feedback=req.feedback,
            edited_plan=req.edited_plan,
            session_id=req.session_id,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/export")
def export_zip(req: ExportRequest) -> Response:
    try:
        plan = ensure_workflow_plan(req.plan)
        if req.mode == "crew":
            data = build_zip(plan)
            filename = f"{plan.name}.zip"
        else:
            data = build_langgraph_zip(plan, include_dockerfile=req.include_dockerfile)
            filename = f"{plan.name}-langgraph.zip"
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/workflow/docs", response_model=WorkflowDocsResponse)
def workflow_docs(req: WorkflowDocsRequest) -> WorkflowDocsResponse:
    try:
        return generate_workflow_docs(ensure_workflow_plan(req.plan))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/workflow/token-estimate")
def workflow_token_estimate(req: TokenEstimateRequest) -> dict:
    try:
        est = estimate_plan_tokens(ensure_workflow_plan(req.plan))
        return est.model_dump(mode="json")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/subdags")
def subdags_list() -> dict:
    return {"subdags": list_subdags()}


@app.get("/api/subdags/{subdag_id}")
def subdags_get(subdag_id: str) -> dict:
    rec = get_subdag(subdag_id)
    if not rec:
        raise HTTPException(status_code=404, detail="subdag not found")
    return {"ok": True, "subdag": rec}


@app.post("/api/subdags")
def subdags_save(req: SubDAGSaveRequest) -> dict:
    try:
        meta = save_subdag(
            req.plan,
            req.team_id,
            version=req.version,
            title=req.title,
        )
        return {"ok": True, "subdag": meta}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/subdags/{subdag_id}/import")
def subdags_import(subdag_id: str, req: WorkflowDocsRequest) -> dict:
    """Import a saved sub-DAG into the given plan (body.plan)."""
    try:
        plan = import_subdag_into_plan(req.plan, subdag_id)
        return {"ok": True, "plan": plan.model_dump(mode="json")}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/open-in-cline")
def open_in_cline_endpoint(req: OpenInClineRequest) -> dict:
    """Materialize crew + CLINE_TASK.md and open local editor (Cline)."""
    if not req.plan.agents or not req.plan.tasks:
        raise HTTPException(status_code=400, detail="plan must include agents and tasks")
    try:
        return open_in_cline(req.plan, editor_command=req.editor_command)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/run", response_model=RunResponse)
def run_crew(req: RunRequest) -> RunResponse:
    """Run via LangGraph outer orchestration (or sub-DAG replay)."""
    if not req.plan.agents or not req.plan.tasks:
        raise HTTPException(status_code=400, detail="plan must include agents and tasks")
    try:
        from .langgraph_runtime import run_langgraph_workflow

        plan = ensure_workflow_plan(req.plan)
        if plan.orchestration == "langgraph" or req.module_id or req.subdag_only:
            return run_langgraph_workflow(
                plan,
                req.inputs or {},
                module_id=req.module_id,
                subdag_only=req.subdag_only,
            )
        return run_crew_sandbox(req)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/runs", response_model=RunJobResponse)
def runs_start(req: StartRunRequest) -> RunJobResponse:
    """Start a LangGraph/sandbox run asynchronously; poll GET /api/runs/{id}."""
    if not req.plan.agents or not req.plan.tasks:
        raise HTTPException(status_code=400, detail="plan must include agents and tasks")
    if req.deployment_id:
        rec = get_deployment(req.deployment_id)
        if not rec:
            raise HTTPException(status_code=404, detail="deployment not found")
        if not rec.plan and not req.plan:
            raise HTTPException(
                status_code=400,
                detail="该部署没有保存计划，请点「生成包并打开本地观测台」重建一次",
            )
    try:
        job = start_run(
            req.plan,
            req.inputs or {},
            deployment_id=req.deployment_id,
            module_id=req.module_id,
            subdag_only=req.subdag_only,
        )
        # Strip private keys before response validation
        public = {k: v for k, v in job.items() if not str(k).startswith("_")}
        return RunJobResponse.model_validate(public)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/runs/{run_id}", response_model=RunJobResponse)
def runs_get(run_id: str) -> RunJobResponse:
    job = get_run(run_id)
    if not job:
        raise HTTPException(status_code=404, detail="run not found")
    public = {k: v for k, v in job.items() if not str(k).startswith("_")}
    return RunJobResponse.model_validate(public)


@app.post("/api/runs/{run_id}/resume", response_model=RunJobResponse)
def runs_resume(run_id: str, req: ResumeRunRequest) -> RunJobResponse:
    job = resume_run(run_id, feedback=req.feedback, approved=req.approved)
    if not job:
        raise HTTPException(status_code=404, detail="run not found or not waiting for human")
    public = {k: v for k, v in job.items() if not str(k).startswith("_")}
    return RunJobResponse.model_validate(public)


# ── Deploy to CrewAI AMP (long-lived observe & iterate) ────────────────


@app.get("/api/deployments")
def deployments_list(plan_name: str | None = None) -> dict:
    rows = [d.model_dump(mode="json") for d in list_deployments(plan_name)]
    return {"deployments": rows, "amp_console": "https://app.crewai.com"}


@app.get("/api/deployments/{dep_id}")
def deployments_get(dep_id: str) -> dict:
    rec = get_deployment(dep_id)
    if not rec:
        raise HTTPException(status_code=404, detail="deployment not found")
    return {"ok": True, "deployment": rec.model_dump(mode="json")}


@app.post("/api/deployments/{dep_id}/run", response_model=RunResponse)
def deployments_run(dep_id: str, req: DeployRunRequest) -> RunResponse:
    """Manually run a prepared local deployment (same sandbox engine)."""
    rec = get_deployment(dep_id)
    if not rec:
        raise HTTPException(status_code=404, detail="deployment not found")
    try:
        if rec.plan:
            plan = CrewPlan.model_validate(rec.plan)
        elif req.plan:
            plan = req.plan
            rec.plan = plan.model_dump(mode="json")
        else:
            raise HTTPException(
                status_code=400,
                detail="该部署没有保存计划，请点「生成包并打开本地观测台」重建一次",
            )
        result = run_crew_sandbox(RunRequest(plan=plan, inputs=req.inputs or {}))
        rec.last_run = result.model_dump(mode="json")
        rec.run_count = int(rec.run_count or 0) + 1
        if rec.status in {"prepared", "failed", "needs_login"}:
            rec.status = "local"
        upsert_deployment(rec)
        return result
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/deploy")
def deploy_amp(req: DeployRequest) -> dict:
    """Sandbox OK → materialize package (+ optional AMP push). Always local-runnable."""
    if not req.plan.agents or not req.plan.tasks:
        raise HTTPException(status_code=400, detail="plan must include agents and tasks")
    try:
        rec = deploy_to_amp(req.plan, push=req.push)
        return {"ok": True, "deployment": rec.model_dump(mode="json")}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


# ── Schedule (timed complex workflow runs) ─────────────────────────────


@app.get("/api/schedules")
def schedules_list() -> dict:
    jobs = [j.model_dump(mode="json") for j in list_jobs()]
    return {"jobs": jobs, "scheduler": scheduler_status()}


@app.post("/api/schedules")
def schedules_upsert(req: UpsertScheduleRequest) -> dict:
    if not req.plan.agents or not req.plan.tasks:
        raise HTTPException(status_code=400, detail="plan must include agents and tasks")
    try:
        sched = extract_schedule_from_plan(req.plan)
        mode = req.mode or (sched.mode if sched else None) or "interval"
        interval = (
            req.interval_minutes
            if req.interval_minutes is not None
            else (sched.interval_minutes if sched else 60)
        )
        cron = req.cron if req.cron is not None else (sched.cron if sched else None)
        run_at = req.run_at if req.run_at is not None else (sched.run_at if sched else None)
        label = req.label or (sched.label if sched else None) or "定时运行"

        next_dt = compute_next_run(
            mode=mode,
            interval_minutes=interval,
            cron=cron,
            run_at=run_at,
        )
        if mode == "once" and next_dt is None:
            raise HTTPException(status_code=400, detail="请选择一个晚于现在的运行时间")

        if req.job_id:
            existing = get_job(req.job_id)
            if not existing:
                raise HTTPException(status_code=404, detail="job not found")
            inputs = dict(existing.inputs)
            inputs.update(req.inputs or {})
            for spec in req.plan.inputs:
                inputs.setdefault(spec.name, spec.example or "")
            job = existing.model_copy(
                update={
                    "plan": req.plan,
                    "plan_name": req.plan.name,
                    "title": req.plan.title,
                    "inputs": inputs,
                    "enabled": req.enabled,
                    "mode": mode,
                    "interval_minutes": interval,
                    "cron": cron,
                    "run_at": run_at,
                    "label": label,
                    "next_run_at": next_dt.isoformat() if next_dt else None,
                }
            )
            job = upsert_job(job)
        else:
            job = create_job_from_plan(
                req.plan,
                req.inputs,
                enabled=req.enabled,
                mode=mode,
                interval_minutes=interval,
                cron=cron,
                run_at=run_at,
                label=label,
            )
        return {"ok": True, "job": job.model_dump(mode="json")}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.patch("/api/schedules/{job_id}")
def schedules_toggle(job_id: str, req: ScheduleToggleRequest) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    job.enabled = req.enabled
    if req.enabled:
        nxt = compute_next_run(
            mode=job.mode,
            interval_minutes=job.interval_minutes,
            cron=job.cron,
            run_at=job.run_at,
        )
        if job.mode == "once" and nxt is None:
            raise HTTPException(status_code=400, detail="一次性任务时间已过，请重新设定时间")
        job.next_run_at = nxt.isoformat() if nxt else None
    job = upsert_job(job)
    return {"ok": True, "job": job.model_dump(mode="json")}


@app.post("/api/schedules/{job_id}/run")
def schedules_run_now(job_id: str) -> dict:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    run_job_now(job_id)
    return {"ok": True, "message": "已触发立即运行", "job_id": job_id}


@app.delete("/api/schedules/{job_id}")
def schedules_delete(job_id: str) -> dict:
    if not delete_job(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8765"))
    uvicorn.run("app.main:app", host=host, port=port, reload=True)
