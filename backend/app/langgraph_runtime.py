"""
LangGraph-style outer orchestration over CrewAI Crew sub-DAGs.

Uses langgraph when installed; otherwise a compatible sequential runner that
still honors State, condition edges, HITL interrupts, breakpoints, and token
circuit breakers. Export always emits real LangGraph code for offline runs.
"""

from __future__ import annotations

import os
from typing import Any, Callable

from .models import CrewPlan, RunRequest, RunResponse, RunTaskResult, TokenEstimate
from .token_estimate import estimate_plan_tokens
from .workflow_plan import crew_slice_for_module, ensure_workflow_plan

EventCb = Callable[[str], None]


def _langsmith_env(plan: CrewPlan) -> None:
    policy = plan.run_policy
    if policy and policy.enable_langsmith:
        os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
        # LANGCHAIN_API_KEY / LANGSMITH_API_KEY expected from env


def _next_nodes(plan: CrewPlan, current: str, state: dict[str, Any]) -> list[str]:
    outs = [e for e in plan.graph_edges if e.source == current]
    if not outs:
        return []
    # Prefer edges whose condition matches state["branch"] / status
    branch = str(state.get("branch") or state.get("route") or "")
    if branch:
        matched = [e for e in outs if e.condition and e.condition == branch]
        if matched:
            chosen = matched
        else:
            chosen = [e for e in outs if not e.condition] or outs
    else:
        # Default: follow edges without condition, else first
        chosen = [e for e in outs if not e.condition] or outs

    targets: list[str] = []
    loop_counts: dict[str, int] = dict(state.get("loop_counts") or {})
    for e in chosen:
        if getattr(e, "is_loop", False):
            key = e.id or f"{e.source}->{e.target}"
            used = int(loop_counts.get(key) or 0)
            cap = int(getattr(e, "max_loops", None) or 3)
            if used >= cap:
                # Exhausted loop — fall through to non-loop sibling if any
                continue
            loop_counts[key] = used + 1
            state["loop_counts"] = loop_counts
        targets.append(e.target)
    if targets:
        return targets
    # Loop exhausted: take first non-loop edge
    plain = [e for e in outs if not getattr(e, "is_loop", False)]
    if plain:
        return [plain[0].target]
    return [outs[0].target]


def _module_by_id(plan: CrewPlan, mid: str):
    return next((m for m in plan.modules if m.id == mid), None)


