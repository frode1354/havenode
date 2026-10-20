"""DeepSeek-powered Crew Studio conversation and plan generation."""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any

from crewai import LLM
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from .models import (
    ChatMessage,
    ChatResponse,
    ClarifyingQuestion,
    CrewPlan,
    ReviseResponse,
    StageTiming,
)
from .tools_policy import sanitize_tools

_ENV_PATH = os.path.join(os.path.dirname(__file__), "..", ".env")
load_dotenv(_ENV_PATH)


class TurnDecision(BaseModel):
    """LLM decision for a chat turn before optional plan generation."""

    assistant_message: str
    clarifying_questions: list[ClarifyingQuestion] = Field(default_factory=list)
    ready_for_plan: bool = False
    thoughts: list[str] = Field(default_factory=list)


def _get_llm(*, temperature: float = 0.4, max_tokens: int | None = None) -> LLM:
    from .settings_store import active_api

    cfg = active_api()
    api_key = cfg.api_key or os.getenv("DEEPSEEK_API_KEY") or os.getenv("OPENAI_API_KEY")
    if not api_key and cfg.provider != "ollama":
        raise RuntimeError("未配置 API Key，请在设置 → 模型 / API 中填写")
    model = cfg.model or os.getenv("MODEL", "deepseek/deepseek-chat")
    kwargs: dict = {"model": model, "temperature": temperature}
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    if api_key:
        kwargs["api_key"] = api_key
    if cfg.base_url:
        kwargs["base_url"] = cfg.base_url
    return LLM(**kwargs)


