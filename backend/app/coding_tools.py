"""Project-scoped coding tools (Cursor-like: shell + codebase search)."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from crewai.tools import BaseTool
from pydantic import BaseModel, Field


def _safe_root(working_directory: str) -> Path:
    root = Path(working_directory or ".").resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _resolve_under(root: Path, rel: str) -> Path:
    target = (root / (rel or ".")).resolve()
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"路径越界，仅允许访问项目目录内：{rel}") from exc
    return target


class ShellInput(BaseModel):
    command: str = Field(..., description="在项目目录执行的 shell 命令，例如 pytest、npm test、python -m ...")
    timeout_seconds: int = Field(120, ge=1, le=600, description="超时秒数")


class ProjectShellTool(BaseTool):
    name: str = "ProjectShellTool"
    description: str = (
        "在项目工作目录运行 shell 命令（安装依赖、跑测试、构建、git status 等）。"
        "命令仅在沙箱项目目录内执行；先 cd 到相关子目录再跑，不要访问项目外路径。"
    )
    args_schema: type[BaseModel] = ShellInput
    working_directory: str = "."

    def _run(self, command: str, timeout_seconds: int = 120) -> str:
        root = _safe_root(self.working_directory)
        cmd = (command or "").strip()
        if not cmd:
            return "错误：command 为空"
        try:
            completed = subprocess.run(
                cmd,
                shell=True,
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                env={**os.environ, "PYTHONUNBUFFERED": "1"},
            )
        except subprocess.TimeoutExpired:
            return f"错误：命令超时（{timeout_seconds}s）\n$ {cmd}"
        except Exception as exc:  # noqa: BLE001
            return f"错误：{exc}\n$ {cmd}"
        out = (completed.stdout or "")[-12000:]
        err = (completed.stderr or "")[-8000:]
        return (
            f"$ {cmd}\n"
            f"exit={completed.returncode}\ncwd={root}\n"
            f"--- stdout ---\n{out or '(empty)'}\n"
            f"--- stderr ---\n{err or '(empty)'}"
        )


class GrepInput(BaseModel):
    pattern: str = Field(..., description="正则或字面搜索模式")
    path: str = Field(".", description="相对项目根的文件或目录")
    glob: str = Field("*", description="文件名 glob，如 *.py / *.{ts,tsx}")
    case_insensitive: bool = Field(False, description="忽略大小写")
    max_matches: int = Field(80, ge=1, le=200, description="最多返回匹配行数")


class CodebaseGrepTool(BaseTool):
    name: str = "CodebaseGrepTool"
    description: str = (
        "在项目代码库中按模式搜索（类似 ripgrep）。"
        "用于定位符号、调用点、配置键；再配合 FileReadTool / FileWriterTool 修改。"
    )
    args_schema: type[BaseModel] = GrepInput
    working_directory: str = "."

    def _run(
        self,
        pattern: str,
        path: str = ".",
        glob: str = "*",
        case_insensitive: bool = False,
        max_matches: int = 80,
    ) -> str:
        root = _safe_root(self.working_directory)
        start = _resolve_under(root, path)
        flags = re.IGNORECASE if case_insensitive else 0
        try:
            regex = re.compile(pattern, flags)
        except re.error as exc:
            return f"错误：无效正则 — {exc}"

        hits: list[str] = []
        files: list[Path]
        if start.is_file():
            files = [start]
        else:
            files = [p for p in start.rglob(glob or "*") if p.is_file()]

        skip_parts = {".git", "node_modules", "__pycache__", ".venv", "dist", "build", ".tox"}
        for fp in files:
            if any(part in skip_parts for part in fp.parts):
                continue
            if fp.stat().st_size > 1_500_000:
                continue
            try:
                text = fp.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            rel = fp.relative_to(root).as_posix()
            for i, line in enumerate(text.splitlines(), start=1):
                if regex.search(line):
                    hits.append(f"{rel}:{i}:{line.rstrip()[:240]}")
                    if len(hits) >= max_matches:
                        return "\n".join(hits) + f"\n… 已达 max_matches={max_matches}"
        return "\n".join(hits) if hits else f"（无匹配）pattern={pattern!r} path={path!r} glob={glob!r}"


def build_coding_tools(working_directory: str) -> dict[str, BaseTool]:
    """Factory keyed by Studio tool id."""
    return {
        "ProjectShellTool": ProjectShellTool(working_directory=working_directory),
        "CodebaseGrepTool": CodebaseGrepTool(working_directory=working_directory),
    }
