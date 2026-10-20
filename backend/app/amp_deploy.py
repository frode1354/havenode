"""Prepare AMP packages; push when logged in; always support local observatory."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from .codegen import materialize_project
from .deploy_store import DeploymentRecord, upsert_deployment
from .models import CrewPlan
from .plan_inputs import ensure_plan_input_specs

_TMP = Path(__file__).resolve().parent.parent / "tmp" / "deploys"
AMP_CONSOLE = "https://app.crewai.com"

_LOCAL_READY_MSG = (
    "本地服务包已就绪：可在「本地观测台」手动跑、查看框架与画布。"
    "推送 AMP 需先在本机执行：crewai login"
)


def _which(cmd: str) -> str | None:
    return shutil.which(cmd) or shutil.which(f"{cmd}.cmd") or shutil.which(f"{cmd}.exe")


def _run(cmd: list[str], cwd: Path, timeout: int = 180) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ},
            shell=False,
        )
        out = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        return proc.returncode, out.strip()
    except FileNotFoundError:
        return 127, f"找不到命令：{cmd[0]}"
    except subprocess.TimeoutExpired:
        return 124, f"命令超时（{timeout}s）：{' '.join(cmd)}"


def _needs_login(text: str) -> bool:
    t = (text or "").lower()
    return (
        "crewai login" in t
        or "sign up/login" in t
        or "sign up" in t
        and "login" in t
        or "before using the cli" in t
        or "please sign up" in t
    )


def _write_env(pkg: Path, extra: dict[str, str] | None = None) -> None:
    keys = {
        "DEEPSEEK_API_KEY": os.getenv("DEEPSEEK_API_KEY", ""),
        "OPENAI_API_KEY": os.getenv("OPENAI_API_KEY", ""),
        "MODEL": os.getenv("MODEL", "deepseek/deepseek-chat"),
        "SERPER_API_KEY": os.getenv("SERPER_API_KEY", ""),
        "OPENAI_API_BASE": os.getenv("OPENAI_API_BASE", "")
        or os.getenv("DEEPSEEK_BASE_URL", ""),
    }
    if extra:
        keys.update({k: v for k, v in extra.items() if v})
    try:
        from .settings_store import load_settings

        settings = load_settings()
        active = next(
            (a for a in settings.apis if a.id == settings.active_api_id),
            settings.apis[0] if settings.apis else None,
        )
        if active and active.api_key:
            if active.provider == "deepseek":
                keys["DEEPSEEK_API_KEY"] = active.api_key
                keys.setdefault("MODEL", active.model or keys["MODEL"])
                if active.base_url:
                    keys["OPENAI_API_BASE"] = active.base_url
            else:
                keys["OPENAI_API_KEY"] = active.api_key
                keys["MODEL"] = active.model or keys["MODEL"]
                if active.base_url:
                    keys["OPENAI_API_BASE"] = active.base_url
    except Exception:  # noqa: BLE001
        pass

    lines = [f"{k}={v}" for k, v in keys.items() if v]
    (pkg / ".env").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def _write_plan_sidecar(pkg: Path, plan: CrewPlan) -> None:
    (pkg / "studio_plan.json").write_text(
        json.dumps(plan.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def prepare_amp_package(plan: CrewPlan) -> tuple[Path, DeploymentRecord]:
    plan = ensure_plan_input_specs(plan.model_copy(deep=True))
    _TMP.mkdir(parents=True, exist_ok=True)
    pkg = materialize_project(plan, _TMP)
    _write_env(pkg)
    _write_plan_sidecar(pkg, plan)

    log_parts: list[str] = [f"已生成 AMP 包：{pkg}"]

    uv = _which("uv")
    if uv:
        code, out = _run([uv, "lock"], pkg, timeout=240)
        log_parts.append(f"$ uv lock\n{out or '(ok)'}")
        if code != 0 and not (pkg / "uv.lock").exists():
            log_parts.append("uv lock 失败：请在包目录手动执行 uv lock 后再 deploy")
    else:
        log_parts.append("未找到 uv：请安装 uv 后在包目录执行 uv lock")

    rec = DeploymentRecord(
        plan_name=plan.name,
        title=plan.title,
        package_dir=str(pkg),
        status="local",
        amp_console_url=AMP_CONSOLE,
        message=_LOCAL_READY_MSG,
        cli_log="\n\n".join(log_parts),
        plan=plan.model_dump(mode="json"),
    )
    return pkg, upsert_deployment(rec)


def deploy_to_amp(
    plan: CrewPlan,
    *,
    push: bool = True,
) -> DeploymentRecord:
    """
    Always materialize a local-runnable package (observatory).
    If push=True and CLI is logged in, also try crewai deploy create.
    """
    pkg, rec = prepare_amp_package(plan)
    if not push:
        return rec

    crewai = _which("crewai")
    if not crewai:
        rec.status = "local"
        rec.message = (
            _LOCAL_READY_MSG
            + "（未找到 crewai CLI，仅本地观测可用。）"
        )
        rec.cli_log += "\n\n未找到 crewai 命令"
        return upsert_deployment(rec)

    rec.status = "deploying"
    rec.message = "正在推送到 CrewAI AMP…"
    upsert_deployment(rec)

    # Skip slow validate — create will report login / shape errors directly
    args = [crewai, "deploy", "create", "-y", "--skip-validate"]
    code, out = _run(args, pkg, timeout=300)
    rec.cli_log += f"\n\n$ {' '.join(args)}\n{out}"

    if _needs_login(out):
        rec.status = "needs_login"
        rec.message = (
            "AMP 推送需要登录。请在终端执行：crewai login\n"
            "登录后可再点「一键部署到 AMP」。\n"
            "现在可直接打开「本地观测台」手动跑服务、查看框架与画布。"
        )
        return upsert_deployment(rec)

    ok_hint = code == 0 and (
        "successfully" in out.lower()
        or "created" in out.lower()
        or "deployment" in out.lower()
    )
    if ok_hint:
        rec.status = "online"
        rec.message = (
            "已提交到 CrewAI AMP。可在控制台在线观测；本地观测台仍可手动跑。"
        )
        for token in out.replace("\n", " ").split():
            if "crewai.com" in token:
                cleaned = token.strip("()[],.\"'")
                if cleaned.startswith("http"):
                    if "app.crewai.com" in cleaned:
                        rec.amp_console_url = cleaned
                    else:
                        rec.deployment_url = cleaned
    else:
        rec.status = "local"
        rec.message = (
            f"AMP 推送未完成（exit={code}）。本地包仍可用——"
            "请打开「本地观测台」手动跑与观看画布；或登录后重试推送。"
        )

    return upsert_deployment(rec)
