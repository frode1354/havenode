"""In-process sandbox: build and kickoff a Crew from a CrewPlan with DeepSeek."""

from __future__ import annotations

import io
import logging
import os
import traceback
from contextlib import redirect_stderr, redirect_stdout
from typing import Any

from crewai import Agent, Crew, LLM, Process, Task
from dotenv import load_dotenv

from .models import CrewPlan, RunRequest, RunResponse, RunTaskResult
from .output_store import project_output_dir, save_run_outputs
from .plan_inputs import merge_kickoff_inputs
from .tools_policy import sanitize_tools

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(_ENV_PATH)

os.environ.setdefault("CREWAI_DISABLE_TELEMETRY", "true")
os.environ.setdefault("OTEL_SDK_DISABLED", "true")

_TOOL_CTORS: dict[str, Any] | None = None


def _tool_ctors() -> dict[str, Any]:
    global _TOOL_CTORS
    if _TOOL_CTORS is not None:
        return _TOOL_CTORS
    ctors: dict[str, Any] = {}
    try:
        from crewai_tools import ScrapeWebsiteTool

        ctors["ScrapeWebsiteTool"] = ScrapeWebsiteTool
    except Exception:  # noqa: BLE001
        pass
    try:
        from crewai_tools import SeleniumScrapingTool

        ctors["SeleniumScrapingTool"] = SeleniumScrapingTool
    except Exception:  # noqa: BLE001
        pass
    try:
        from crewai_tools import URLReadTool

        ctors["URLReadTool"] = URLReadTool
    except Exception:  # noqa: BLE001
        pass
    try:
        from crewai_tools import SerperDevTool

        ctors["SerperDevTool"] = SerperDevTool
    except Exception:  # noqa: BLE001
        pass
    try:
        from crewai_tools import FileReadTool, FileWriterTool, DirectoryReadTool

        ctors["FileReadTool"] = FileReadTool
        ctors["FileWriterTool"] = FileWriterTool
        ctors["DirectoryReadTool"] = DirectoryReadTool
    except Exception:  # noqa: BLE001
        pass
    try:
        from crewai_tools import CodeInterpreterTool

        ctors["CodeInterpreterTool"] = CodeInterpreterTool
    except Exception:  # noqa: BLE001
        pass
    # Coding tools are factories — constructed per working dir in _build_tools
    _TOOL_CTORS = ctors
    return ctors


def _get_llm() -> LLM:
    from .settings_store import active_api

    cfg = active_api()
    api_key = cfg.api_key or os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key and cfg.provider != "ollama":
        raise RuntimeError("未配置 API Key，请在设置 → 模型 / API 中填写")
    model = cfg.model or os.getenv("MODEL", "deepseek/deepseek-chat")
    kwargs: dict = {"model": model, "temperature": 0.3}
    if api_key:
        kwargs["api_key"] = api_key
    if cfg.base_url:
        kwargs["base_url"] = cfg.base_url
    return LLM(**kwargs)


def _build_tools(names: list[str], working_dir: str | None = None) -> list[Any]:
    ctors = _tool_ctors()
    coding: dict[str, Any] = {}
    if working_dir:
        try:
            from .coding_tools import build_coding_tools

            coding = build_coding_tools(working_dir)
        except Exception:  # noqa: BLE001
            coding = {}
    tools: list[Any] = []
    for name in sanitize_tools(names):
        if name in coding:
            tools.append(coding[name])
            continue
        ctor = ctors.get(name)
        if ctor is None:
            continue
        try:
            tools.append(ctor())
        except Exception:  # noqa: BLE001
            # Skip tools that fail init (e.g. missing SERPER_API_KEY)
            continue
    return tools


