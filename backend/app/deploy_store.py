"""Persist AMP / local deployment records under backend/data/deployments.json."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field

_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
_PATH = os.path.join(_DATA_DIR, "deployments.json")
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


class DeploymentRecord(BaseModel):
    id: str = Field(default_factory=lambda: f"dep_{uuid.uuid4().hex[:10]}")
    plan_name: str = ""
    title: str = ""
    package_dir: str = ""
    # prepared | local | deploying | online | needs_login | failed
    status: str = "prepared"
    amp_console_url: str = "https://app.crewai.com"
    deployment_url: str | None = None
    deployment_id: str | None = None
    message: str = ""
    cli_log: str = ""
    # Full CrewPlan for local observatory (canvas + manual run)
    plan: dict[str, Any] | None = None
    last_run: dict[str, Any] | None = None
    run_count: int = 0
    created_at: str = Field(default_factory=_now)
    updated_at: str = Field(default_factory=_now)


def _load() -> list[dict[str, Any]]:
    if not os.path.exists(_PATH):
        return []
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        return []


def _save(rows: list[dict[str, Any]]) -> None:
    os.makedirs(_DATA_DIR, exist_ok=True)
    with open(_PATH, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)


def list_deployments(plan_name: str | None = None) -> list[DeploymentRecord]:
    with _lock:
        out: list[DeploymentRecord] = []
        for item in _load():
            try:
                rec = DeploymentRecord.model_validate(item)
            except Exception:  # noqa: BLE001
                continue
            if plan_name and rec.plan_name != plan_name:
                continue
            out.append(rec)
        out.sort(key=lambda r: r.updated_at, reverse=True)
        return out


def get_deployment(dep_id: str) -> DeploymentRecord | None:
    for rec in list_deployments():
        if rec.id == dep_id:
            return rec
    return None


def upsert_deployment(rec: DeploymentRecord) -> DeploymentRecord:
    rec.updated_at = _now()
    with _lock:
        rows = _load()
        found = False
        for i, item in enumerate(rows):
            if item.get("id") == rec.id:
                rows[i] = rec.model_dump(mode="json")
                found = True
                break
        if not found:
            rows.insert(0, rec.model_dump(mode="json"))
        _save(rows[:80])
    return rec
