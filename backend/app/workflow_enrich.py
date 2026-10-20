"""
Post-process a generated CrewPlan into a full Studio workflow:
user-input node, multi-team Crew sub-DAGs, quality router + optional loop,
output/publish sink, HITL, token run_policy.
"""

from __future__ import annotations

import re
from typing import Iterable

from .models import (
    AgentSpec,
    CrewPlan,
    GraphEdgeSpec,
    GraphModuleSpec,
    InputSpec,
    RunPolicy,
    StartSpec,
    TaskSpec,
    TeamSpec,
    GrantSpec,
    StateFieldSpec,
)
from .tools_policy import sanitize_tools


_PIPELINE_HINTS = (
    "调研",
    "分析",
    "写作",
    "撰写",
    "采集",
    "研究",
    "对比",
    "周报",
    "报告",
    "流水线",
    "多阶段",
    "团队",
    "team",
    "research",
    "analysis",
    "writing",
    "pipeline",
    "竞品",
)

_FILE_HINTS = ("文件", "落盘", "周报", "报告", "markdown", "md", "写入", "输出到", "保存", "指定位置")
_WEB_HINTS = ("网站", "更新网站", "cms", "wordpress", "网页发布")
_WECHAT_HINTS = ("公众号", "微信", "wechat", "weixin")
_WEBHOOK_HINTS = ("webhook", "回调", "api 推送", "http 推送")
_PAYLOAD_HINTS = ("格式输入", "kickoff", "payload", "特定格式", "输入格式", "用户输入")
_SCRAPE_HINTS = ("竞品", "官网", "网页", "抓取", "scrape", "url", "链接", "公开")
_LOOP_HINTS = ("循环", "重试", "不通过再", "直到", "loop", "retry")
_ROUTE_HINTS = ("条件", "分支", "若", "如果", "质量", "不通过", "router", "分支路线")


def _blob(plan: CrewPlan) -> str:
    parts: list[str] = [plan.title or "", plan.summary or ""]
    for a in plan.agents:
        parts.extend([a.role or "", a.goal or "", a.backstory or ""])
    for t in plan.tasks:
        parts.extend([t.description or "", t.expected_output or ""])
    for i in plan.inputs or []:
        parts.extend([i.name, i.description or ""])
    return " ".join(parts).lower()


def _transcript_blob(*extra: str) -> str:
    return " ".join(extra).lower()


def split_flat_pipeline_teams(plan: CrewPlan) -> CrewPlan:
    """If multi-agent pipeline collapsed into one team, split one Team per agent."""
    from .cline_agent import is_cline_agent

    agents = list(plan.agents or [])
    if len(agents) < 2:
        return plan
    non_cline = [
        a
        for a in agents
        if not is_cline_agent(a.id, a.role_template_id)
        and (a.role or "").strip().lower() != "cline"
    ]
    if len(non_cline) < 2:
        return plan
    teams = list(plan.teams or [])
    populated = [t for t in teams if len(t.agent_ids or []) >= 1]
    if len(populated) >= 2:
        return plan
    new_teams: list[TeamSpec] = []
    for agent in non_cline:
        tid = re.sub(r"[^a-z0-9_]+", "_", f"team_{agent.id}".lower()).strip("_") or "team"
        label = (agent.role or agent.id).strip() or agent.id
        new_teams.append(
            TeamSpec(
                id=tid,
                name=f"{label}团队" if not label.endswith("团队") else label,
                description=agent.goal or "",
                agent_ids=[agent.id],
                grants=GrantSpec(),
                collapsed=True,
                module="generic",
            )
        )
        agent.team_id = tid
    for agent in agents:
        if agent in non_cline:
            continue
        if not agent.team_id and new_teams:
            agent.team_id = new_teams[-1].id
            new_teams[-1].agent_ids.append(agent.id)
    plan.teams = new_teams
    plan.modules = []
    plan.graph_edges = []
    return plan


