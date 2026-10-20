"""Allowed tools for DeepSeek-only Studio (no OpenAI embedding dependency)."""

from __future__ import annotations

# WebsiteSearchTool requires OpenAI embeddings — never allow it.
BANNED_TOOLS = frozenset({"WebsiteSearchTool"})

ALLOWED_TOOLS = frozenset(
    {
        "ScrapeWebsiteTool",
        "SerperDevTool",
        "FileReadTool",
        "FileWriterTool",
        "DirectoryReadTool",
        "CodeInterpreterTool",
        "ProjectShellTool",
        "CodebaseGrepTool",
        "URLReadTool",
    }
)

# Map banned / alias names onto safe alternatives.
TOOL_ALIASES = {
    "WebsiteSearchTool": "ScrapeWebsiteTool",
    "WebsiteSearch": "ScrapeWebsiteTool",
    # Studio / AMP naming for Drive & shared links
    "URLRead": "URLReadTool",
    "UrlReadTool": "URLReadTool",
    "GoogleDriveTool": "URLReadTool",
    "DriveTool": "URLReadTool",
}


def sanitize_tools(tools: list[str] | None) -> list[str]:
    enabled: set[str] | None = None
    try:
        from .settings_store import get_enabled_tools

        enabled = set(get_enabled_tools())
    except Exception:  # noqa: BLE001
        enabled = None

    cleaned: list[str] = []
    for raw in tools or []:
        name = TOOL_ALIASES.get(raw, raw)
        if name in BANNED_TOOLS:
            name = "ScrapeWebsiteTool"
        if name not in ALLOWED_TOOLS:
            continue
        if enabled is not None and name not in enabled:
            continue
        if name not in cleaned:
            cleaned.append(name)
    return cleaned
