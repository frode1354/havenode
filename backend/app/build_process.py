"""Studio-style build process: agent repo scan → tool check → validate → summary.

Mirrors CrewAI Studio's pre-build steps without extra LLM round-trips.
"""

from __future__ import annotations

from typing import Any

from .models import CrewPlan


def list_reusable_agents(limit: int = 12) -> list[dict[str, str]]:
    """Scan recent local deployments for reusable agent roles."""
    found: list[dict[str, str]] = []
    seen: set[str] = set()
    try:
        from .deploy_store import list_deployments

        for dep in list_deployments():
            plan_raw = dep.plan
            if not isinstance(plan_raw, dict):
                continue
            agents = plan_raw.get("agents") or []
            title = str(plan_raw.get("title") or dep.title or dep.plan_name or "")
            for a in agents:
                if not isinstance(a, dict):
                    continue
                role = str(a.get("role") or "").strip()
                aid = str(a.get("id") or "").strip()
                key = (aid or role).lower()
                if not key or key in seen or key == "cline":
                    continue
                seen.add(key)
                found.append(
                    {
                        "id": aid or key,
                        "role": role or aid,
                        "goal": str(a.get("goal") or "")[:120],
                        "from": title[:80],
                    }
                )
                if len(found) >= limit:
                    return found
    except Exception:  # noqa: BLE001
        return found
    return found


def check_ready_tools() -> dict[str, Any]:
    """Which Studio tools are enabled and notes for Drive/URL workflows."""
    from .settings_store import get_enabled_tools
    from .tools_policy import ALLOWED_TOOLS

    enabled = list(get_enabled_tools())
    ready = [t for t in enabled if t in ALLOWED_TOOLS]
    notes: list[str] = []
    if "URLReadTool" in ready:
        notes.append(
            "URLReadTool 已启用：可用 Google Drive / 网页「任何有链接可查看」的共享 URL 读文档"
        )
    else:
        notes.append("未启用 URLReadTool：Drive 发票请改用公开链接，或在设置中开启 URLReadTool")
    if "SerperDevTool" not in ready:
        notes.append("SerperDevTool 未启用（可选）")
    if "FileWriterTool" in ready:
        notes.append("FileWriterTool 可用于写出最终异常报告")
    return {"ready": ready, "notes": notes}


def validate_crew_plan(plan: CrewPlan) -> list[str]:
    """Lightweight structural checks before presenting the plan."""
    issues: list[str] = []
    if not plan.agents:
        issues.append("缺少 Agent")
    if not plan.tasks:
        issues.append("缺少 Task")
    agent_ids = {a.id for a in plan.agents}
    for t in plan.tasks:
        if t.agent_id and t.agent_id not in agent_ids:
            issues.append(f"Task「{t.id}」的 agent_id={t.agent_id} 不存在")
        for ctx in t.context_task_ids or []:
            if ctx not in {x.id for x in plan.tasks}:
                issues.append(f"Task「{t.id}」的 context 引用了不存在的 {ctx}")
    if len(plan.agents) >= 2 and len(plan.tasks) < 2:
        issues.append("多 Agent 但 Task 过少，建议每阶段一任务")
    populated_teams = [t for t in (plan.teams or []) if t.agent_ids]
    if len(plan.agents) >= 3 and len(populated_teams) < 2:
        issues.append("多阶段流水线应拆成多个独立 Team（子 DAG），不要只放 1 个 Team")
    if plan.orchestration == "langgraph" and len(plan.modules or []) < 2:
        issues.append("LangGraph 外层模块过少，应含多个 Crew 子 DAG 与 End")
    # Drive / URL workflows: prefer URLReadTool on extract-like agents
    text_blob = " ".join(
        [
            plan.summary or "",
            plan.title or "",
            *(a.goal or "" for a in plan.agents),
            *(t.description or "" for t in plan.tasks),
        ]
    ).lower()
    needs_url = any(
        k in text_blob
        for k in ("drive", "发票", "invoice", "url", "链接", "google")
    )
    if needs_url:
        tools_used = set()
        for a in plan.agents:
            tools_used.update(a.tools or [])
        for t in plan.tasks:
            tools_used.update(t.tools or [])
        if "URLReadTool" not in tools_used and "ScrapeWebsiteTool" not in tools_used:
            issues.append("涉及链接/Drive/发票时建议至少一个 Agent 配备 URLReadTool")
    return issues


def format_build_summary(
    plan: CrewPlan,
    *,
    repo_count: int,
    tool_notes: list[str],
    validation: list[str],
) -> str:
    """Studio-like Chinese summary after the crew is built."""
    lines: list[str] = [
        f"自动化已就绪：**{plan.title}**",
        "",
        f"{len(plan.agents)} 个 Agent / {len(plan.tasks)} 个 Task"
        + ("（顺序执行）" if (plan.process or "sequential") == "sequential" else ""),
        "",
        "| 代理 | 任务 | 工具 |",
        "| --- | --- | --- |",
    ]
    task_by_agent: dict[str, list[str]] = {}
    for t in plan.tasks:
        task_by_agent.setdefault(t.agent_id, []).append(t.id)
    for a in plan.agents:
        tasks = "、".join(task_by_agent.get(a.id, ["—"]))
        tools = "、".join(a.tools) if a.tools else "—"
        lines.append(f"| {a.role or a.id} | {tasks} | {tools} |")

    if plan.inputs:
        lines.extend(["", "运行时输入："])
        for inp in plan.inputs:
            desc = inp.description or inp.example or ""
            lines.append(f"- `{{{inp.name}}}` — {desc}")

    lines.extend(["", "构建过程："])
    if repo_count:
        lines.append(f"- 代理仓库：发现 {repo_count} 个可参考角色（未强制复用）")
    else:
        lines.append("- 代理仓库：暂无可复用代理，已新建")
    for note in tool_notes[:3]:
        lines.append(f"- 工具：{note}")
    if validation:
        lines.append("- 校验：" + "；".join(validation))
    else:
        lines.append("- 校验：通过")

    lines.extend(
        [
            "",
            "请在画布上批准或修改；满意后切到「执行」用样例输入试跑。",
        ]
    )
    return "\n".join(lines)


def build_context_for_prompt() -> str:
    """Text block injected into plan generation (no extra LLM)."""
    repo = list_reusable_agents()
    tools = check_ready_tools()
    parts: list[str] = []
    if repo:
        rows = [
            f"- {r['role']}（来自「{r['from']}」）: {r['goal']}" for r in repo[:8]
        ]
        parts.append(
            "代理仓库（可参考角色，勿照抄 id；无合适则新建）：\n" + "\n".join(rows)
        )
    else:
        parts.append("代理仓库：暂无可复用代理，请新建合适 Agent。")
    ready = ", ".join(tools["ready"]) or "（无）"
    parts.append(f"已启用工具：{ready}")
    for n in tools.get("notes") or []:
        parts.append(f"工具说明：{n}")
    parts.append(
        "若需求涉及 Google Drive / 共享链接 / 在线文档，提取类 Agent 优先配备 URLReadTool；"
        "在 inputs 中声明 invoice_urls、po_and_contract_data 等占位符。"
    )
    return "\n".join(parts)