def _ensure_minimum_pipeline(plan: CrewPlan, text: str) -> None:
    """
    If the user clearly wants a multi-stage workflow but the model emitted
    only one agent/team, synthesize research → analysis → writing stages.
    """
    # Default: always expand to a multi-stage pipeline unless user insisted on one team.
    single = any(
        h in text
        for h in (
            "只要一个",
            "单个team",
            "单个 team",
            "单 team",
            "one team",
            "只要一个 team",
            "只要一个team",
        )
    )
    non_cline = [
        a
        for a in (plan.agents or [])
        if (a.id or "").lower() != "cline" and (a.role_template_id or "") != "cline"
    ]
    if single:
        return
    if len(non_cline) >= 3:
        return

    # Preserve existing first agent as researcher if present
    existing_by_role = {(a.role or "").lower(): a for a in non_cline}
    stages = [
        (
            "researcher",
            "调研员",
            "采集公开信息与竞品动态",
            "资深信息采集",
            ["ScrapeWebsiteTool", "URLReadTool"],
            "research_task",
            "根据输入采集相关公开信息，整理要点列表。",
            "结构化调研要点",
        ),
        (
            "analyst",
            "分析师",
            "对比与洞察",
            "业务分析",
            [],
            "analysis_task",
            "基于调研要点做对比分析，给出结论与风险。",
            "对比分析结论",
        ),
        (
            "writer",
            "写作者",
            "撰写可发布内容并落盘/发布",
            "内容编辑",
            ["FileWriterTool"],
            "write_task",
            "将分析结论写成最终交付物（按输出结点要求）。",
            "最终文稿",
        ),
    ]

    new_agents: list[AgentSpec] = []
    new_tasks: list[TaskSpec] = []
    new_teams: list[TeamSpec] = []
    prev_task: str | None = None

    for aid, role, goal, backstory, tools, tid, desc, expected in stages:
        agent = next((a for a in non_cline if aid in a.id or role in (a.role or "")), None)
        if agent is None:
            agent = AgentSpec(
                id=aid,
                role=role,
                goal=goal,
                backstory=backstory,
                tools=list(tools),
                team_id=f"team_{aid}",
            )
        else:
            agent.id = aid if agent.id in {x.id for x in non_cline} and len(non_cline) == 1 else agent.id
            # Prefer stable stage ids when synthesizing
            agent.id = aid
            agent.role = agent.role or role
            agent.goal = agent.goal or goal
            agent.team_id = f"team_{aid}"
            agent.tools = sanitize_tools(list(dict.fromkeys([*(agent.tools or []), *tools])))
        new_agents.append(agent)

        # Prefer matching existing task by agent, else create
        task = next((t for t in (plan.tasks or []) if t.agent_id == agent.id), None)
        if task is None:
            # try by stage name in id
            task = next((t for t in (plan.tasks or []) if aid.split("_")[0] in t.id), None)
        if task is None:
            task = TaskSpec(
                id=tid,
                description=desc,
                expected_output=expected,
                agent_id=agent.id,
                tools=list(tools),
                context_task_ids=[prev_task] if prev_task else [],
            )
        else:
            task.id = tid
            task.agent_id = agent.id
            task.context_task_ids = [prev_task] if prev_task else []
            if tools:
                task.tools = sanitize_tools(list(dict.fromkeys([*(task.tools or []), *tools])))
        new_tasks.append(task)
        prev_task = task.id

        new_teams.append(
            TeamSpec(
                id=f"team_{aid}",
                name=f"{role}团队",
                description=goal,
                agent_ids=[agent.id],
                grants=GrantSpec(),
                collapsed=True,
                module="generic",
            )
        )

    # Keep Cline if present
    for a in plan.agents or []:
        if (a.id or "").lower() == "cline" or (a.role_template_id or "") == "cline":
            if new_teams:
                a.team_id = new_teams[-1].id
                new_teams[-1].agent_ids.append(a.id)
            new_agents.append(a)

    plan.agents = new_agents
    plan.tasks = new_tasks
    plan.teams = new_teams
    plan.modules = []
    plan.graph_edges = []


def _ensure_task_chain(plan: CrewPlan) -> None:
    tasks = list(plan.tasks or [])
    if len(tasks) < 2:
        return
    has_any = any(t.context_task_ids for t in tasks)
    if has_any:
        return
    for i in range(1, len(tasks)):
        tasks[i].context_task_ids = [tasks[i - 1].id]


def _ensure_start(plan: CrewPlan, text: str) -> None:
    start = plan.start or StartSpec()
    start.id = "start"
    if not (start.label or "").strip():
        start.label = "用户输入"
    # Default to payload (structured user input node) for full workflows
    start.trigger = "payload"
    if not (start.payload_format or "").strip():
        names = [i.name for i in (plan.inputs or [])] or ["topic"]
        lines = ["请按以下格式提供 kickoff 输入："]
        for n in names:
            lines.append(f"- {n}: <必填>")
        start.payload_format = "\n".join(lines)
    if not (start.payload_example or "").strip() and plan.inputs:
        start.payload_example = "\n".join(
            f"{i.name}: {i.example or '…'}" for i in plan.inputs
        )

    task_ids = {t.id for t in plan.tasks}
    entries = [
        t.id
        for t in plan.tasks
        if not t.context_task_ids
        or all(c not in task_ids for c in (t.context_task_ids or []))
    ]
    if not entries and plan.tasks:
        entries = [plan.tasks[0].id]
    start.next_task_ids = [
        t for t in (start.next_task_ids or []) if t in task_ids
    ] or entries
    plan.start = start


