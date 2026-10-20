"""Static DAG token ceiling estimate (pre-run) and helpers."""

from __future__ import annotations

from .models import CrewPlan, TokenEstimate
from .workflow_plan import ensure_workflow_plan


def _chars_to_tokens(text: str) -> int:
    # Mixed CJK/EN heuristic: ~2 chars ≈ 1 token for CJK-heavy prompts
    n = len(text or "")
    return max(1, (n + 1) // 2)


def estimate_plan_tokens(plan: CrewPlan) -> TokenEstimate:
    """
    Scan the whole workflow DAG statically and estimate an upper bound on tokens.
    Does not call the LLM.
    """
    plan = ensure_workflow_plan(plan)
    by_task: dict[str, int] = {}
    by_module: dict[str, int] = {}

    agent_by_id = {a.id: a for a in plan.agents}
    for task in plan.tasks:
        agent = agent_by_id.get(task.agent_id)
        prompt_blob = "\n".join(
            [
                task.description or "",
                task.expected_output or "",
                agent.role if agent else "",
                agent.goal if agent else "",
                agent.backstory if agent else "",
            ]
        )
        # Input prompt + expected generation headroom (3× output vs input ceiling)
        base = _chars_to_tokens(prompt_blob)
        # Each context dependency may re-inject prior output (~800 tok upper)
        ctx_pad = 800 * len(task.context_task_ids or [])
        # Tool / iteration overhead
        tool_pad = 400 * max(1, len(task.tools or []) + (len(agent.tools) if agent else 0))
        # max_iter-style loops: assume up to 5 agent steps
        est = (base + ctx_pad + tool_pad) * 5
        by_task[task.id] = est

    for mod in plan.modules:
        if mod.kind != "crew":
            by_module[mod.id] = 200 if mod.kind == "hitl" else 50
            continue
        if mod.team_id:
            team = next((t for t in plan.teams if t.id == mod.team_id), None)
            member_ids = set(team.agent_ids if team else [])
            for a in plan.agents:
                if a.team_id == mod.team_id:
                    member_ids.add(a.id)
            task_ids = [t.id for t in plan.tasks if t.agent_id in member_ids]
        else:
            task_ids = [t.id for t in plan.tasks]
        by_module[mod.id] = sum(by_task.get(tid, 0) for tid in task_ids)

    total = sum(by_module.values()) if by_module else sum(by_task.values())
    budget = plan.run_policy.token_budget_max if plan.run_policy else None
    notes = (
        f"静态上界 · Tasks={len(plan.tasks)} · Modules={len(plan.modules)}"
        + (f" · 熔断阈值={budget}" if budget else "")
    )
    return TokenEstimate(
        total_max=total,
        by_task=by_task,
        by_module=by_module,
        method="static_prompt_heuristic",
        notes=notes,
    )
