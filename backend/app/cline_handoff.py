"""Hand coding work to the user's local Cline (VS Code / Cursor extension)."""

from __future__ import annotations

import os
import shutil
import subprocess

from .codegen import materialize_project
from .models import CrewPlan
from .output_store import project_output_dir
from .settings_store import load_settings

_CLINERULES = """# Crew Studio → Cline

- Prefer editing the exported crew package under this workspace.
- Do not commit API keys or `.env` secrets.
- Keep agents/tasks YAML and Python in sync when changing structure.
- After edits, verify with the project's suggested install/run commands.
"""


def _brief_markdown(plan: CrewPlan, package_rel: str) -> str:
    agent_lines = "\n".join(
        f"- `{a.id}` — {a.role}: {a.goal}" for a in plan.agents
    ) or "- （无）"
    task_lines = "\n".join(
        f"- `{t.id}` → `{t.agent_id}`: {t.description[:120]}" for t in plan.tasks
    ) or "- （无）"
    input_lines = "\n".join(
        f"- `{i.name}`: {i.description}（例：{i.example}）" for i in plan.inputs
    ) or "- （无）"
    return f"""# Cline 任务简报 · {plan.title}

由 **Crew Studio** 生成。请在本工作区用 **Cline** 完成代码相关修改；Studio 本身不再运行自研编码 Agent。

## 目标

{plan.summary}

## 导出包

- 目录：`{package_rel}/`
- 建议：`cd {package_rel}` 后按 README 安装并试跑。

## Agents

{agent_lines}

## Tasks

{task_lines}

## Inputs

{input_lines}

## 验收建议

1. 阅读 `{package_rel}/README.md` 与 `pyproject.toml`。
2. 若需改结构，同步更新 `config/agents.yaml`、`config/tasks.yaml` 与 `{package_rel}/*.py`。
3. 本地安装依赖后执行入口脚本或 `crewai` 相关命令，确认可 kickoff。
4. 不要把 API Key 写入仓库文件。
"""


def _resolve_editor_command(explicit: str | None = None) -> list[str]:
    """Return argv prefix to open a folder. Prefer settings, then cursor, then code."""
    settings = load_settings()
    configured = (explicit or getattr(settings, "editor_command", "") or "").strip()
    candidates: list[str] = []
    if configured:
        candidates.append(configured)
    candidates.extend(["cursor", "code"])

    for cmd in candidates:
        # Allow full path or bare command
        resolved = shutil.which(cmd) if not (os.path.sep in cmd or (os.path.altsep and os.path.altsep in cmd)) else (
            cmd if os.path.isfile(cmd) else None
        )
        if not resolved and (os.path.sep in cmd or (os.path.altsep and os.path.altsep in cmd)):
            if os.path.isfile(cmd):
                resolved = cmd
        if not resolved:
            # Windows: try .cmd shims
            resolved = shutil.which(f"{cmd}.cmd") or shutil.which(cmd)
        if resolved:
            return [resolved]
    return []


def open_in_cline(plan: CrewPlan, editor_command: str | None = None) -> dict:
    """
    Materialize crew under backend/tmp/<title>/, write Cline brief, open editor.
    """
    workspace = project_output_dir(plan)
    package_root = materialize_project(plan, workspace)
    package_rel = package_root.name

    brief_path = workspace / "CLINE_TASK.md"
    brief_path.write_text(_brief_markdown(plan, package_rel), encoding="utf-8")
    rules_path = workspace / ".clinerules"
    if not rules_path.exists():
        rules_path.write_text(_CLINERULES, encoding="utf-8")

    argv = _resolve_editor_command(editor_command)
    opened = False
    launch_error = ""
    if argv:
        try:
            subprocess.Popen(
                [*argv, str(workspace)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd=str(workspace),
            )
            opened = True
        except OSError as exc:
            launch_error = str(exc)

    if opened:
        message = "已打开工作区；请在 Cline 中打开并执行 CLINE_TASK.md。"
    elif argv:
        message = f"编辑器启动失败（{launch_error or 'unknown'}）。请手动打开：{workspace}"
    else:
        message = (
            f"未找到编辑器命令（设置里的 editorCommand / cursor / code）。"
            f"请手动用装有 Cline 的编辑器打开：{workspace}"
        )

    return {
        "ok": True,
        "opened": opened,
        "workspace_dir": str(workspace),
        "package_dir": str(package_root),
        "brief_path": str(brief_path),
        "editor": argv[0] if argv else "",
        "message": message,
    }
