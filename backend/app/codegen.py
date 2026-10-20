"""Generate downloadable CrewAI project ZIP from a CrewPlan."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import yaml

from .models import CrewPlan
from .tools_policy import sanitize_tools


def _class_name(plan: CrewPlan) -> str:
    parts = [part.capitalize() for part in plan.name.split("_") if part]
    base = "".join(parts) or "Studio"
    if base.endswith("Crew"):
        return base
    return base + "Crew"


def _agents_yaml(plan: CrewPlan) -> str:
    data: dict = {}
    for agent in plan.agents:
        entry = {
            "role": agent.role,
            "goal": agent.goal,
            "backstory": agent.backstory,
            "llm": agent.llm or "deepseek/deepseek-chat",
        }
        data[agent.id] = entry
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def _tasks_yaml(plan: CrewPlan) -> str:
    data: dict = {}
    for task in plan.tasks:
        entry: dict = {
            "description": task.description,
            "expected_output": task.expected_output,
            "agent": task.agent_id,
        }
        if task.context_task_ids:
            entry["context"] = task.context_task_ids
        data[task.id] = entry
    return yaml.safe_dump(data, allow_unicode=True, sort_keys=False)


def _agent_tool_names(plan: CrewPlan, agent_id: str) -> list[str]:
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
    return sanitize_tools(names)


def _collect_tools(plan: CrewPlan) -> list[str]:
    names: list[str] = []
    for agent in plan.agents:
        for t in _agent_tool_names(plan, agent.id):
            if t not in names:
                names.append(t)
    for task in plan.tasks:
        for t in sanitize_tools(task.tools):
            if t not in names:
                names.append(t)
    return names


_CUSTOM_CODING_TOOLS = frozenset({"ProjectShellTool", "CodebaseGrepTool"})


def _split_tools(names: list[str]) -> tuple[list[str], list[str]]:
    crewai: list[str] = []
    custom: list[str] = []
    for name in names:
        if name in _CUSTOM_CODING_TOOLS:
            if name not in custom:
                custom.append(name)
        elif name not in crewai:
            crewai.append(name)
    return crewai, custom


def _tool_expr(name: str) -> str:
    if name in _CUSTOM_CODING_TOOLS:
        return f"{name}(working_directory='.')"
    return f"{name}()"


def _crew_py(plan: CrewPlan) -> str:
    """Build crew.py with explicit indentation (no mixed dedent)."""
    class_name = _class_name(plan)
    tool_names = _collect_tools(plan)
    crewai_tools, custom_tools = _split_tools(tool_names)
    lines: list[str] = [
        "from crewai import Agent, Crew, Process, Task",
        "from crewai.project import CrewBase, agent, crew, task",
    ]
    if crewai_tools:
        lines.append("from crewai_tools import (")
        for t in crewai_tools:
            lines.append(f"    {t},")
        lines.append(")")
    if custom_tools:
        lines.append("from .coding_tools import (")
        for t in custom_tools:
            lines.append(f"    {t},")
        lines.append(")")
    lines.extend(
        [
            "",
            f'@CrewBase',
            f"class {class_name}:",
            f'    """{plan.title}"""',
            "",
            "    # Config lives next to this module: <pkg>/config/*.yaml",
            '    agents_config = "config/agents.yaml"',
            '    tasks_config = "config/tasks.yaml"',
            "",
        ]
    )

    for agent in plan.agents:
        tools = _agent_tool_names(plan, agent.id)
        lines.append("    @agent")
        lines.append(f"    def {agent.id}(self) -> Agent:")
        lines.append("        return Agent(")
        lines.append(f'            config=self.agents_config["{agent.id}"],')
        lines.append("            verbose=True,")
        if agent.is_manager:
            lines.append("            allow_delegation=True,")
        if tools:
            tools_repr = ", ".join(_tool_expr(t) for t in tools)
            lines.append(f"            tools=[{tools_repr}],")
        lines.append("        )")
        lines.append("")

    for task in plan.tasks:
        tools = sanitize_tools(task.tools)
        lines.append("    @task")
        lines.append(f"    def {task.id}(self) -> Task:")
        lines.append("        return Task(")
        lines.append(f'            config=self.tasks_config["{task.id}"],')
        if tools:
            tools_repr = ", ".join(_tool_expr(t) for t in tools)
            lines.append(f"            tools=[{tools_repr}],")
        if task.async_execution:
            lines.append("            async_execution=True,")
        lines.append("        )")
        lines.append("")

    mgr_id = next((t.manager_agent_id for t in plan.teams if t.manager_agent_id), None)
    if not mgr_id:
        mgr_id = next((a.id for a in plan.agents if a.is_manager), None)
    use_hierarchical = plan.process == "hierarchical" and bool(mgr_id)
    process = "Process.hierarchical" if use_hierarchical else "Process.sequential"

    lines.extend(
        [
            "    @crew",
            "    def crew(self) -> Crew:",
        ]
    )
    if use_hierarchical and mgr_id:
        # CrewAI: manager_agent must not also be in agents=
        lines.extend(
            [
                f"        manager = self.{mgr_id}()",
                "        workers = [a for a in self.agents if a.role != manager.role]",
                "        return Crew(",
                "            agents=workers,",
                "            tasks=self.tasks,",
                f"            process={process},",
                "            verbose=True,",
                "            manager_agent=manager,",
                "        )",
                "",
            ]
        )
    else:
        lines.extend(
            [
                "        return Crew(",
                "            agents=self.agents,",
                "            tasks=self.tasks,",
                f"            process={process},",
                "            verbose=True,",
                "        )",
                "",
            ]
        )
    return "\n".join(lines)


def _main_py(plan: CrewPlan) -> str:
    class_name = _class_name(plan)
    pkg = plan.name
    input_lines: list[str] = []
    for i in plan.inputs:
        example = (i.example or "").replace("\\", "\\\\").replace('"', '\\"')
        input_lines.append(f'        "{i.name}": "{example}",')
    if not input_lines:
        input_lines.append('        # "topic": "AI agents",')

    lines = [
        f"from {pkg}.crew import {class_name}",
        "",
        "",
        "def run():",
        "    inputs = {",
        *input_lines,
        "    }",
        f"    result = {class_name}().crew().kickoff(inputs=inputs)",
        "    print(result)",
        "    return result",
        "",
        "",
        'if __name__ == "__main__":',
        "    run()",
        "",
    ]
    return "\n".join(lines)


def _readme(plan: CrewPlan) -> str:
    class_name = _class_name(plan)
    pkg = plan.name
    inputs_doc = "\n".join(
        f"- `{i.name}`: {i.description}"
        + (f" (例: {i.example})" if i.example else "")
        for i in plan.inputs
    ) or "- （无额外输入）"
    return f"""# {plan.title}

