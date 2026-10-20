"""Persistent Studio settings (multi-API, tools, skills, knowledge)."""

from __future__ import annotations

import json
import os
import uuid
from copy import deepcopy
from typing import Any

from pydantic import BaseModel, Field

_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
_SETTINGS_PATH = os.path.join(_DATA_DIR, "settings.json")


class ApiProfile(BaseModel):
    id: str = Field(default_factory=lambda: f"api_{uuid.uuid4().hex[:8]}")
    label: str = "DeepSeek 主账号"
    provider: str = "deepseek"
    model: str = "deepseek/deepseek-chat"
    api_key: str = ""
    base_url: str = "https://api.deepseek.com/v1"


class ModelSettings(BaseModel):
    """Legacy single-model shape (migrated into apis)."""

    provider: str = "deepseek"
    model: str = "deepseek/deepseek-chat"
    api_key: str = ""
    base_url: str = "https://api.deepseek.com/v1"


class SkillSettings(BaseModel):
    id: str
    name: str
    description: str = ""
    path: str = ""
    enabled: bool = True


class ToolSettings(BaseModel):
    id: str
    name: str
    description: str = ""
    enabled: bool = True
    note: str | None = None


class KnowledgeSettings(BaseModel):
    id: str
    name: str
    kind: str = "text"
    source: str = ""
    enabled: bool = True


class StudioSettings(BaseModel):
    theme: str = "light"
    active_api_id: str = ""
    apis: list[ApiProfile] = Field(default_factory=list)
    model: ModelSettings | None = None  # legacy
    skills: list[SkillSettings] = Field(default_factory=list)
    tools: list[ToolSettings] = Field(default_factory=list)
    knowledge: list[KnowledgeSettings] = Field(default_factory=list)
    # Local editor CLI for 「用 Cline 打开」(cursor / code / full path)
    editor_command: str = "cursor"


DEFAULT_TOOLS = [
    ToolSettings(
        id="ScrapeWebsiteTool",
        name="ScrapeWebsiteTool",
        description="抓取网页正文",
        enabled=True,
    ),
    ToolSettings(
        id="URLReadTool",
        name="URLReadTool",
        description="读取 URL / Google Drive 共享链接正文（需「任何有链接可查看」）",
        enabled=True,
        note="适合发票等 Drive 文件；勿用需登录的私密链接",
    ),
    ToolSettings(
        id="SerperDevTool",
        name="SerperDevTool",
        description="搜索（需 SERPER_API_KEY）",
        enabled=False,
        note="需 SERPER_API_KEY",
    ),
    ToolSettings(
        id="FileReadTool",
        name="FileReadTool",
        description="读文件",
        enabled=True,
    ),
    ToolSettings(
        id="FileWriterTool",
        name="FileWriterTool",
        description="写文件（tmp 专属目录）",
        enabled=True,
    ),
    ToolSettings(
        id="DirectoryReadTool",
        name="DirectoryReadTool",
        description="列目录",
        enabled=True,
    ),
    ToolSettings(
        id="CodeInterpreterTool",
        name="CodeInterpreterTool",
        description="代码解释",
        enabled=False,
    ),
    ToolSettings(
        id="ProjectShellTool",
        name="ProjectShellTool",
        description="在项目目录执行 shell（测试/构建/脚本）",
        enabled=True,
    ),
    ToolSettings(
        id="CodebaseGrepTool",
        name="CodebaseGrepTool",
        description="在项目代码中搜索（类似 rg）",
        enabled=True,
    ),
]


def _new_default_api() -> ApiProfile:
    return ApiProfile(
        label="DeepSeek 主账号",
        provider="deepseek",
        model=os.getenv("MODEL", "deepseek/deepseek-chat"),
        api_key=os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY") or "",
        base_url=os.getenv("OPENAI_API_BASE", "https://api.deepseek.com/v1"),
    )


def _default() -> StudioSettings:
    api = _new_default_api()
    return StudioSettings(
        active_api_id=api.id,
        apis=[api],
        tools=deepcopy(DEFAULT_TOOLS),
        skills=[
            SkillSettings(
                id="skill_research",
                name="research-brief",
                description="研究简报 skill",
                path="./skills/research-brief",
                enabled=True,
            )
        ],
        knowledge=[],
    )