def _ensure_inputs_from_placeholders(plan: CrewPlan) -> None:
    found: list[str] = []
    pat = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
    for t in plan.tasks:
        for m in pat.findall(t.description or ""):
            if m not in found:
                found.append(m)
    existing = {i.name for i in (plan.inputs or [])}
    for name in found:
        if name in existing:
            continue
        plan.inputs = list(plan.inputs or [])
        plan.inputs.append(InputSpec(name=name, description=name, example=""))
        existing.add(name)


def _add_tools(agent_tools: list[str], extra: Iterable[str]) -> list[str]:
    merged = list(agent_tools or [])
    for t in extra:
        if t not in merged:
            merged.append(t)
    return sanitize_tools(merged)


def _ensure_stage_tools(plan: CrewPlan, text: str) -> None:
    agents = list(plan.agents or [])
    if not agents:
        return
    for a in agents[: max(1, len(agents) - 1)]:
        role = f"{a.id} {a.role} {a.goal}".lower()
        if any(k in role for k in ("research", "调研", "采集", "scrape", "搜")) or any(
            h in text for h in _SCRAPE_HINTS
        ):
            a.tools = _add_tools(a.tools, ["ScrapeWebsiteTool", "URLReadTool"])
    last = agents[-1]
    last_role = f"{last.id} {last.role} {last.goal}".lower()
    if any(k in last_role for k in ("writ", "写", "报告", "周报", "撰")) or any(
        h in text for h in _FILE_HINTS
    ):
        last.tools = _add_tools(last.tools, ["FileWriterTool"])
        for t in reversed(plan.tasks):
            if t.agent_id == last.id:
                t.tools = _add_tools(t.tools, ["FileWriterTool"])
                break


def _infer_sink(text: str) -> tuple[str, str, str]:
    """Return (sink_kind, label, notes)."""
    if any(h in text for h in _WECHAT_HINTS):
        return (
            "wechat_mp",
            "输出 · 微信公众号",
            "需用户提供公众号 AppID/AppSecret 或发布接口；未配置时先 HITL 确认。",
        )
    if any(h in text for h in _WEB_HINTS):
        return (
            "website",
            "输出 · 更新网站",
            "需用户提供站点 URL / CMS API / 登录凭据。",
        )
    if any(h in text for h in _WEBHOOK_HINTS):
        return ("webhook", "输出 · Webhook", "需用户提供 webhook URL 与鉴权头。")
    return ("file", "输出 · 本地文件", "默认写入运行输出目录（可用 FileWriterTool）。")


def _ensure_run_policy(plan: CrewPlan) -> None:
    policy = plan.run_policy or RunPolicy()
    if policy.token_budget_max is None:
        policy.token_budget_max = 200_000
    policy.circuit_breaker = True if policy.circuit_breaker is None else policy.circuit_breaker
    plan.run_policy = policy
    plan.orchestration = "langgraph"