{plan.summary}

由 Crew Studio 导出，包结构兼容 **CrewAI AMP**（可长期在线观测与改版）。

## 输入

{inputs_doc}

## 本地运行

```bash
cd {pkg}
uv sync   # 或: pip install -e .
# 复制 .env.example → .env，填写模型 Key
uv run python -m {pkg}.main
```

## 部署到 CrewAI AMP

```bash
cd {pkg}
uv lock
crewai org current          # 确认组织
crewai deploy validate
crewai deploy create -y     # 推送到平台；之后可在 AMP 控制台观测 / 改代码再 push
```

类名：`{class_name}` · 配置：`src/{pkg}/config/agents.yaml` 与 `tasks.yaml`。
"""


def _pyproject(plan: CrewPlan) -> str:
    pkg = plan.name
    desc = (plan.title or pkg).replace('"', '\\"')
    return f"""[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "{pkg}"
version = "0.1.0"
description = "{desc}"
requires-python = ">=3.11,<3.14"
dependencies = [
  "crewai[tools]>=1.15.0",
  "python-dotenv>=1.0.0",
]

[project.scripts]
run_crew = "{pkg}.main:run"

[tool.hatch.build.targets.wheel]
packages = ["src/{pkg}"]

[tool.crewai]
type = "crew"
"""


def _exported_coding_tools_src() -> str:
    """Ship the same project-scoped tools used by the Studio sandbox."""
    from pathlib import Path

    src = Path(__file__).with_name("coding_tools.py")
    return src.read_text(encoding="utf-8")


def project_files(plan: CrewPlan) -> dict[str, str]:
    """
    AMP-ready package (paths relative to project root folder named {pkg}):

        {pkg}/
          pyproject.toml
          README.md
          .env.example
          src/{pkg}/
            __init__.py
            crew.py
            main.py
            coding_tools.py   # optional
            config/
              agents.yaml
              tasks.yaml
    """
    pkg = plan.name
    needs_coding_tools = bool(_CUSTOM_CODING_TOOLS & set(_collect_tools(plan)))
    base = f"{pkg}"
    src = f"{pkg}/src/{pkg}"
    files: dict[str, str] = {
        f"{base}/README.md": _readme(plan),
        f"{base}/pyproject.toml": _pyproject(plan),
        f"{base}/.env.example": (
            "DEEPSEEK_API_KEY=\n"
            "OPENAI_API_KEY=\n"
            "MODEL=deepseek/deepseek-chat\n"
            "SERPER_API_KEY=\n"
        ),
        f"{src}/__init__.py": f'"""{plan.title}"""\n',
        f"{src}/crew.py": _crew_py(plan),
        f"{src}/main.py": _main_py(plan),
        f"{src}/config/agents.yaml": _agents_yaml(plan),
        f"{src}/config/tasks.yaml": _tasks_yaml(plan),
        f"{src}/config/.gitkeep": "",
    }
    if needs_coding_tools:
        files[f"{src}/coding_tools.py"] = _exported_coding_tools_src()
    return files


def materialize_project(plan: CrewPlan, dest_dir: str | Path) -> Path:
    """Write the exportable crew package under dest_dir. Returns package root."""
    root = Path(dest_dir)
    root.mkdir(parents=True, exist_ok=True)
    for rel, content in project_files(plan).items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    return root / plan.name


def build_zip(plan: CrewPlan) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, content in project_files(plan).items():
            zf.writestr(rel, content)
    return buf.getvalue()