def _normalize(settings: StudioSettings) -> StudioSettings:
    if not settings.apis:
        if settings.model:
            api = ApiProfile(
                label="默认",
                provider=settings.model.provider,
                model=settings.model.model,
                api_key=settings.model.api_key,
                base_url=settings.model.base_url,
            )
            settings.apis = [api]
            settings.active_api_id = api.id
        else:
            api = _new_default_api()
            settings.apis = [api]
            settings.active_api_id = api.id
    if not settings.active_api_id or settings.active_api_id not in {
        a.id for a in settings.apis
    }:
        settings.active_api_id = settings.apis[0].id
    settings.model = None
    # Merge newly shipped tools without wiping user toggles
    known = {t.id: t for t in settings.tools}
    for default in DEFAULT_TOOLS:
        if default.id not in known:
            settings.tools.append(deepcopy(default))
    return settings


def active_api(settings: StudioSettings | None = None) -> ApiProfile:
    s = _normalize(settings or load_settings())
    for api in s.apis:
        if api.id == s.active_api_id:
            return api
    return s.apis[0]


def load_settings() -> StudioSettings:
    if not os.path.exists(_SETTINGS_PATH):
        settings = _default()
        save_settings(settings)
        return settings
    try:
        with open(_SETTINGS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        # accept camelCase activeApiId / apis from frontend
        if "activeApiId" in data and "active_api_id" not in data:
            data["active_api_id"] = data.pop("activeApiId")
        if "editorCommand" in data and "editor_command" not in data:
            data["editor_command"] = data.pop("editorCommand")
        if "apis" in data:
            for api in data["apis"]:
                if "apiKey" in api and "api_key" not in api:
                    api["api_key"] = api.pop("apiKey")
                if "baseUrl" in api and "base_url" not in api:
                    api["base_url"] = api.pop("baseUrl")
        settings = StudioSettings.model_validate(data)
        return _normalize(settings)
    except Exception:  # noqa: BLE001
        return _default()


def save_settings(settings: StudioSettings) -> StudioSettings:
    settings = _normalize(settings)
    os.makedirs(_DATA_DIR, exist_ok=True)
    with open(_SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(settings.model_dump(exclude_none=True), f, ensure_ascii=False, indent=2)
    _apply_model_env(active_api(settings))
    return settings


def _apply_model_env(api: ApiProfile) -> None:
    if api.model:
        os.environ["MODEL"] = api.model
    if api.api_key:
        os.environ["DEEPSEEK_API_KEY"] = api.api_key
        os.environ["OPENAI_API_KEY"] = api.api_key
    if api.base_url:
        os.environ["OPENAI_API_BASE"] = api.base_url
        os.environ["OPENAI_BASE_URL"] = api.base_url


def get_enabled_tools() -> list[str]:
    settings = load_settings()
    return [t.id for t in settings.tools if t.enabled]


def get_enabled_skills() -> list[dict[str, Any]]:
    settings = load_settings()
    return [s.model_dump() for s in settings.skills if s.enabled]


def get_enabled_knowledge() -> list[dict[str, Any]]:
    settings = load_settings()
    return [k.model_dump() for k in settings.knowledge if k.enabled]


def public_settings(settings: StudioSettings | None = None) -> dict[str, Any]:
    s = _normalize(settings or load_settings())
    data = s.model_dump(exclude_none=True)
    # camelCase for frontend
    data["activeApiId"] = data.pop("active_api_id", s.active_api_id)
    data["editorCommand"] = data.pop("editor_command", s.editor_command)
    for api in data.get("apis", []):
        key = api.get("api_key") or ""
        api["apiKey"] = ("*" * max(0, len(key) - 4) + key[-4:]) if key else ""
        api["api_key_set"] = bool(key)
        api["baseUrl"] = api.pop("base_url", "")
        api.pop("api_key", None)
    return data


_apply_model_env(active_api(load_settings()))
