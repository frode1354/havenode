"""Offline self-test for LangGraph orchestration (no live LLM required)."""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from unittest.mock import patch

# Ensure backend package root is importable
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.models import (  # noqa: E402
    AgentSpec,
    CrewPlan,
    GraphEdgeSpec,
    GraphModuleSpec,
    RunPolicy,
    RunResponse,
    RunTaskResult,
    StartSpec,
    TaskSpec,
    TeamSpec,
)
from app.workflow_plan import crew_slice_for_module, ensure_workflow_plan  # noqa: E402
from app.token_estimate import estimate_plan_tokens  # noqa: E402
from app.workflow_docs import generate_workflow_docs  # noqa: E402
from app.langgraph_export import build_langgraph_zip, langgraph_project_files  # noqa: E402
from app.subdag_store import get_subdag, list_subdags, save_subdag  # noqa: E402
from app.langgraph_runtime import run_langgraph_workflow  # noqa: E402


def _sample_plan() -> CrewPlan:
    return ensure_workflow_plan(
        CrewPlan(
            name="selftest_wf",
            title="Selftest Workflow",
            summary="smoke",
            agents=[
                AgentSpec(
                    id="researcher",
                    role="Researcher",
                    goal="find",
                    backstory="b",
                    team_id="research",
                ),
                AgentSpec(
                    id="writer",
                    role="Writer",
                    goal="write",
                    backstory="b",
                    team_id="writing",
                ),
            ],
            tasks=[
                TaskSpec(
                    id="research_task",
                    description="Research topic {topic}",
                    expected_output="notes",
                    agent_id="researcher",
                ),
                TaskSpec(
                    id="write_task",
                    description="Write brief from notes",
                    expected_output="md",
                    agent_id="writer",
                    context_task_ids=["research_task"],
                ),
            ],
            teams=[
                TeamSpec(id="research", name="Research Team", agent_ids=["researcher"]),
                TeamSpec(id="writing", name="Writing Team", agent_ids=["writer"]),
            ],
            inputs=[{"name": "topic", "description": "topic", "example": "AI agents"}],
            start=StartSpec(trigger="manual"),
            run_policy=RunPolicy(token_budget_max=5000, circuit_breaker=True),
        )
    )


def _fake_sandbox(ok: bool = True, output: str = "ok-result", tokens: int = 100) -> RunResponse:
    return RunResponse(
        ok=ok,
        result=output,
        logs="fake",
        events=["fake sandbox"],
        task_results=[
            RunTaskResult(
                task_id="research_task",
                agent="researcher",
                output=output,
                tokens_in=tokens // 2,
                tokens_out=tokens // 2,
            )
        ],
    )


