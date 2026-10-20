"""Collect and fill CrewAI template variables ({name}) for plan kickoff."""

from __future__ import annotations

import re
from typing import Any

from .models import CrewPlan, InputSpec

# CrewAI interpolates {identifier} from kickoff inputs
_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")

_ALIAS_SOURCES = (
    "input",
    "goal",
    "topic",
    "query",
    "user_request",
    "news_topic",
    "prompt",
    "request",
)


def extract_placeholders(*texts: str | None) -> set[str]:
    keys: set[str] = set()
    for text in texts:
        if not text:
            continue
        keys.update(_PLACEHOLDER_RE.findall(text))
    return keys


def placeholders_in_plan(plan: CrewPlan) -> set[str]:
    keys: set[str] = set()
    for task in plan.tasks:
        keys |= extract_placeholders(task.description, task.expected_output)
    for agent in plan.agents:
        keys |= extract_placeholders(agent.goal, agent.backstory, agent.role)
    return keys


def ensure_plan_input_specs(plan: CrewPlan) -> CrewPlan:
    """Add InputSpec entries for any {var} used in tasks/agents but missing from plan.inputs."""
    existing = {spec.name for spec in plan.inputs}
    missing = sorted(placeholders_in_plan(plan) - existing)
    if not missing:
        return plan
    labels = {
        "input": ("主输入", "用户目标或主题"),
        "goal": ("目标", "工作流要达成的目标"),
        "topic": ("主题", "分析或研究主题"),
        "query": ("查询", "检索关键词"),
    }
    extras: list[InputSpec] = []
    for name in missing:
        title, desc = labels.get(name, (name, f"任务模板变量 {{{name}}}"))
        extras.append(
            InputSpec(
                name=name,
                description=desc,
                example=title if name != "input" else "用户目标或主题",
            )
        )
    plan.inputs = list(plan.inputs) + extras
    return plan


def _first_nonempty(values: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        val = values.get(key)
        if val is not None and str(val).strip():
            return str(val)
    for val in values.values():
        if val is not None and str(val).strip():
            return str(val)
    return ""


def merge_kickoff_inputs(plan: CrewPlan, req_inputs: dict[str, str] | None = None) -> dict[str, Any]:
    """Build kickoff inputs so every template placeholder has a key (avoids CrewAI KeyError)."""
    req = dict(req_inputs or {})
    inputs: dict[str, Any] = {}
    for spec in plan.inputs:
        inputs[spec.name] = req.get(spec.name, spec.example or "")
    for key, val in req.items():
        inputs[key] = val

    for key in placeholders_in_plan(plan):
        if key in inputs and str(inputs.get(key) or "").strip():
            continue
        if key in inputs:
            # present but empty — try fill from aliases
            pass
        fallback = _first_nonempty(inputs, _ALIAS_SOURCES)
        if key == "input" and not fallback:
            fallback = _first_nonempty(inputs, ("goal", "topic", "query"))
        inputs[key] = fallback or inputs.get(key) or ""

    # Always expose a generic "input" alias if any value exists (common LLM habit)
    if "input" not in inputs:
        inputs["input"] = _first_nonempty(inputs, _ALIAS_SOURCES)

    return inputs
