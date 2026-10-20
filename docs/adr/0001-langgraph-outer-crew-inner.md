# ADR-0001: LangGraph outer / CrewAI inner

## Status

Accepted

## Context

Crew Studio plans can grow many Agents and Tasks. Flattening everything on one canvas creates dense wiring. Users also need portable export (no vendor lock-in), Human-in-the-loop, token budget controls, and the ability to replay one team without running the whole workflow.

## Decision

- **Outer orchestration**: LangGraph-style `StateGraph` over `WorkflowState` (fields on `CrewPlan`: `modules`, `graph_edges`, `state_fields`, `run_policy`, `orchestration`).
- **Inner execution**: Existing CrewAI Crew / Team remains the unit of work. Each Crew is a **sub-DAG module** editable on a nested canvas (double-click).
- **Runtime**: Studio runs modules via `langgraph_runtime.py`, which calls the existing sandbox for Crew nodes. Real `langgraph` is optional for compile/inspection; export always emits runnable LangGraph code.
- **Export default**: ZIP with `graph.py`, `state.py`, `crews/<module>/`, `requirements.txt`, `run.py`, README, optional Dockerfile.

## Consequences

- Legacy plans auto-normalize to `Start → Crew module(s) → End`.
- AMP deploy path (`mode=crew`) remains available; default UI export is LangGraph portable package.
- HITL / breakpoints / circuit breaker are first-class on `RunPolicy` and run job status `waiting_human`.
