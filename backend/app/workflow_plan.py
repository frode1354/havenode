"""Normalize CrewPlan into LangGraph outer modules + Crew sub-DAGs."""

from __future__ import annotations

from .models import (
    CrewPlan,
    GraphEdgeSpec,
    GraphModuleSpec,
    RunPolicy,
    StateFieldSpec,
)


def ensure_workflow_plan(plan: CrewPlan) -> CrewPlan:
    """
    Ensure outer orchestration fields exist.
    Legacy plans (teams only) become Start → Crew modules → End.
    """
    if plan.orchestration not in ("crew", "langgraph"):
        plan.orchestration = "langgraph"

    if plan.run_policy is None:
        plan.run_policy = RunPolicy()

    core = [
        StateFieldSpec(
            name="inputs",
            type="dict",
            default="{}",
            description="Kickoff inputs from Start node",
        ),
        StateFieldSpec(
            name="messages",
            type="list",
            default="[]",
            description="Accumulated module outputs",
        ),
        StateFieldSpec(
            name="tokens_used",
            type="int",
            default="0",
            description="Cumulative token usage",
        ),
        StateFieldSpec(
            name="status",
            type="str",
            default="pending",
            description="running | waiting_human | ok | error | circuit_broken",
        ),
    ]
    existing_names = {f.name for f in (plan.state_fields or [])}
    fields = list(plan.state_fields or [])
    for f in core:
        if f.name not in existing_names:
            fields.append(f)
            existing_names.add(f.name)
    for inp in plan.inputs or []:
        if inp.name not in existing_names:
            fields.append(
                StateFieldSpec(
                    name=inp.name,
                    type="str",
                    default=inp.example or "",
                    description=inp.description or inp.name,
                )
            )
            existing_names.add(inp.name)
    plan.state_fields = fields

    if not plan.modules:
        modules: list[GraphModuleSpec] = []
        if plan.teams:
            for team in plan.teams:
                members = [
                    a
                    for a in plan.agents
                    if a.team_id == team.id or a.id in (team.agent_ids or [])
                ]
                member_ids = {a.id for a in members}
                tasks = [t for t in plan.tasks if t.agent_id in member_ids]
                out_key = f"{team.id}_output"
                modules.append(
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
                # Ensure state field for module output
                if not any(f.name == out_key for f in plan.state_fields):
                    plan.state_fields.append(
                        StateFieldSpec(
                            name=out_key,
                            type="str",
                            default="",
                            description=f"Output of Crew sub-DAG {team.name}",
                        )
                    )
        else:
            modules.append(
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
            if not any(f.name == "crew_output" for f in plan.state_fields):
                plan.state_fields.append(
                    StateFieldSpec(
                        name="crew_output",
                        type="str",
                        default="",
                        description="Main crew output",
                    )
                )
        modules.append(
            GraphModuleSpec(id="mod_end", kind="end", label="结束", input_keys=[], output_keys=[])
        )
        plan.modules = modules

    if not plan.graph_edges and plan.modules:
        edges: list[GraphEdgeSpec] = []
        crew_mods = [m for m in plan.modules if m.kind == "crew"]
        end_mod = next((m for m in plan.modules if m.kind == "end"), None)
        prev = "start"
        for mod in crew_mods:
            edges.append(
                GraphEdgeSpec(
                    id=f"e_{prev}_{mod.id}",
                    source=prev,
                    target=mod.id,
                    label="next",
                )
            )
            prev = mod.id
        if end_mod:
            edges.append(
                GraphEdgeSpec(
                    id=f"e_{prev}_{end_mod.id}",
                    source=prev,
                    target=end_mod.id,
                    label="done",
                )
            )
        # Wire HITL / router modules if user added them but left edges empty
        for mod in plan.modules:
            if mod.kind in ("hitl", "router") and not any(
                e.target == mod.id or e.source == mod.id for e in edges
            ):
                # insert after start
                edges.insert(
                    0,
                    GraphEdgeSpec(
                        id=f"e_start_{mod.id}",
                        source="start",
                        target=mod.id,
                        label="review" if mod.kind == "hitl" else "route",
                    ),
                )
        plan.graph_edges = edges

    return plan


def crew_slice_for_module(plan: CrewPlan, module_id: str) -> CrewPlan:
    """Return a CrewPlan containing only agents/tasks for one Crew module (sub-DAG replay)."""
    plan = ensure_workflow_plan(plan)
    mod = next((m for m in plan.modules if m.id == module_id), None)
    if mod is None:
        raise ValueError(f"module not found: {module_id}")
    if mod.kind != "crew":
        raise ValueError(f"module {module_id} is kind={mod.kind}, not crew")

    if mod.team_id:
        team = next((t for t in plan.teams if t.id == mod.team_id), None)
        if not team:
            raise ValueError(f"team not found for module: {mod.team_id}")
        agents = [
            a
            for a in plan.agents
            if a.team_id == team.id or a.id in (team.agent_ids or [])
        ]
        agent_ids = {a.id for a in agents}
        tasks = [t for t in plan.tasks if t.agent_id in agent_ids]
        teams = [team]
    else:
        agents = list(plan.agents)
        tasks = list(plan.tasks)
        teams = list(plan.teams)

    sliced = plan.model_copy(deep=True)
    sliced.agents = agents
    sliced.tasks = tasks
    sliced.teams = teams
    sliced.modules = [mod]
    sliced.graph_edges = [
        GraphEdgeSpec(id="e_start_mod", source="start", target=mod.id, label="replay"),
        GraphEdgeSpec(id="e_mod_end", source=mod.id, target="mod_end", label="done"),
    ]
    if not any(m.id == "mod_end" for m in sliced.modules):
        sliced.modules.append(
            GraphModuleSpec(id="mod_end", kind="end", label="结束")
        )
    sliced.title = f"{plan.title} · {mod.label or mod.id}"
    sliced.summary = f"Sub-DAG replay: {mod.label or mod.id}"
    return sliced