def main() -> None:
    fails: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        if cond:
            print(f"PASS {name}" + (f" · {detail}" if detail else ""))
        else:
            print(f"FAIL {name}" + (f" · {detail}" if detail else ""))
            fails.append(name)

    plan = _sample_plan()
    check(
        "normalize",
        plan.orchestration == "langgraph"
        and len([m for m in plan.modules if m.kind == "crew"]) == 2
        and any(m.kind == "end" for m in plan.modules)
        and len(plan.graph_edges) >= 2,
        f"modules={[m.id for m in plan.modules]} edges={len(plan.graph_edges)}",
    )

    est = estimate_plan_tokens(plan)
    check("token_estimate", est.total_max > 0 and "research_task" in est.by_task, str(est.total_max))

    docs = generate_workflow_docs(plan)
    check(
        "docs",
        "flowchart" in docs.mermaid and "LangGraph" in docs.markdown,
        f"md={len(docs.markdown)}",
    )

    sliced = crew_slice_for_module(plan, "mod_research")
    check(
        "subdag_slice",
        len(sliced.agents) == 1 and sliced.agents[0].id == "researcher",
    )

    meta = save_subdag(plan, "research", title="Research SubDAG")
    listed = list_subdags()
    loaded = get_subdag(meta["id"])
    check(
        "subdag_store",
        bool(meta.get("id")) and any(x["id"] == meta["id"] for x in listed) and bool(loaded),
        f"{meta['id']} v{meta['version']}",
    )

    files = langgraph_project_files(plan, include_dockerfile=True)
    need = [
        "selftest_wf/graph.py",
        "selftest_wf/state.py",
        "selftest_wf/requirements.txt",
        "selftest_wf/run.py",
        "selftest_wf/Dockerfile",
        "selftest_wf/WORKFLOW.md",
    ]
    missing = [k for k in need if k not in files]
    z = build_langgraph_zip(plan)
    with zipfile.ZipFile(io.BytesIO(z)) as zf:
        names = zf.namelist()
    check(
        "export_zip",
        not missing and any(n.startswith("selftest_wf/crews/") for n in names) and len(z) > 1000,
        f"files={len(files)} zip={len(z)} missing={missing}",
    )

    # HITL interrupt (no sandbox)
    hitl = plan.model_copy(deep=True)
    hitl.modules = [
        GraphModuleSpec(id="mod_hitl", kind="hitl", label="Review"),
        GraphModuleSpec(id="mod_research", kind="crew", label="R", team_id="research"),
        GraphModuleSpec(id="mod_end", kind="end", label="End"),
    ]
    hitl.graph_edges = [
        GraphEdgeSpec(id="e1", source="start", target="mod_hitl"),
        GraphEdgeSpec(id="e2", source="mod_hitl", target="mod_research"),
        GraphEdgeSpec(id="e3", source="mod_research", target="mod_end"),
    ]
    resp = run_langgraph_workflow(hitl, {"topic": "x"})
    check(
        "hitl_interrupt",
        resp.waiting_human is True and resp.interrupt_module_id == "mod_hitl",
        str(resp.interrupt_module_id),
    )

    # Breakpoint before crew
    bp = plan.model_copy(deep=True)
    bp.run_policy = RunPolicy(
        token_budget_max=999999, circuit_breaker=True, breakpoints=["mod_research"]
    )
    bp.modules = [
        GraphModuleSpec(id="mod_research", kind="crew", label="R", team_id="research"),
        GraphModuleSpec(id="mod_end", kind="end", label="End"),
    ]
    bp.graph_edges = [
        GraphEdgeSpec(id="e1", source="start", target="mod_research"),
        GraphEdgeSpec(id="e2", source="mod_research", target="mod_end"),
    ]
    resp_bp = run_langgraph_workflow(bp, {"topic": "x"})
    check(
        "breakpoint",
        resp_bp.waiting_human and resp_bp.interrupt_module_id == "mod_research",
    )

    # Full graph with mocked sandbox
    with patch("app.sandbox.run_crew_sandbox", return_value=_fake_sandbox(output="crew-out", tokens=200)):
        resp_full = run_langgraph_workflow(plan, {"topic": "AI"})
    check(
        "full_graph_mocked",
        resp_full.ok and "crew-out" in (resp_full.result or "") and resp_full.tokens_used > 0,
        f"tokens={resp_full.tokens_used} modules={list(resp_full.module_results)}",
    )

    # Sub-DAG replay mocked
    with patch("app.sandbox.run_crew_sandbox", return_value=_fake_sandbox(output="slice-out", tokens=50)):
        resp_slice = run_langgraph_workflow(
            plan, {"topic": "AI"}, module_id="mod_research", subdag_only=True
        )
    check(
        "subdag_replay_mocked",
        resp_slice.ok and "slice-out" in (resp_slice.result or ""),
        f"tokens={resp_slice.tokens_used}",
    )

    # Circuit breaker: budget 10, each module adds ~200 tokens
    cb = plan.model_copy(deep=True)
    cb.run_policy = RunPolicy(token_budget_max=10, circuit_breaker=True)
    with patch(
        "app.sandbox.run_crew_sandbox",
        return_value=_fake_sandbox(output="big", tokens=500),
    ):
        resp_cb = run_langgraph_workflow(cb, {"topic": "AI"})
    check(
        "circuit_breaker",
        resp_cb.circuit_broken is True and resp_cb.ok is False,
        f"tokens={resp_cb.tokens_used} err={resp_cb.error}",
    )

    # FastAPI route handlers (no TestClient / no lifespan)
    from app import main as main_mod
    from app.models import (
        ExportRequest,
        SubDAGSaveRequest,
        TokenEstimateRequest,
        WorkflowDocsRequest,
    )

    r_est = main_mod.workflow_token_estimate(TokenEstimateRequest(plan=plan))
    check("api_token_estimate", r_est.get("total_max", 0) > 0)

    r_docs = main_mod.workflow_docs(WorkflowDocsRequest(plan=plan))
    check("api_docs", bool(r_docs.mermaid and r_docs.markdown))

    r_sub = main_mod.subdags_save(SubDAGSaveRequest(plan=plan, team_id="writing", title="Writing"))
    check("api_subdag_save", r_sub.get("ok") is True)

    r_list = main_mod.subdags_list()
    check("api_subdag_list", len(r_list.get("subdags") or []) >= 1)

    from fastapi.responses import Response

    r_zip = main_mod.export_zip(
        ExportRequest(plan=plan, mode="langgraph", include_dockerfile=True)
    )
    check(
        "api_export",
        isinstance(r_zip, Response) and len(r_zip.body or b"") > 1000,
        f"bytes={len(r_zip.body or b'')}",
    )

    # Async job start + poll with mocked sandbox (no LLM)
    from app.run_jobs import get_run, start_run
    import time

    with patch("app.sandbox.run_crew_sandbox", return_value=_fake_sandbox(output="job-out", tokens=80)):
        job = start_run(plan, {"topic": "AI"}, module_id="mod_research", subdag_only=True)
        check(
            "run_job_start",
            bool(job.get("id")) and job.get("status") in {"running", "ok", "error", "waiting_human"},
            f"{job.get('id', '')[:8]} status={job.get('status')}",
        )
        final = job if job.get("status") != "running" else None
        for _ in range(50):
            if final:
                break
            time.sleep(0.1)
            snap = get_run(job["id"])
            if snap and snap.get("status") != "running":
                final = snap
                break
        check(
            "run_job_finish",
            bool(final) and final.get("ok") is True and final.get("status") == "ok",
            f"status={final.get('status') if final else None} result={(final or {}).get('result', '')[:40]}",
        )

    if fails:
        print(f"\nFAILED {len(fails)}: {', '.join(fails)}")
        raise SystemExit(1)
    print("\nALL_SELFTEST_PASS")


if __name__ == "__main__":
    main()
