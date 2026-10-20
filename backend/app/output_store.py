"""Persist sandbox outputs under backend/tmp/<project>/."""

from __future__ import annotations

import re
from pathlib import Path

from .models import CrewPlan, RunTaskResult

BACKEND_ROOT = Path(__file__).resolve().parent.parent
TMP_ROOT = BACKEND_ROOT / "tmp"

_INVALID = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')
_SPACES = re.compile(r"\s+")


def sanitize_folder_name(name: str, fallback: str = "studio_output") -> str:
    cleaned = _INVALID.sub("", (name or "").strip())
    cleaned = _SPACES.sub(" ", cleaned).strip(" .")
    if cleaned.upper() in {"CON", "PRN", "AUX", "NUL", "COM1", "LPT1"}:
        cleaned = f"{cleaned}_out"
    return cleaned[:80] or fallback


def sanitize_filename(name: str, fallback: str = "result") -> str:
    cleaned = sanitize_folder_name(name, fallback)
    cleaned = cleaned.replace(" ", "_")
    if not cleaned.lower().endswith(".md"):
        cleaned = f"{cleaned}.md"
    return cleaned


def project_output_dir(plan: CrewPlan) -> Path:
    """
    Sandbox outputs live in:
      backend/tmp/<项目标题>/
    """
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    folder = sanitize_folder_name(plan.title) or sanitize_folder_name(plan.name)
    path = TMP_ROOT / folder
    path.mkdir(parents=True, exist_ok=True)
    # keep tmp discoverable
    keep = TMP_ROOT / ".gitkeep"
    if not keep.exists():
        keep.write_text("", encoding="utf-8")
    return path


def _title_from_markdown(markdown: str, fallback: str) -> str:
    heading = re.search(r"^#{1,3}\s+(.+)$", markdown or "", re.MULTILINE)
    if heading:
        return heading.group(1).strip()
    first = next(
        (line.strip() for line in (markdown or "").splitlines() if line.strip()),
        "",
    )
    if first:
        return first[:48]
    return fallback


def save_run_outputs(
    plan: CrewPlan,
    result_md: str,
    task_results: list[RunTaskResult],
    inputs: dict | None = None,
) -> tuple[str, list[str]]:
    out_dir = project_output_dir(plan)
    saved: list[str] = []

    final_title = _title_from_markdown(result_md, "最终结果")
    hint = ""
    if inputs:
        for key in ("company", "topic", "brand", "name", "url"):
            if inputs.get(key):
                hint = str(inputs[key])
                break
    if hint and hint not in final_title:
        if hint.startswith("http"):
            hint = re.sub(r"^https?://(www\.)?", "", hint).split("/")[0]
        base = sanitize_folder_name(f"{hint}_{final_title}"[:60], final_title)
    else:
        base = sanitize_folder_name(final_title, "最终结果")

    final_name = sanitize_filename(base, "最终结果")
    final_path = _unique_path(out_dir / final_name)
    final_path.write_text(result_md or "", encoding="utf-8")
    saved.append(final_path.name)

    for tr in task_results:
        if not (tr.output or "").strip():
            continue
        t_title = _title_from_markdown(tr.output, tr.task_id)
        t_name = sanitize_filename(t_title, tr.task_id)
        if t_name == final_path.name:
            t_name = sanitize_filename(f"{tr.task_id}_{t_title}", tr.task_id)
        t_path = _unique_path(out_dir / t_name)
        t_path.write_text(tr.output, encoding="utf-8")
        saved.append(t_path.name)

    return str(out_dir), saved


def _unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(2, 1000):
        candidate = path.with_name(f"{stem}_{i}{suffix}")
        if not candidate.exists():
            return candidate
    return path.with_name(f"{stem}_{path.stat().st_mtime_ns}{suffix}")