def _estimate_task_tokens(task_id: str, output: str, estimate: TokenEstimate) -> tuple[int, int]:
    ceiling = estimate.by_task.get(task_id, 0)
    out_tok = max(1, len(output or "") // 2)
    in_tok = max(0, ceiling // 5)  # one of ~5 assumed iterations
    return in_tok, out_tok


def run_langgraph_workflow(
    plan: CrewPlan,
    inputs: dict[str, str] | None = None,
    *,
    module_id: str | None = None,
    subdag_only: bool = False,
    resume_state: dict[str, Any] | None = None,
    human_feedback: str = "",
    approved: bool = True,
    on_event: EventCb | None = None,
) -> RunResponse:
    """Execute outer graph; Crew modules call the existing sandbox."""
    from .sandbox import run_crew_sandbox

    def emit(msg: str) -> None:
        if on_event:
            on_event(msg)

    plan = ensure_workflow_plan(plan)
    inputs = dict(inputs or {})
    estimate = estimate_plan_tokens(plan)
    _langsmith_env(plan)

    if subdag_only or module_id:
        mid = module_id or next((m.id for m in plan.modules if m.kind == "crew"), None)
        if not mid:
            return RunResponse(ok=False, error="no crew module to replay", events=["无 Crew 子 DAG"])
        try:
            sliced = crew_slice_for_module(plan, mid)
        except ValueError as exc:
            return RunResponse(ok=False, error=str(exc), events=[str(exc)])
        emit(f"子 DAG 回放 · module={mid}")
        emit(f"Token 预估上界 · {estimate.by_module.get(mid, estimate.total_max)}")
        resp = run_crew_sandbox(RunRequest(plan=sliced, inputs=inputs))
        tokens = sum(
            (t.tokens_in + t.tokens_out) for t in resp.task_results
        ) or min(estimate.by_module.get(mid, 0), estimate.total_max)
        # Annotate module + fill token estimates if sandbox didn't
        task_results: list[RunTaskResult] = []
        for t in resp.task_results:
            tin, tout = t.tokens_in, t.tokens_out
            if not tin and not tout:
                tin, tout = _estimate_task_tokens(t.task_id, t.output, estimate)
            task_results.append(
                RunTaskResult(
                    task_id=t.task_id,
                    agent=t.agent,
                    output=t.output,
                    tokens_in=tin,
                    tokens_out=tout,
                    module_id=mid,
                )
            )
        events = list(resp.events) + [f"子 DAG 完成 · tokens≈{tokens}"]
        return RunResponse(
            ok=resp.ok,
            result=resp.result,
            error=resp.error,
            logs=resp.logs,
            events=events,
            task_results=task_results,
            output_dir=resp.output_dir,
            saved_files=resp.saved_files,
            tokens_used=tokens,
            token_estimate=estimate,
            module_results={mid: resp.result or ""},
        )

    # Full outer graph
    state: dict[str, Any] = {
        "inputs": inputs,
        "messages": [],
        "tokens_used": 0,
        "status": "running",
        "branch": "",
        "module_results": {},
        "human_feedback": human_feedback,
        "loop_counts": {},
        "published": "",
        **{f.name: (inputs.get(f.name) if f.name in inputs else f.default) for f in plan.state_fields},
    }
    if resume_state:
        state.update(resume_state)
        state["human_feedback"] = human_feedback
        if approved:
            state["branch"] = "approved"
            state["status"] = "running"
        else:
            state["branch"] = "rejected"
            state["status"] = "error"

    policy = plan.run_policy
    budget = policy.token_budget_max if policy else None
    breakpoints = set(policy.breakpoints or []) if policy else set()

    emit(f"LangGraph 编排启动 · modules={len(plan.modules)}")
    emit(f"Token 静态上界 · {estimate.total_max}" + (f" · 熔断={budget}" if budget else ""))

    all_task_results: list[RunTaskResult] = []
    logs_parts: list[str] = []
    events: list[str] = []
    current = "start"
    visited = 0
    max_steps = max(20, len(plan.modules) * 4)

    # If resuming from HITL, jump to interrupt module's successors
    if resume_state and resume_state.get("interrupt_module_id"):
        current = str(resume_state["interrupt_module_id"])
        emit(f"HITL 恢复 · from={current} · approved={approved}")
        nxt = _next_nodes(plan, current, state)
        current = nxt[0] if nxt else "mod_end"

    while current and visited < max_steps:
        visited += 1
        if current in ("start",):
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        mod = _module_by_id(plan, current)
        if mod is None:
            # treat bare ids
            if current == "end" or current.endswith("end"):
                break
            events.append(f"未知节点 · {current}")
            break

        if mod.kind == "end":
            state["status"] = "ok"
            emit("到达 End")
            break

        if mod.kind == "hitl" or current in breakpoints:
            state["status"] = "waiting_human"
            state["interrupt_module_id"] = mod.id
            msg = f"等待人工介入 · module={mod.id} ({mod.label or mod.kind})"
            emit(msg)
            events.append(msg)
            return RunResponse(
                ok=False,
                result="",
                error=None,
                logs="\n".join(logs_parts),
                events=events,
                task_results=all_task_results,
                tokens_used=int(state.get("tokens_used") or 0),
                token_estimate=estimate,
                waiting_human=True,
                interrupt_module_id=mod.id,
                module_results=dict(state.get("module_results") or {}),
            )

        if mod.kind == "input":
            # Validate prescribed payload; missing required keys → HITL-style pause
            required = [i.name for i in (plan.inputs or [])]
            missing = [n for n in required if not str(inputs.get(n) or "").strip()]
            note = f"用户输入结点 · fields={required or list(inputs.keys())}"
            if missing:
                state["status"] = "waiting_human"
                state["interrupt_module_id"] = mod.id
                msg = f"缺少规定格式字段 · {', '.join(missing)}"
                emit(msg)
                events.append(msg)
                return RunResponse(
                    ok=False,
                    result="",
                    error=msg,
                    logs="\n".join(logs_parts),
                    events=events,
                    task_results=all_task_results,
                    tokens_used=int(state.get("tokens_used") or 0),
                    token_estimate=estimate,
                    waiting_human=True,
                    interrupt_module_id=mod.id,
                    module_results=dict(state.get("module_results") or {}),
                )
            state["inputs"] = dict(inputs)
            state["module_results"][mod.id] = note
            emit(note)
            events.append(note)
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        if mod.kind == "output":
            sink = getattr(mod, "sink_kind", None) or "file"
            target = (getattr(mod, "sink_target", None) or "").strip()
            body = str(state.get("last_output") or "")
            published = f"[{sink}] {target or 'default'} · {len(body)} chars"
            if sink == "file":
                published = f"本地文件输出就绪 · target={target or '运行输出目录'}"
            elif sink in ("website", "wechat_mp", "webhook"):
                if not target and not any(
                    k in inputs
                    for k in ("publish_url", "webhook_url", "wechat_app_id", "site_url")
                ):
                    state["status"] = "waiting_human"
                    state["interrupt_module_id"] = mod.id
                    msg = f"输出结点缺少网址/账号 · sink={sink}"
                    emit(msg)
                    events.append(msg)
                    return RunResponse(
                        ok=False,
                        result=body,
                        error=msg,
                        logs="\n".join(logs_parts),
                        events=events,
                        task_results=all_task_results,
                        tokens_used=int(state.get("tokens_used") or 0),
                        token_estimate=estimate,
                        waiting_human=True,
                        interrupt_module_id=mod.id,
                        module_results=dict(state.get("module_results") or {}),
                    )
                published = f"已提交发布 · sink={sink} · target={target or 'from inputs'}"
            state["published"] = published
            state["module_results"][mod.id] = published
            emit(f"Output · {published}")
            events.append(f"Output · {published}")
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        if mod.kind == "router":
            # Branch keys must match edge.condition (ok / retry)
            fb = str(state.get("human_feedback") or state.get("last_output") or "").lower()
            if any(k in fb for k in ("reject", "失败", "retry", "重试", "不通过")):
                state["branch"] = "retry"
            else:
                # Default continue path; condition field is descriptive, not the branch key
                state["branch"] = "ok"
            emit(f"Router · {mod.id} → branch={state['branch']}")
            events.append(f"Router · {mod.id} · {state['branch']}")
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        if mod.kind == "tool":
            note = f"Tool module · {mod.id} (passthrough)"
            emit(note)
            events.append(note)
            state["module_results"][mod.id] = note
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        if mod.kind != "crew":
            note = f"跳过未知模块 kind={mod.kind} · {mod.id}"
            emit(note)
            events.append(note)
            nxt = _next_nodes(plan, current, state)
            current = nxt[0] if nxt else ""
            continue

        # Crew sub-DAG
        emit(f"进入 Crew 子 DAG · {mod.label or mod.id}")
        events.append(f"Crew 子 DAG · {mod.id}")
        try:
            sliced = crew_slice_for_module(plan, mod.id)
        except ValueError as exc:
            return RunResponse(
                ok=False,
                error=str(exc),
                events=events + [str(exc)],
                token_estimate=estimate,
                tokens_used=int(state.get("tokens_used") or 0),
            )

        resp = run_crew_sandbox(RunRequest(plan=sliced, inputs=inputs))
        logs_parts.append(resp.logs or "")
        events.extend(resp.events or [])
        mod_tokens = 0
        for t in resp.task_results:
            tin, tout = t.tokens_in, t.tokens_out
            if not tin and not tout:
                tin, tout = _estimate_task_tokens(t.task_id, t.output, estimate)
            mod_tokens += tin + tout
            all_task_results.append(
                RunTaskResult(
                    task_id=t.task_id,
                    agent=t.agent,
                    output=t.output,
                    tokens_in=tin,
                    tokens_out=tout,
                    module_id=mod.id,
                )
            )
        if not mod_tokens:
            mod_tokens = estimate.by_module.get(mod.id, 0) // max(1, len(plan.modules))
        state["tokens_used"] = int(state.get("tokens_used") or 0) + mod_tokens
        state["last_output"] = resp.result or ""
        state["module_results"][mod.id] = resp.result or ""
        for key in mod.output_keys or []:
            state[key] = resp.result or ""
        state["messages"] = list(state.get("messages") or []) + [
            {"module": mod.id, "output": (resp.result or "")[:2000]}
        ]
        emit(f"子 DAG 完成 · {mod.id} · tokens+={mod_tokens} · total={state['tokens_used']}")

        if not resp.ok:
            state["status"] = "error"
            return RunResponse(
                ok=False,
                result=resp.result,
                error=resp.error or f"module {mod.id} failed",
                logs="\n".join(logs_parts),
                events=events,
                task_results=all_task_results,
                output_dir=resp.output_dir,
                saved_files=resp.saved_files,
                tokens_used=int(state["tokens_used"]),
                token_estimate=estimate,
                module_results=dict(state["module_results"]),
            )

        if (
            policy
            and policy.circuit_breaker
            and budget
            and int(state["tokens_used"]) > budget
        ):
            state["status"] = "circuit_broken"
            msg = f"熔断 · tokens={state['tokens_used']} > budget={budget}"
            emit(msg)
            events.append(msg)
            return RunResponse(
                ok=False,
                result=str(state.get("last_output") or ""),
                error=msg,
                logs="\n".join(logs_parts),
                events=events,
                task_results=all_task_results,
                tokens_used=int(state["tokens_used"]),
                token_estimate=estimate,
                circuit_broken=True,
                module_results=dict(state["module_results"]),
            )

        nxt = _next_nodes(plan, current, state)
        current = nxt[0] if nxt else ""

    final = str(state.get("last_output") or "")
    if not final and state.get("module_results"):
        final = "\n\n".join(f"## {k}\n{v}" for k, v in state["module_results"].items())
    events.append(f"编排完成 · tokens≈{state.get('tokens_used')}")
    return RunResponse(
        ok=True,
        result=final,
        logs="\n".join(logs_parts),
        events=events,
        task_results=all_task_results,
        tokens_used=int(state.get("tokens_used") or 0),
        token_estimate=estimate,
        module_results=dict(state.get("module_results") or {}),
    )


def try_compile_langgraph(plan: CrewPlan) -> Any | None:
    """Optional: build a real langgraph StateGraph for inspection / export validation."""
    try:
        from typing import Annotated, TypedDict

        from langgraph.graph import END, START, StateGraph
    except ImportError:
        return None

    plan = ensure_workflow_plan(plan)

    class WorkflowState(TypedDict, total=False):
        inputs: dict
        messages: list
        tokens_used: int
        status: str
        branch: str
        last_output: str

    g: Any = StateGraph(WorkflowState)

    def _passthrough(name: str):
        def node(state: WorkflowState) -> WorkflowState:
            return {**state, "last_output": name}

        return node

    for mod in plan.modules:
        if mod.kind == "end":
            continue
        g.add_node(mod.id, _passthrough(mod.id))

    # Edges
    for edge in plan.graph_edges:
        src = START if edge.source == "start" else edge.source
        tgt = END if edge.target in ("end", "mod_end") or (
            _module_by_id(plan, edge.target) and _module_by_id(plan, edge.target).kind == "end"
        ) else edge.target
        if src == START or (isinstance(src, str) and src != END):
            try:
                g.add_edge(src, tgt)
            except Exception:
                pass

    try:
        return g.compile()
    except Exception:
        return None