def _messages_to_prompt(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for m in messages:
        lines.append(f"{m.role.upper()}: {m.content}")
    return "\n\n".join(lines)


def _extract_json(text: str) -> dict[str, Any] | None:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return None
        try:
            data = json.loads(match.group(0))
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            return None


_COMPACT_HINTS: dict[str, str] = {
    "CrewPlan": (
        '返回唯一 JSON 对象，字段含: name,title,summary,process,"teams",'
        '"agents"(id/role/goal/backstory/tools/team_id),'
        '"tasks"(id/description/expected_output/agent_id/context_task_ids/tools),'
        '"inputs"(name/description/example),'
        '"start"{id:"start",label,trigger:"manual"|"schedule"|"webhook"|"payload",'
        "payload_format,payload_example,next_task_ids,schedule?}。"
        "默认完整工作流：多阶段=多 team（禁止整条流水线塞进 1 个 team）；"
        "agents 2-4；tasks 串联 context_task_ids；inputs 用用户变量名；"
        "调研类 tools 含 ScrapeWebsiteTool/URLReadTool；最终写作含 FileWriterTool；"
        "格式输入则 start.trigger=payload。文案简短。"
    ),
    "TurnDecision": (
        "返回唯一 JSON：assistant_message(str), clarifying_questions"
        '([{id,prompt,options[],allow_custom}]), ready_for_plan(bool), thoughts(str[])。'
        "需澄清时 questions 3～6 条且 options 非空（每题 3～5 个具体互斥选项）；"
        "否则 questions=[] 且 ready_for_plan=true。禁止 agents/tasks。"
    ),
}


def _call_structured(
    llm: LLM,
    prompt: str,
    model: type[BaseModel],
    *,
    compact: bool = False,
) -> BaseModel:
    """Single-shot JSON call (avoid double LLM round-trips that make plan gen feel slow)."""
    if compact and model.__name__ in _COMPACT_HINTS:
        hint = _COMPACT_HINTS[model.__name__]
    else:
        # Prefer compact when available; else small schema (TurnDecision is tiny)
        hint = "Respond with ONLY valid JSON matching this schema:\n" + json.dumps(
            model.model_json_schema(), ensure_ascii=False
        )
    raw = llm.call(
        messages=[{"role": "user", "content": prompt + "\n\n" + hint}]
    )
    raw_text = raw if isinstance(raw, str) else str(raw)
    data = _extract_json(raw_text)
    if not data:
        raise RuntimeError(f"LLM returned unparseable output: {raw_text[:500]}")
    if model.__name__ == "CrewPlan":
        data = _coerce_crew_plan_payload(data)
    return model.model_validate(data)


def _coerce_crew_plan_payload(data: dict[str, Any]) -> dict[str, Any]:
    """Soft-coerce common LLM shape mistakes before Pydantic validation."""
    import json as _json

    def as_str(v: Any) -> str:
        if v is None:
            return ""
        if isinstance(v, str):
            return v
        if isinstance(v, (dict, list)):
            try:
                return _json.dumps(v, ensure_ascii=False)
            except Exception:
                return str(v)
        return str(v)

    for inp in data.get("inputs") or []:
        if isinstance(inp, dict):
            if "example" in inp:
                inp["example"] = as_str(inp.get("example"))
            if "description" in inp:
                inp["description"] = as_str(inp.get("description"))
    start = data.get("start")
    if isinstance(start, dict):
        for key in ("payload_format", "payload_example", "webhook_path", "notes", "label"):
            if key in start:
                start[key] = as_str(start.get(key))
    # Drop unknown module kinds early? leave to model. Clear empty modules so enrich rebuilds.
    if not data.get("modules"):
        data["modules"] = []
    if not data.get("graph_edges"):
        data["graph_edges"] = []
    return data


# Lean system prompt (latency) — question count/options stay full quality.
SYSTEM_CHAT = """Crew Studio 澄清助手。中文。只输出 TurnDecision JSON，不写计划。

工作流生成前必须确认关键缺口。信息不足时 ready_for_plan=false，clarifying_questions 给 4～6 条，且**优先覆盖**：
1) 用户输入结点：需要哪些字段、规定格式示例（缺则追问）
2) 生成/发布方式：本地文件指定路径 / 更新网站 / 微信公众号 / Webhook 等（缺则追问）
3) 条件分支与循环：是否在质量不达标时退回某结点重试（缺则可给选项）
4) 站外发布所需网址、账号、AppID/Secret、API Key（只要输出不是纯本地文件，**必须先问**，未提供则不要 ready_for_plan=true）
5) 产出形态与范围（可压缩进上述题）

每题 options 3～5 个互斥可执行短句，allow_custom=true。prompt 具体，禁止空泛。
assistant_message 一句引导。thoughts 可空。
仅当输入格式、输出方式、必要账号/网址都已明确（或用户明确说稍后再填且仅本地文件）时，ready_for_plan=true，clarifying_questions=[]。
"""

SYSTEM_PLAN = """你是 Crew Studio 计划生成器。输出完整可运行工作流（LangGraph 外层：用户输入→多 Crew 子DAG→条件路由/循环→输出结点→结束），禁止「只有一个 Team」。

硬性要求：
- name: 英文 snake_case；title/summary 可中文；id 英文 snake_case。
- **默认完整流水线**（调研/分析/写作等）：
  1) 通常 3 个 agents，每人一个独立 team（research_team / analysis_team / writing_team）；
  2) tasks 对齐阶段，context_task_ids 严格串联；
  3) 禁止整条流水线塞进 1 个 team。
- start：trigger 必须为 "payload"；写清 payload_format / payload_example；next_task_ids 指向入口 tasks。
- inputs：用户变量原样保留；summary/notes 里写明输出方式（file / website / wechat_mp / webhook）。
- tools：调研用 ScrapeWebsiteTool/URLReadTool；终稿用 FileWriterTool。
- teams.grants 必须是对象；module=generic；process=sequential。
- 需要编码时加唯一 cline；禁止 WebsiteSearchTool / coding_general。
"""

SYSTEM_PLAN_FAST = """完整 CrewPlan（禁止单 Team）：
多阶段→多 team + 串联 tasks；start.trigger=payload + payload_format；
inputs 用用户字段；summary 写明输出方式(file/website/wechat_mp/webhook)；
调研工具+终稿 FileWriterTool。文案短。不要提问。"""


def _context_blocks() -> str:
    try:
        from .settings_store import get_enabled_knowledge, get_enabled_skills

        skills = get_enabled_skills()
        knowledge = get_enabled_knowledge()
    except Exception:  # noqa: BLE001
        return ""
    parts: list[str] = []
    if skills:
        lines = [f"- {s.get('name')}: {s.get('description')} ({s.get('path')})" for s in skills]
        parts.append("可用本地 Skills:\n" + "\n".join(lines))
    if knowledge:
        lines = [
            f"- {k.get('name')} [{k.get('kind')}]: {str(k.get('source') or '')[:200]}"
            for k in knowledge
        ]
        parts.append("知识库条目:\n" + "\n".join(lines))
    return ("\n\n" + "\n\n".join(parts)) if parts else ""


def _ms_since(t0: float) -> int:
    return max(0, int((time.perf_counter() - t0) * 1000))


def handle_chat(
    messages: list[ChatMessage],
    session_id: str | None = None,
    current_plan: CrewPlan | None = None,
    force_plan: bool = False,
) -> ChatResponse:
    sid = session_id or str(uuid.uuid4())
    transcript = _messages_to_prompt(messages)
    extras = _context_blocks()
    timings: list[StageTiming] = []

    def _build_plan_fast() -> tuple[CrewPlan, str]:
        """Studio-like process: repo → tools → generate → validate → summary."""
        from .build_process import (
            build_context_for_prompt,
            check_ready_tools,
            format_build_summary,
            list_reusable_agents,
            validate_crew_plan,
        )

        t_repo = time.perf_counter()
        repo = list_reusable_agents()
        timings.append(
            StageTiming(
                id="scan_agents",
                label="代理仓库",
                duration_ms=_ms_since(t_repo),
                detail=f"{len(repo)} 个可参考" if repo else "无可复用，将新建",
            )
        )

        t_tools = time.perf_counter()
        tools_info = check_ready_tools()
        timings.append(
            StageTiming(
                id="check_tools",
                label="检查工具",
                duration_ms=_ms_since(t_tools),
                detail=f"{len(tools_info['ready'])} 项就绪",
            )
        )

        t0 = time.perf_counter()
        llm_fast = _get_llm(temperature=0.15)
        lean_transcript = transcript[-4000:] if len(transcript) > 4000 else transcript
        build_ctx = build_context_for_prompt()
        plan_prompt = (
            f"{SYSTEM_PLAN_FAST}\n{SYSTEM_PLAN}\n\n--- 构建上下文 ---\n{build_ctx}\n\n"
            f"--- 对话 ---\n{lean_transcript}{extras}\n\n直接输出 CrewPlan JSON。"
        )
        if current_plan:
            plan_prompt += (
                "\n可参考当前计划（勿照抄冗长文案）：\n"
                + current_plan.model_dump_json(exclude_none=True)[:2500]
            )
        plan_obj = _call_structured(llm_fast, plan_prompt, CrewPlan, compact=True)
        assert isinstance(plan_obj, CrewPlan)
        plan_norm = _normalize_plan(plan_obj, user_text=lean_transcript)
        timings.append(
            StageTiming(
                id="gen_plan",
                label="生成计划",
                duration_ms=_ms_since(t0),
                detail=f"{len(plan_norm.agents)} Agent / {len(plan_norm.tasks)} Task",
            )
        )

        t_val = time.perf_counter()
        issues = validate_crew_plan(plan_norm)
        timings.append(
            StageTiming(
                id="validate",
                label="校验工作流",
                duration_ms=_ms_since(t_val),
                detail="通过" if not issues else f"{len(issues)} 条提示",
            )
        )
        summary = format_build_summary(
            plan_norm,
            repo_count=len(repo),
            tool_notes=list(tools_info.get("notes") or []),
            validation=issues,
        )
        return plan_norm, summary

    # Fast path: interview done / skip → Studio build process + one plan call
    if force_plan:
        plan, summary = _build_plan_fast()
        return ChatResponse(
            session_id=sid,
            assistant_message=summary,
            clarifying_questions=[],
            ready_for_plan=True,
            plan=plan,
            thoughts=["已扫描代理仓库与工具", "计划已生成并校验"],
            stage_timings=timings,
        )

    # Clarify path: lean input (skip extras / trim chat); full 3–6 Q × 3–5 opts
    t_clarify = time.perf_counter()
    llm = _get_llm(temperature=0.2, max_tokens=1400)
    # Skip skills/knowledge on clarify — only the user goal matters; extras bloat TTFT.
    lean_chat = transcript[-1800:] if len(transcript) > 1800 else transcript
    decision_prompt = (
        f"{SYSTEM_CHAT}\n\n--- 对话 ---\n{lean_chat}\n\n"
        "输出 TurnDecision JSON。"
        "需澄清：clarifying_questions 3～6 条（每题 3～5 个具体 options），ready_for_plan=false。"
        "已够用：ready_for_plan=true，clarifying_questions=[]。"
    )
    if current_plan:
        decision_prompt += (
            f"\n已有计划：{current_plan.title}（{len(current_plan.agents)}a/"
            f"{len(current_plan.tasks)}t）"
        )
    decision = _call_structured(llm, decision_prompt, TurnDecision, compact=True)
    assert isinstance(decision, TurnDecision)
    timings.append(
        StageTiming(
            id="clarify",
            label="整理问题",
            duration_ms=_ms_since(t_clarify),
            detail=f"{len(decision.clarifying_questions or [])} 题候选",
        )
    )
    questions = _normalize_clarifying_questions(
        decision.clarifying_questions,
        assistant_message=decision.assistant_message,
    )
    if decision.ready_for_plan:
        questions = []
    # Model said "clarify" but returned no usable questions — never leave UI stuck
    if not decision.ready_for_plan and not questions:
        questions = _default_clarifying_questions(decision.assistant_message)
    # Gate: if model claims ready but transcript lacks output/creds answers, force Qs
    if decision.ready_for_plan and not questions:
        low = lean_chat.lower()
        has_output = any(
            h in low
            for h in (
                "本地",
                "文件",
                "网站",
                "公众号",
                "webhook",
                "输出",
                "发布",
                "落盘",
                "稍后",
            )
        )
        needs_remote = any(
            h in low for h in ("网站", "公众号", "微信", "webhook", "cms", "wordpress")
        )
        has_creds = any(
            h in low
            for h in (
                "http",
                "url",
                "appid",
                "secret",
                "账号",
                "token",
                "稍后",
                "环境变量",
                "仅本地",
            )
        )
        if not has_output or (needs_remote and not has_creds):
            decision.ready_for_plan = False
            questions = _default_clarifying_questions(decision.assistant_message)
    # Interview batch: return questions only (frontend asks one-by-one, no plan yet)
    if questions:
        return ChatResponse(
            session_id=sid,
            assistant_message=decision.assistant_message
            or "为了更准地设计工作流，先确认这几项（可跳过）。",
            clarifying_questions=questions,
            ready_for_plan=False,
            plan=None,
            thoughts=decision.thoughts or ["已整理问题，请逐题选择或跳过"],
            stage_timings=timings,
        )

    plan: CrewPlan | None = None
    summary = ""
    if decision.ready_for_plan:
        plan, summary = _build_plan_fast()

    return ChatResponse(
        session_id=sid,
        assistant_message=summary
        or decision.assistant_message
        or ("已生成计划，请在画布上批准或修改。" if plan else decision.assistant_message),
        clarifying_questions=[],
        ready_for_plan=bool(plan) or decision.ready_for_plan,
        plan=plan,
        thoughts=decision.thoughts
        or (["已扫描代理仓库与工具", "计划已生成并校验"] if plan else []),
        stage_timings=timings,
    )


_FALLBACK_OPTIONS = [
    "按你推荐的默认方案继续",
    "我再补充一点细节",
    "先生成一版草稿计划",
]


def _default_clarifying_questions(assistant_message: str = "") -> list[ClarifyingQuestion]:
    """Safety net when the model asks to clarify but omits structured questions."""
    return [
        ClarifyingQuestion(
            id="q_input",
            prompt="用户输入结点需要哪些字段？请选一种规定格式（可自定义补充字段名）",
            options=[
                "company + competitors（竞品周报）",
                "topic + audience（主题简报）",
                "urls + notes（链接清单）",
                "我自定义字段（下框填写）",
            ],
            allow_custom=True,
        ),
        ClarifyingQuestion(
            id="q_output",
            prompt="生成结果要如何输出/发布？",
            options=[
                "写到本地指定目录/文件",
                "更新网站（需站点 URL/API）",
                "发布到微信公众号（需账号凭证）",
                "Webhook/HTTP 推送",
            ],
            allow_custom=True,
        ),
        ClarifyingQuestion(
            id="q_creds",
            prompt="若输出到网站/公众号/Webhook，请提供网址或账号信息（没有则选稍后填）",
            options=[
                "稍后在设置里再填（先只跑通本地）",
                "我下框粘贴 URL / AppID 等",
                "仅本地文件，不需要账号",
                "已有环境变量，工作流里用占位符即可",
            ],
            allow_custom=True,
        ),
        ClarifyingQuestion(
            id="q_route",
            prompt="是否需要条件分支或循环（例如质量不达标退回调研重跑）？",
            options=[
                "要：不通过则循环回上一阶段（最多 3 次）",
                "只要顺序执行，不要循环",
                "要人工复核结点，再决定是否继续",
                "按推荐默认（路由+有限循环）",
            ],
            allow_custom=True,
        ),
        ClarifyingQuestion(
            id="q_scope",
            prompt="工作流阶段怎么拆？",
            options=[
                "调研 → 分析 → 写作（三 Team）",
                "采集 → 写作（两 Team）",
                "只要一个 Team",
                "按推荐默认三阶段",
            ],
            allow_custom=True,
        ),
    ]


def _normalize_clarifying_questions(
    raw: list[ClarifyingQuestion] | list[Any] | None,
    *,
    assistant_message: str = "",
) -> list[ClarifyingQuestion]:
    """Keep the full question batch (3–6); ensure each has suggestion options."""
    out: list[ClarifyingQuestion] = []
    for i, item in enumerate(raw or []):
        if isinstance(item, ClarifyingQuestion):
            q = item
        elif isinstance(item, str):
            prompt = item.strip()
            if not prompt:
                continue
            q = ClarifyingQuestion(id=f"q{i + 1}", prompt=prompt, options=[], allow_custom=True)
        elif isinstance(item, dict):
            try:
                q = ClarifyingQuestion.model_validate(item)
            except Exception:  # noqa: BLE001
                prompt = str(item.get("prompt") or item.get("question") or "").strip()
                if not prompt:
                    continue
                opts_raw = item.get("options") or item.get("choices") or []
                if isinstance(opts_raw, str):
                    opts_raw = [opts_raw]
                q = ClarifyingQuestion(
                    id=str(item.get("id") or f"q{i + 1}"),
                    prompt=prompt,
                    options=[str(o) for o in opts_raw] if isinstance(opts_raw, list) else [],
                    allow_custom=True,
                )
        else:
            continue
        prompt = (q.prompt or "").strip()
        if not prompt and i == 0:
            prompt = (assistant_message or "").strip()
        if not prompt:
            continue
        if not q.id:
            q = q.model_copy(update={"id": f"q{i + 1}"})
        raw_opts = q.options or []
        opts = list(
            dict.fromkeys(str(o).strip() for o in raw_opts if str(o).strip())
        )[:5]
        if len(opts) < 2:
            opts = list(_FALLBACK_OPTIONS)
        out.append(
            q.model_copy(
                update={
                    "options": opts,
                    "prompt": prompt,
                    "allow_custom": True,
                }
            )
        )
        if len(out) >= 6:
            break
    return out


def revise_plan(
    plan: CrewPlan,
    feedback: str,
    edited_plan: CrewPlan | None = None,
    session_id: str | None = None,
) -> ReviseResponse:
    sid = session_id or str(uuid.uuid4())
    t0 = time.perf_counter()
    llm = _get_llm(temperature=0.2)
    base = edited_plan or plan
    prompt = (
        f"{SYSTEM_PLAN_FAST}\n{SYSTEM_PLAN}\n\n"
        "用户要求修改以下 crew 计划。请输出修订后的完整 CrewPlan。\n"
        f"用户反馈：{feedback}\n\n"
        f"当前计划 JSON：\n{base.model_dump_json(exclude_none=True)[:4000]}\n"
    )
    new_plan = _call_structured(llm, prompt, CrewPlan, compact=True)
    assert isinstance(new_plan, CrewPlan)
    new_plan = _normalize_plan(new_plan, user_text=feedback)
    return ReviseResponse(
        session_id=sid,
        assistant_message="已根据你的反馈更新计划，请在画布上继续审阅。",
        plan=new_plan,
        thoughts=["已合并用户反馈", "重新对齐 agents 与 tasks"],
        stage_timings=[
            StageTiming(
                id="revise_plan",
                label="修订计划",
                duration_ms=_ms_since(t0),
                detail="根据反馈重生成",
            )
        ],
    )


def _normalize_plan(plan: CrewPlan, *, user_text: str = "") -> CrewPlan:
    from .cline_agent import CLINE_ROLE_ID, CLINE_TOOLS, is_cline_agent
    from .plan_inputs import ensure_plan_input_specs
    from .workflow_enrich import enrich_full_workflow
    from .workflow_plan import ensure_workflow_plan

    if plan.teams is None:
        plan.teams = []
    if plan.layout is None:
        plan.layout = {}

    for agent in plan.agents:
        agent.tools = sanitize_tools(agent.tools or [])
        agent.skills = list(dict.fromkeys(agent.skills or []))
        agent.knowledge = list(dict.fromkeys(agent.knowledge or []))
        if not agent.llm:
            agent.llm = os.getenv("MODEL", "deepseek/deepseek-chat")
        if is_cline_agent(agent.id, agent.role_template_id) or (
            (agent.role or "").strip().lower() == "cline"
        ):
            agent.role_template_id = CLINE_ROLE_ID
            if not agent.role or agent.role.strip().lower() in {"新 agent", "agent"}:
                agent.role = "Cline"
            agent.tools = sanitize_tools(
                list(dict.fromkeys([*(agent.tools or []), *CLINE_TOOLS]))
            )

    agent_ids = {a.id for a in plan.agents}
    for task in plan.tasks:
        if task.agent_id not in agent_ids and plan.agents:
            task.agent_id = plan.agents[0].id
        task.context_task_ids = [t for t in (task.context_task_ids or []) if t != task.id]
        task.tools = sanitize_tools(task.tools or [])
        if task.schedule and task.schedule.enabled:
            if task.schedule.mode == "interval" and not task.schedule.interval_minutes:
                task.schedule.interval_minutes = 60

    plan.name = re.sub(r"[^a-z0-9_]+", "_", plan.name.lower()).strip("_") or "studio_crew"
    plan = ensure_plan_input_specs(plan)
    # Full workflow: multi-team, user-input, router/loop, output sink
    plan = enrich_full_workflow(plan, user_text=user_text)

    # Re-sync membership after enrich may rewrite teams/agents
    agent_ids = {a.id for a in plan.agents}
    for team in plan.teams:
        team.id = re.sub(r"[^a-z0-9_]+", "_", team.id.lower()).strip("_") or "team"
        team.agent_ids = [aid for aid in (team.agent_ids or []) if aid in agent_ids]
        if team.grants:
            team.grants.tools = sanitize_tools(team.grants.tools or [])
        team.collapsed = True if team.collapsed is None else team.collapsed
        team.module = "generic"
        for agent in plan.agents:
            if agent.team_id == team.id and agent.id not in team.agent_ids:
                team.agent_ids.append(agent.id)
            if agent.id in team.agent_ids and not agent.team_id:
                agent.team_id = team.id

    return ensure_workflow_plan(plan)