def _effective_agent_tools(plan: CrewPlan, agent_id: str) -> list[str]:
    agent = next((a for a in plan.agents if a.id == agent_id), None)
    if agent is None:
        return []
    names = list(agent.tools or [])
    team = next(
        (
            t
            for t in plan.teams
            if t.id == agent.team_id or agent_id in (t.agent_ids or [])
        ),
        None,
    )
    if team and team.grants:
        names = list(team.grants.tools or []) + names
    # preserve order, unique
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _resource_hint(plan: CrewPlan, agent_id: str) -> str:
    """Inject authorized skills / knowledge into agent backstory for the run."""
    try:
        from .settings_store import get_enabled_knowledge, get_enabled_skills

        skill_map = {s["id"]: s for s in get_enabled_skills()}
        kb_map = {k["id"]: k for k in get_enabled_knowledge()}
    except Exception:  # noqa: BLE001
        return ""

    agent = next((a for a in plan.agents if a.id == agent_id), None)
    if agent is None:
        return ""
    skill_ids = list(agent.skills or [])
    kb_ids = list(agent.knowledge or [])
    team = next(
        (
            t
            for t in plan.teams
            if t.id == agent.team_id or agent_id in (t.agent_ids or [])
        ),
        None,
    )
    if team and team.grants:
        skill_ids = list(team.grants.skills or []) + skill_ids
        kb_ids = list(team.grants.knowledge or []) + kb_ids

    lines: list[str] = []
    for sid in dict.fromkeys(skill_ids):
        s = skill_map.get(sid)
        if s:
            lines.append(f"- Skill「{s.get('name')}」: {s.get('description')} ({s.get('path')})")
    for kid in dict.fromkeys(kb_ids):
        k = kb_map.get(kid)
        if k:
            lines.append(
                f"- 知识库「{k.get('name')}」[{k.get('kind')}]: {str(k.get('source') or '')[:240]}"
            )
    if not lines:
        return ""
    team_line = f"（Team: {team.name}）" if team else ""
    return "\n\n【已授权资源】" + team_line + "\n" + "\n".join(lines)


def _build_crew(plan: CrewPlan, output_dir: str) -> Crew:
    llm = _get_llm()
    folder_hint = (
        f"\n\n【输出目录】当前工作目录已切换到项目专属文件夹：{output_dir}\n"
        "FileWriterTool / ProjectShellTool / CodebaseGrepTool 均相对此目录。"
        "若你是 Cline 编码个体：探索 → 编辑 → Shell 验证；其他 Agent 侧重调研/写作，勿抢编码任务。"
    )
    manager_ids = {t.manager_agent_id for t in plan.teams if t.manager_agent_id}
    for a in plan.agents:
        if a.is_manager:
            manager_ids.add(a.id)

    agents_by_id: dict[str, Agent] = {}
    for spec in plan.agents:
        is_mgr = spec.id in manager_ids or bool(spec.is_manager)
        agents_by_id[spec.id] = Agent(
            role=spec.role,
            goal=spec.goal,
            backstory=spec.backstory + _resource_hint(plan, spec.id),
            llm=llm,
            tools=_build_tools(_effective_agent_tools(plan, spec.id), output_dir),
            verbose=True,
            allow_delegation=is_mgr,
        )

    use_hierarchical = plan.process == "hierarchical" and bool(manager_ids)
    process = Process.hierarchical if use_hierarchical else Process.sequential
    # CrewAI: manager_agent must NOT appear in agents= list
    mgr: Agent | None = None
    mgr_ids_resolved: set[str] = set()
    if process == Process.hierarchical:
        for tid in manager_ids:
            if tid and tid in agents_by_id:
                mgr = agents_by_id[tid]
                mgr_ids_resolved.add(tid)
                break
    worker_by_id = {
        aid: agent for aid, agent in agents_by_id.items() if aid not in mgr_ids_resolved
    }
    fallback_worker = next(iter(worker_by_id.values()), None)

    # Avoid two async tasks sharing one agent (CrewAI executor constraint)
    async_agent_claimed: set[str] = set()
    tasks: list[Task] = []
    tasks_by_id: dict[str, Task] = {}
    for spec in plan.tasks:
        agent_id = spec.agent_id
        if agent_id in mgr_ids_resolved:
            agent = fallback_worker
            agent_id = next(iter(worker_by_id), spec.agent_id)
        else:
            agent = worker_by_id.get(spec.agent_id) or fallback_worker
        if agent is None:
            agent = next(iter(agents_by_id.values()))
        context = [tasks_by_id[cid] for cid in spec.context_task_ids if cid in tasks_by_id]
        want_async = bool(spec.async_execution) and not context
        if want_async and agent_id in async_agent_claimed:
            want_async = False
        if want_async:
            async_agent_claimed.add(agent_id)
        task = Task(
            description=spec.description + folder_hint,
            expected_output=spec.expected_output,
            agent=agent,
            tools=_build_tools(spec.tools, output_dir),
            context=context if context else [],
            async_execution=want_async,
        )
        tasks.append(task)
        tasks_by_id[spec.id] = task

    crew_kwargs: dict[str, Any] = {
        "agents": list(worker_by_id.values()) if mgr is not None else list(agents_by_id.values()),
        "tasks": tasks,
        "process": process,
        "verbose": True,
    }
    if process == Process.hierarchical:
        if mgr is not None:
            crew_kwargs["manager_agent"] = mgr
        else:
            crew_kwargs["manager_llm"] = llm
    return Crew(**crew_kwargs)