def _build_full_outer_graph(plan: CrewPlan, text: str) -> None:
    """
    Start → UserInput → Crew₁ → … → [Router] → [HITL] → Crewₙ → Output → End
    Optional loop edge: Router --retry--> earlier Crew.
    """
    if not plan.state_fields:
        plan.state_fields = []

    crew_mods: list[GraphModuleSpec] = []
    if plan.teams:
        for team in plan.teams:
            out_key = f"{team.id}_output"
            crew_mods.append(
                GraphModuleSpec(
                    id=f"mod_{team.id}",
                    kind="crew",
                    label=team.name or team.id,
                    team_id=team.id,
                    input_keys=["inputs"],
                    output_keys=[out_key],
                    subdag_id=team.id,
                    subdag_version="1.0.0",
                    notes=team.description or "",
                )
            )
            if not any(f.name == out_key for f in plan.state_fields):
                plan.state_fields.append(
                    StateFieldSpec(
                        name=out_key,
                        type="str",
                        default="",
                        description=f"Output of {team.name}",
                    )
                )
    else:
        crew_mods.append(
            GraphModuleSpec(
                id="mod_main_crew",
                kind="crew",
                label=plan.title or "Main Crew",
                team_id=None,
                input_keys=["inputs"],
                output_keys=["crew_output"],
                subdag_id=plan.name,
                subdag_version="1.0.0",
            )
        )

    modules: list[GraphModuleSpec] = []
    edges: list[GraphEdgeSpec] = []

    # 1) User input node (prescribed format)
    input_mod = GraphModuleSpec(
        id="mod_user_input",
        kind="input",
        label="用户输入（规定格式）",
        input_keys=[],
        output_keys=["inputs"],
        notes=(plan.start.payload_format if plan.start else "") or "按 start.payload_format 收集输入",
    )
    modules.append(input_mod)
    edges.append(
        GraphEdgeSpec(id="e_start_input", source="start", target=input_mod.id, label="kickoff")
    )
    prev = input_mod.id

    want_router = len(crew_mods) >= 2 or any(h in text for h in _ROUTE_HINTS + _LOOP_HINTS)
    want_loop = any(h in text for h in _LOOP_HINTS) or len(crew_mods) >= 2
    loop_target = crew_mods[0].id if crew_mods else input_mod.id

    # 2) Crew stages — if ≥2 crews: … → penultimate → router ─┬─ok→ last → …
    #                                                      └─retry→ first (loop)
    if len(crew_mods) >= 2 and want_router:
        head, last = crew_mods[:-1], crew_mods[-1]
        for mod in head:
            modules.append(mod)
            edges.append(
                GraphEdgeSpec(
                    id=f"e_{prev}_{mod.id}",
                    source=prev,
                    target=mod.id,
                    label="next",
                )
            )
            prev = mod.id
        router = GraphModuleSpec(
            id="mod_quality_router",
            kind="router",
            label="条件路由",
            condition="quality_ok",
            input_keys=["messages"],
            output_keys=["branch"],
            notes="通过→继续下一 Crew；不通过→有限次循环回首个 Crew",
        )
        modules.append(router)
        edges.append(
            GraphEdgeSpec(
                id=f"e_{prev}_{router.id}",
                source=prev,
                target=router.id,
                label="check",
            )
        )
        modules.append(last)
        edges.append(
            GraphEdgeSpec(
                id=f"e_{router.id}_ok_{last.id}",
                source=router.id,
                target=last.id,
                condition="ok",
                label="通过",
            )
        )
        if want_loop:
            edges.append(
                GraphEdgeSpec(
                    id=f"e_{router.id}_retry",
                    source=router.id,
                    target=loop_target,
                    condition="retry",
                    label="不通过·循环",
                    is_loop=True,
                    max_loops=3,
                )
            )
        prev = last.id
    else:
        for mod in crew_mods:
            modules.append(mod)
            edges.append(
                GraphEdgeSpec(
                    id=f"e_{prev}_{mod.id}",
                    source=prev,
                    target=mod.id,
                    label="next",
                )
            )
            prev = mod.id

    # HITL before publish when sink needs credentials
    sink_kind, sink_label, sink_notes = _infer_sink(text)
    needs_secrets = sink_kind in {"website", "wechat_mp", "webhook"}
    if needs_secrets or len(crew_mods) >= 2:
        hitl = GraphModuleSpec(
            id="mod_hitl_before_publish",
            kind="hitl",
            label="发布前确认",
            input_keys=["messages"],
            output_keys=["human_feedback"],
            notes="确认文稿与凭证后再进入输出结点",
        )
        modules.append(hitl)
        edges.append(
            GraphEdgeSpec(
                id=f"e_{prev}_{hitl.id}",
                source=prev,
                target=hitl.id,
                label="review",
            )
        )
        prev = hitl.id
        policy = plan.run_policy or RunPolicy()
        bps = list(policy.breakpoints or [])
        if hitl.id not in bps:
            bps.append(hitl.id)
        policy.breakpoints = bps
        plan.run_policy = policy

    # 3) Output / publish node
    out_mod = GraphModuleSpec(
        id="mod_output_sink",
        kind="output",
        label=sink_label,
        sink_kind=sink_kind,  # type: ignore[arg-type]
        sink_target="",
        input_keys=["messages"],
        output_keys=["published"],
        notes=sink_notes,
    )
    modules.append(out_mod)
    edges.append(
        GraphEdgeSpec(
            id=f"e_{prev}_{out_mod.id}",
            source=prev,
            target=out_mod.id,
            label="publish",
        )
    )
    prev = out_mod.id

    end = GraphModuleSpec(id="mod_end", kind="end", label="结束")
    modules.append(end)
    edges.append(
        GraphEdgeSpec(id=f"e_{prev}_{end.id}", source=prev, target=end.id, label="done")
    )

    # Deduplicate modules by id (router may create duplicate edge targets)
    seen: set[str] = set()
    uniq: list[GraphModuleSpec] = []
    for m in modules:
        if m.id in seen:
            continue
        seen.add(m.id)
        uniq.append(m)
    plan.modules = uniq
    plan.graph_edges = edges


def enrich_full_workflow(plan: CrewPlan, *, user_text: str = "") -> CrewPlan:
    """Mutate plan into a complete multi-module LangGraph + Crew workflow."""
    text = (_blob(plan) + " " + (user_text or "")).lower()
    _ensure_minimum_pipeline(plan, text)
    plan = split_flat_pipeline_teams(plan)
    _ensure_task_chain(plan)
    _ensure_inputs_from_placeholders(plan)
    _ensure_start(plan, text)
    _ensure_stage_tools(plan, text)
    _ensure_run_policy(plan)
    _build_full_outer_graph(plan, text)
    return plan
