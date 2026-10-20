"""Pydantic schemas for Crew Studio plans and chat."""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


def _coerce_to_str(value: Any) -> str:
    """LLM often emits list/dict for example fields — keep as JSON/text string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value)
    return str(value)


class GrantSpec(BaseModel):
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list, description="Skill ids from Studio settings")
    knowledge: list[str] = Field(default_factory=list, description="Knowledge ids from Studio settings")


class CanvasPosition(BaseModel):
    x: float = 0
    y: float = 0


class TaskSchedule(BaseModel):
    enabled: bool = True
    # interval = every N minutes; cron = 5-field cron; once = single run_at
    mode: Literal["interval", "cron", "once"] = "interval"
    interval_minutes: int | None = 60
    cron: str | None = None
    # ISO datetime for mode=once (user-picked local wall time → ISO)
    run_at: str | None = None
    label: str | None = "定时任务"


class RoleTemplate(BaseModel):
    id: str
    title: str
    role: str
    goal: str
    backstory: str
    default_tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    knowledge: list[str] = Field(default_factory=list)


class StaffingSlot(BaseModel):
    role_id: str
    count: int = 1
    note: str = ""


class TeamSpec(BaseModel):
    id: str = Field(description="Stable snake_case id, e.g. research_team")
    name: str
    description: str = ""
    agent_ids: list[str] = Field(default_factory=list)
    grants: GrantSpec = Field(default_factory=GrantSpec)
    collapsed: bool = False
    module: Literal["generic"] = "generic"
    manager_agent_id: str | None = None
    role_catalog: list[RoleTemplate] = Field(default_factory=list)
    staffing: list[StaffingSlot] = Field(default_factory=list)
    allow_parallel: bool = False

    @model_validator(mode="before")
    @classmethod
    def _coerce_team_fields(cls, data: Any) -> Any:
        """coding_general retired; LLM often emits grants as [] instead of {}."""
        if not isinstance(data, dict):
            return data
        out = dict(data)
        if out.get("module") == "coding_general":
            out["module"] = "generic"
        grants = out.get("grants")
        if grants is None or isinstance(grants, list):
            out["grants"] = {}
        elif isinstance(grants, dict):
            # tolerate accidental list values inside grant buckets
            fixed: dict[str, Any] = {}
            for key in ("tools", "skills", "knowledge"):
                val = grants.get(key, [])
                fixed[key] = val if isinstance(val, list) else []
            out["grants"] = fixed
        return out


class AgentSpec(BaseModel):
    id: str = Field(description="Stable snake_case id, e.g. researcher")
    role: str
    goal: str
    backstory: str
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    knowledge: list[str] = Field(default_factory=list)
    team_id: str | None = None
    llm: str | None = None
    is_manager: bool = False
    role_template_id: str | None = None


class TaskSpec(BaseModel):
    id: str = Field(description="Stable snake_case id, e.g. research_task")
    description: str
    expected_output: str
    agent_id: str = Field(description="Must match an AgentSpec.id")
    tools: list[str] = Field(default_factory=list)
    context_task_ids: list[str] = Field(default_factory=list)
    schedule: TaskSchedule | None = None
    async_execution: bool = False


class InputSpec(BaseModel):
    name: str
    description: str = ""
    example: str = ""

    @field_validator("description", "example", mode="before")
    @classmethod
    def _str_fields(cls, v: Any) -> str:
        return _coerce_to_str(v)


class StartSpec(BaseModel):
    """Canvas start node: triggers, schedule, and expected kickoff payload format."""

    id: str = "start"
    label: str = "开始"
    # manual = UI/API kickoff; schedule = timer; webhook = HTTP hint; payload = structured user input
    trigger: Literal["manual", "schedule", "webhook", "payload"] = "manual"
    schedule: TaskSchedule | None = None
    # How the user / upstream should format kickoff data (markdown or schema notes)
    payload_format: str = ""
    payload_example: str = ""
    # Optional webhook path hint (documentation only until hosted triggers exist)
    webhook_path: str = ""
    # Downstream task ids this start wires into (empty = auto entry tasks)
    next_task_ids: list[str] = Field(default_factory=list)
    notes: str = ""

    @field_validator("payload_format", "payload_example", "webhook_path", "notes", "label", mode="before")
    @classmethod
    def _str_fields(cls, v: Any) -> str:
        return _coerce_to_str(v)


class EdgeOverride(BaseModel):
    direction: Literal["uni", "bi"] = "uni"
    reversed: bool = False


class StateFieldSpec(BaseModel):
    """One field on the LangGraph global WorkflowState."""

    name: str
    type: str = "str"
    default: str = ""
    description: str = ""


class GraphModuleSpec(BaseModel):
    """Outer-canvas module: input / crew / router / hitl / output / end."""

    id: str
    kind: Literal["input", "crew", "router", "hitl", "tool", "output", "end"] = "crew"
    label: str = ""
    team_id: str | None = None
    input_keys: list[str] = Field(default_factory=list)
    output_keys: list[str] = Field(default_factory=list)
    # Router / loop: branch key or natural-language condition
    condition: str | None = None
    # output sink: where generated content goes
    sink_kind: Literal["file", "website", "wechat_mp", "webhook", "none"] | None = None
    sink_target: str = ""  # path, URL, account id, webhook URL
    # Sub-DAG library identity (versioned reuse)
    subdag_id: str | None = None
    subdag_version: str = "1.0.0"
    notes: str = ""


class GraphEdgeSpec(BaseModel):
    """Outer LangGraph edge between modules (or start/end). Supports conditional + loop."""

    id: str
    source: str
    target: str
    condition: str | None = None
    label: str = ""
    # When set, this edge is a loop back; runtime caps iterations
    is_loop: bool = False
    max_loops: int = 3


class RunPolicy(BaseModel):
    """Token budget, circuit breaker, breakpoints, optional LangSmith."""

    token_budget_max: int | None = 200_000
    circuit_breaker: bool = True
    breakpoints: list[str] = Field(default_factory=list)
    enable_langsmith: bool = False


class CrewPlan(BaseModel):
    name: str = Field(description="Short project name in snake_case")
    title: str = Field(description="Human-readable crew title")
    summary: str
    teams: list[TeamSpec] = Field(default_factory=list)
    agents: list[AgentSpec]
    tasks: list[TaskSpec]
    inputs: list[InputSpec] = Field(default_factory=list)
    process: Literal["sequential", "hierarchical"] = "sequential"
    layout: dict[str, CanvasPosition] = Field(default_factory=dict)
    edge_overrides: dict[str, EdgeOverride] = Field(default_factory=dict)
    # Always present after normalize — entry for triggers / timers / payload format
    start: StartSpec = Field(default_factory=StartSpec)
    # LangGraph outer orchestration (CrewAI Crews remain inner sub-DAGs)
    orchestration: Literal["crew", "langgraph"] = "langgraph"
    state_fields: list[StateFieldSpec] = Field(default_factory=list)
    modules: list[GraphModuleSpec] = Field(default_factory=list)
    graph_edges: list[GraphEdgeSpec] = Field(default_factory=list)
    run_policy: RunPolicy = Field(default_factory=RunPolicy)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ClarifyingQuestion(BaseModel):
    """One clarifying question shown in a modal with option chips + optional free text."""

    id: str = ""
    prompt: str = ""
    options: list[str] = Field(default_factory=list)
    allow_custom: bool = True

    @model_validator(mode="before")
    @classmethod
    def _coerce_string(cls, data: Any) -> Any:
        if isinstance(data, str):
            return {"prompt": data, "options": [], "allow_custom": True}
        return data


class ChatRequest(BaseModel):
    session_id: str | None = None
    messages: list[ChatMessage]
    plan: CrewPlan | None = None
    # Skip clarify round — one LLM call for plan (frontend presets / skip).
    force_plan: bool = False


class StageTiming(BaseModel):
    """One pipeline stage with wall-clock duration (for UI process + timing)."""

    id: str = ""
    label: str
    duration_ms: int = 0
    detail: str = ""


class ChatResponse(BaseModel):
    session_id: str
    assistant_message: str
    clarifying_questions: list[ClarifyingQuestion] = Field(default_factory=list)
    ready_for_plan: bool = False
    plan: CrewPlan | None = None
    thoughts: list[str] = Field(default_factory=list)
    stage_timings: list[StageTiming] = Field(default_factory=list)


class ReviseRequest(BaseModel):
    session_id: str | None = None
    plan: CrewPlan
    feedback: str
    edited_plan: CrewPlan | None = None


class ReviseResponse(BaseModel):
    session_id: str
    assistant_message: str
    plan: CrewPlan
    thoughts: list[str] = Field(default_factory=list)
    stage_timings: list[StageTiming] = Field(default_factory=list)


class ExportRequest(BaseModel):
    plan: CrewPlan
    # crew = AMP CrewAI package; langgraph = portable LangGraph+CrewAI (no vendor lock-in)
    mode: Literal["crew", "langgraph"] = "langgraph"
    include_dockerfile: bool = True


class OpenInClineRequest(BaseModel):
    plan: CrewPlan
    # Optional override; otherwise settings.editor_command / cursor / code
    editor_command: str | None = None


class RunRequest(BaseModel):
    plan: CrewPlan
    inputs: dict[str, str] = Field(default_factory=dict)
    # When set, only run this outer module / Crew sub-DAG
    module_id: str | None = None
    subdag_only: bool = False


class StartRunRequest(BaseModel):
    """Async run kickoff (POST /api/runs)."""

    plan: CrewPlan
    inputs: dict[str, str] = Field(default_factory=dict)
    # When set, last_run / run_count are written back to this deployment
    deployment_id: str | None = None
    module_id: str | None = None
    subdag_only: bool = False


class ResumeRunRequest(BaseModel):
    """Resume a HITL / breakpoint interrupted run."""

    feedback: str = ""
    approved: bool = True


class RunTaskResult(BaseModel):
    task_id: str
    agent: str = ""
    output: str
    tokens_in: int = 0
    tokens_out: int = 0
    module_id: str | None = None


class TokenEstimate(BaseModel):
    total_max: int = 0
    by_task: dict[str, int] = Field(default_factory=dict)
    by_module: dict[str, int] = Field(default_factory=dict)
    method: str = "static_prompt_heuristic"
    notes: str = ""


class RunResponse(BaseModel):
    ok: bool
    result: str = ""
    error: str | None = None
    logs: str = ""
    events: list[str] = Field(default_factory=list)
    task_results: list[RunTaskResult] = Field(default_factory=list)
    output_dir: str = ""
    saved_files: list[str] = Field(default_factory=list)
    tokens_used: int = 0
    token_estimate: TokenEstimate | None = None
    circuit_broken: bool = False
    waiting_human: bool = False
    interrupt_module_id: str | None = None
    module_results: dict[str, str] = Field(default_factory=dict)


class RunJobResponse(BaseModel):
    """Polled snapshot of an async sandbox run."""

    id: str
    status: Literal["running", "ok", "error", "waiting_human"]
    ok: bool = False
    result: str = ""
    error: str | None = None
    logs: str = ""
    events: list[str] = Field(default_factory=list)
    task_results: list[RunTaskResult] = Field(default_factory=list)
    output_dir: str = ""
    saved_files: list[str] = Field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    deployment_id: str | None = None
    tokens_used: int = 0
    token_estimate: TokenEstimate | None = None
    circuit_broken: bool = False
    waiting_human: bool = False
    interrupt_module_id: str | None = None
    module_results: dict[str, str] = Field(default_factory=dict)
    module_id: str | None = None


class WorkflowDocsRequest(BaseModel):
    plan: CrewPlan


class WorkflowDocsResponse(BaseModel):
    mermaid: str
    markdown: str
    title: str = ""


class SubDAGSaveRequest(BaseModel):
    plan: CrewPlan
    team_id: str
    version: str | None = None
    title: str | None = None


class TokenEstimateRequest(BaseModel):
    plan: CrewPlan


class UpsertScheduleRequest(BaseModel):
    plan: CrewPlan
    inputs: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    # Optional overrides; otherwise taken from first enabled task.schedule
    mode: Literal["interval", "cron", "once"] | None = None
    interval_minutes: int | None = None
    cron: str | None = None
    run_at: str | None = None
    label: str | None = None
    job_id: str | None = None


class ScheduleToggleRequest(BaseModel):
    enabled: bool


class DeployRequest(BaseModel):
    plan: CrewPlan
    # If true, attempt `crewai deploy create` when CLI is available
    push: bool = True


class DeployRunRequest(BaseModel):
    inputs: dict[str, str] = Field(default_factory=dict)
    # Optional when older records lack stored plan
    plan: CrewPlan | None = None