def run_crew_sandbox(req: RunRequest) -> RunResponse:
    plan = req.plan
    # Fill every {placeholder} used in task/agent text (LLM often uses {input})
    inputs = merge_kickoff_inputs(plan, req.inputs)

    out_dir = project_output_dir(plan)
    out_dir_str = str(out_dir)

    events: list[str] = [
        f"沙箱启动 · crew={plan.name}",
        f"专属文件夹 · {out_dir_str}",
        f"模型 · {os.getenv('MODEL', 'deepseek/deepseek-chat')}",
        f"输入 · {inputs}",
        "正在用 AI Agents 构建并执行 Crew…",
    ]

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    log_buf = io.StringIO()
    handler = logging.StreamHandler(log_buf)
    handler.setLevel(logging.INFO)
    root = logging.getLogger()
    prev_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    prev_cwd = os.getcwd()

    try:
        os.chdir(out_dir_str)
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            crew = _build_crew(plan, out_dir_str)
            events.append(f"已创建 {len(plan.agents)} 个 Agent、{len(plan.tasks)} 个 Task")
            result = crew.kickoff(inputs=inputs)

        raw = getattr(result, "raw", None) or str(result)
        task_results: list[RunTaskResult] = []
        tasks_output = getattr(result, "tasks_output", None) or []
        for i, tout in enumerate(tasks_output):
            tid = plan.tasks[i].id if i < len(plan.tasks) else f"task_{i}"
            agent_name = getattr(tout, "agent", "") or (
                plan.tasks[i].agent_id if i < len(plan.tasks) else ""
            )
            task_results.append(
                RunTaskResult(
                    task_id=tid,
                    agent=str(agent_name),
                    output=str(getattr(tout, "raw", None) or tout),
                )
            )
            events.append(f"完成 · {tid}")

        saved_dir, saved_files = save_run_outputs(plan, raw, task_results, inputs)
        events.append(f"已写入专属文件夹 · {saved_dir}")
        for name in saved_files:
            events.append(f"保存 · {name}")

        logs = "\n".join(
            part
            for part in (stdout_buf.getvalue(), stderr_buf.getvalue(), log_buf.getvalue())
            if part.strip()
        )
        events.append("执行完成")
        return RunResponse(
            ok=True,
            result=raw,
            logs=logs[-20000:],
            events=events,
            task_results=task_results,
            output_dir=saved_dir,
            saved_files=saved_files,
        )
    except Exception as exc:  # noqa: BLE001
        logs = "\n".join(
            part
            for part in (
                stdout_buf.getvalue(),
                stderr_buf.getvalue(),
                log_buf.getvalue(),
                traceback.format_exc(),
            )
            if part.strip()
        )
        events.append(f"失败 · {exc}")
        return RunResponse(
            ok=False,
            result="",
            error=str(exc),
            logs=logs[-20000:],
            events=events,
            task_results=[],
            output_dir=out_dir_str,
            saved_files=[],
        )
    finally:
        try:
            os.chdir(prev_cwd)
        except Exception:  # noqa: BLE001
            pass
        root.removeHandler(handler)
        root.setLevel(prev_level)
