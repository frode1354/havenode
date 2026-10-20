"""Local Sub-DAG library: save / list / load / version (no cloud marketplace)."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .models import CrewPlan, GraphModuleSpec
from .workflow_plan import crew_slice_for_module, ensure_workflow_plan

_DATA = Path(__file__).resolve().parent.parent / "data" / "subdags"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe(name: str) -> str:
    return re.sub(r"[^a-z0-9_\-]+", "_", name.lower()).strip("_") or "subdag"


def _bump(version: str | None) -> str:
    if not version:
        return "1.0.0"
    parts = version.split(".")
    try:
        parts[-1] = str(int(parts[-1]) + 1)
        return ".".join(parts)
    except ValueError:
        return f"{version}.1"


def list_subdags() -> list[dict[str, Any]]:
    _DATA.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, Any]] = []
    for path in sorted(_DATA.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            out.append(
                {
                    "id": data.get("id") or path.stem,
                    "title": data.get("title") or path.stem,
                    "version": data.get("version") or "1.0.0",
                    "team_id": data.get("team_id"),
                    "saved_at": data.get("saved_at"),
                    "agent_count": len((data.get("plan") or {}).get("agents") or []),
                    "task_count": len((data.get("plan") or {}).get("tasks") or []),
                    "path": str(path),
                }
            )
        except Exception:
            continue
    return out


def get_subdag(subdag_id: str) -> dict[str, Any] | None:
    path = _DATA / f"{_safe(subdag_id)}.json"
    if not path.exists():
        # try prefix match on versioned files id__v1.0.0
        matches = list(_DATA.glob(f"{_safe(subdag_id)}*.json"))
        if not matches:
            return None
        path = sorted(matches)[-1]
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def save_subdag(
    plan: CrewPlan,
    team_id: str,
    *,
    version: str | None = None,
    title: str | None = None,
) -> dict[str, Any]:
    plan = ensure_workflow_plan(plan)
    mod = next(
        (m for m in plan.modules if m.kind == "crew" and m.team_id == team_id),
        None,
    )
    if mod is None:
        # synthesize module id from team
        mod_id = f"mod_{team_id}"
        sliced = crew_slice_for_module(
            plan.model_copy(
                update={
                    "modules": [
                        GraphModuleSpec(
                            id=mod_id,
                            kind="crew",
                            label=title or team_id,
                            team_id=team_id,
                        )
                    ]
                    + [m for m in plan.modules if m.kind == "end"],
                }
            ),
            mod_id,
        )
    else:
        sliced = crew_slice_for_module(plan, mod.id)

    sid = _safe((mod.subdag_id if mod and mod.subdag_id else None) or team_id)
    existing = get_subdag(sid)
    ver = version or _bump(existing.get("version") if existing else None)
    team = next((t for t in plan.teams if t.id == team_id), None)
    record = {
        "id": sid,
        "title": title or (team.name if team else sid),
        "version": ver,
        "team_id": team_id,
        "saved_at": _now(),
        "plan": sliced.model_dump(mode="json"),
    }
    _DATA.mkdir(parents=True, exist_ok=True)
    path = _DATA / f"{sid}.json"
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    # also keep versioned snapshot
    vpath = _DATA / f"{sid}__v{ver}.json"
    vpath.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "id": sid,
        "title": record["title"],
        "version": ver,
        "team_id": team_id,
        "saved_at": record["saved_at"],
        "path": str(path),
    }


def import_subdag_into_plan(plan: CrewPlan, subdag_id: str) -> CrewPlan:
    """Merge a saved sub-DAG's agents/tasks/team into the plan as a new module."""
    rec = get_subdag(subdag_id)
    if not rec or not rec.get("plan"):
        raise ValueError(f"subdag not found: {subdag_id}")
    sub = CrewPlan.model_validate(rec["plan"])
    plan = ensure_workflow_plan(plan.model_copy(deep=True))

    # Remap ids to avoid collisions
    suffix = _safe(rec.get("version") or "v").replace(".", "_")
    id_map_agents: dict[str, str] = {}
    for a in sub.agents:
        new_id = a.id if not any(x.id == a.id for x in plan.agents) else f"{a.id}_{suffix}"
        id_map_agents[a.id] = new_id
        a.id = new_id
        plan.agents.append(a)
    team_id = rec.get("team_id") or sub.name
    for t in sub.teams:
        if any(x.id == t.id for x in plan.teams):
            t.id = f"{t.id}_{suffix}"
        t.agent_ids = [id_map_agents.get(x, x) for x in t.agent_ids]
        plan.teams.append(t)
        team_id = t.id

    for task in sub.tasks:
        new_tid = (
            task.id
            if not any(x.id == task.id for x in plan.tasks)
            else f"{task.id}_{suffix}"
        )
        task.id = new_tid
        task.agent_id = id_map_agents.get(task.agent_id, task.agent_id)
        task.context_task_ids = [
            # best-effort: keep relative contexts within import
            c
            for c in (task.context_task_ids or [])
        ]
        plan.tasks.append(task)

    mod_id = f"mod_{team_id}"
    if not any(m.id == mod_id for m in plan.modules):
        plan.modules.insert(
            -1 if plan.modules and plan.modules[-1].kind == "end" else len(plan.modules),
            GraphModuleSpec(
                id=mod_id,
                kind="crew",
                label=rec.get("title") or team_id,
                team_id=team_id,
                subdag_id=rec.get("id"),
                subdag_version=rec.get("version") or "1.0.0",
            ),
        )
    return plan
