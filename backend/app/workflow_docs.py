"""Canvas → Mermaid + natural-language workflow documentation."""

from __future__ import annotations

from .models import CrewPlan, WorkflowDocsResponse
from .token_estimate import estimate_plan_tokens
from .workflow_plan import ensure_workflow_plan


def _safe_id(raw: str) -> str:
    return "".join(c if c.isalnum() or c == "_" else "_" for c in raw)[:64] or "node"


def generate_workflow_docs(plan: CrewPlan) -> WorkflowDocsResponse:
    plan = ensure_workflow_plan(plan)
    estimate = estimate_plan_tokens(plan)

    lines = ["flowchart TB", "  start([Start])"]
    for mod in plan.modules:
        mid = _safe_id(mod.id)
        label = (mod.label or mod.id).replace('"', "'")
        if mod.kind == "crew":
            lines.append(f'  {mid}["Crew子DAG: {label}"]')
        elif mod.kind == "hitl":
            lines.append(f'  {mid}{{"HITL: {label}"}}')
        elif mod.kind == "router":
            lines.append(f'  {mid}{{"Router: {label}"}}')
        elif mod.kind == "end":
            lines.append(f"  {mid}([End])")
        else:
            lines.append(f'  {mid}["{mod.kind}: {label}"]')

    for edge in plan.graph_edges:
        src = "start" if edge.source == "start" else _safe_id(edge.source)
        tgt = _safe_id(edge.target)
        lbl = edge.label or edge.condition or ""
        if lbl:
            lines.append(f"  {src} -->|{lbl}| {tgt}")
        else:
            lines.append(f"  {src} --> {tgt}")

    # Inner Crew detail as subgraphs
    for mod in plan.modules:
        if mod.kind != "crew":
            continue
        mid = _safe_id(mod.id)
        lines.append(f"  subgraph {mid}_inner[{(mod.label or mod.id).replace(' ', '_')}]")
        if mod.team_id:
            team = next((t for t in plan.teams if t.id == mod.team_id), None)
            member_ids = set(team.agent_ids if team else [])
            for a in plan.agents:
                if a.team_id == mod.team_id:
                    member_ids.add(a.id)
            tasks = [t for t in plan.tasks if t.agent_id in member_ids]
        else:
            tasks = list(plan.tasks)
        for t in tasks:
            tid = _safe_id(f"t_{t.id}")
            lines.append(f'    {tid}["Task:{t.id} → {t.agent_id}"]')
        # context edges
        task_ids = {t.id for t in tasks}
        for t in tasks:
            for ctx in t.context_task_ids or []:
                if ctx in task_ids:
                    lines.append(f"    {_safe_id('t_' + ctx)} --> {_safe_id('t_' + t.id)}")
        lines.append("  end")

    mermaid = "\n".join(lines)

    # Natural language markdown
    md: list[str] = [
        f"# {plan.title}",
        "",
        plan.summary or "",
        "",
        "## 编排架构",
        "",
        "- **外层**：LangGraph（全局 State、条件跳转、循环/断点、Human-in-the-loop）",
        "- **内层**：CrewAI Crew 子 DAG（Agent / Task 依赖）",
        f"- **编排模式**：`{plan.orchestration}`",
        "",
        "## 全局 State",
        "",
    ]
    for f in plan.state_fields:
        md.append(f"- `{f.name}` ({f.type}) — {f.description or '—'}")
    md.extend(["", "## 外层模块", ""])
    for mod in plan.modules:
        md.append(
            f"### {mod.label or mod.id} (`{mod.id}` · {mod.kind})"
        )
        if mod.team_id:
            md.append(f"- 绑定 Team / 子 DAG：`{mod.team_id}` v{mod.subdag_version}")
        if mod.input_keys:
            md.append(f"- 输入键：{', '.join(f'`{k}`' for k in mod.input_keys)}")
        if mod.output_keys:
            md.append(f"- 输出键：{', '.join(f'`{k}`' for k in mod.output_keys)}")
        if mod.notes:
            md.append(f"- 说明：{mod.notes}")
        md.append("")

    md.extend(["## 外层连线", ""])
    for e in plan.graph_edges:
        cond = f" 〔条件: {e.condition}〕" if e.condition else ""
        md.append(f"- `{e.source}` → `{e.target}` {e.label or ''}{cond}".rstrip())

    md.extend(["", "## 内层 Crew（Agent / Task）", ""])
    for team in plan.teams:
        md.append(f"### Team `{team.name}` (`{team.id}`)")
        members = [
            a
            for a in plan.agents
            if a.team_id == team.id or a.id in (team.agent_ids or [])
        ]
        for a in members:
            md.append(f"- Agent **{a.role}** (`{a.id}`) — {a.goal}")
        member_ids = {a.id for a in members}
        for t in plan.tasks:
            if t.agent_id not in member_ids:
                continue
            ctx = ", ".join(t.context_task_ids) if t.context_task_ids else "—"
            est = estimate.by_task.get(t.id, 0)
            md.append(
                f"  - Task `{t.id}` → `{t.agent_id}` · context: {ctx} · token上界≈{est}"
            )
        md.append("")

    policy = plan.run_policy
    md.extend(
        [
            "## 运行策略",
            "",
            f"- Token 熔断阈值：`{policy.token_budget_max if policy else None}`",
            f"- 熔断开关：`{policy.circuit_breaker if policy else True}`",
            f"- 断点模块：{', '.join(policy.breakpoints) if policy and policy.breakpoints else '无'}",
            f"- LangSmith：`{policy.enable_langsmith if policy else False}`",
            "",
            f"## Token 静态预估",
            "",
            f"- 整图上界：**{estimate.total_max}** tokens（{estimate.method}）",
            f"- {estimate.notes}",
            "",
            "## Mermaid",
            "",
            "```mermaid",
            mermaid,
            "```",
            "",
        ]
    )

    return WorkflowDocsResponse(
        mermaid=mermaid,
        markdown="\n".join(md),
        title=plan.title,
    )
