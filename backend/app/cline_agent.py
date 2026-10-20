"""Cline coding individual — single agent that owns coding tasks (not a coding team)."""

from __future__ import annotations

CLINE_ROLE_ID = "cline"

CLINE_TOOLS = [
    "DirectoryReadTool",
    "FileReadTool",
    "FileWriterTool",
    "CodebaseGrepTool",
    "ProjectShellTool",
]

CLINE_BACKSTORY = (
    "你是 Cline：Crew 中的专职编码个体，负责实现、修改与验证代码。"
    "工作循环：探索仓库 → 精读相关文件 → 写入改动 → Shell 验证 → 失败再修。"
    "交付时说明改了哪些文件、如何验证；不要编造未执行的命令结果。"
)


def is_cline_agent(agent_id: str | None, role_template_id: str | None = None) -> bool:
    if role_template_id == CLINE_ROLE_ID:
        return True
    if not agent_id:
        return False
    return agent_id == CLINE_ROLE_ID or agent_id.startswith("cline_")
