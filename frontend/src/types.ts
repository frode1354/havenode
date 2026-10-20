export type GrantSpec = {
  /** Tool class names, e.g. ScrapeWebsiteTool */
  tools: string[]
  /** Skill ids from Studio settings */
  skills: string[]
  /** Knowledge ids from Studio settings */
  knowledge: string[]
}

export type CanvasPosition = { x: number; y: number }

export type TaskSchedule = {
  enabled: boolean
  /** interval = every N minutes; cron = expression; once = run_at */
  mode: 'interval' | 'cron' | 'once'
  interval_minutes?: number
  cron?: string
  /** ISO datetime for mode=once (from user-picked local time) */
  run_at?: string
  label?: string
}

/** Prepared job role; Manager instantiates agents from these when needed. */
export type RoleTemplate = {
  id: string
  title: string
  role: string
  goal: string
  backstory: string
  default_tools: string[]
  skills: string[]
  knowledge: string[]
}

/** Manager staffing decision: how many instances of a role to spawn. */
export type StaffingSlot = {
  role_id: string
  count: number
  note?: string
}

export type TeamModule = 'generic'

export type TeamSpec = {
  id: string
  name: string
  description: string
  /** Agents belonging to this team (same class of work) */
  agent_ids: string[]
  /** Team-level grants inherited by member agents */
  grants: GrantSpec
  /** Collapsed = agents hidden, team shown as compact reusable unit */
  collapsed?: boolean
  /** Team module behaviour (legacy coding_general plans normalize to generic) */
  module?: TeamModule
  /** Manager agent id (hierarchical teams) */
  manager_agent_id?: string | null
  /** Prepared roles (optional legacy field) */
  role_catalog?: RoleTemplate[]
  /** Staffing plan (optional legacy field) */
  staffing?: StaffingSlot[]
  /** Prefer parallel execution when tasks have no hard dependency */
  allow_parallel?: boolean
}

export type AgentSpec = {
  id: string
  role: string
  goal: string
  backstory: string
  tools: string[]
  /** Agent-level skill grants (union with team grants) */
  skills: string[]
  /** Agent-level knowledge grants (union with team grants) */
  knowledge: string[]
  /** Owning team id, if any */
  team_id?: string | null
  llm?: string | null
  /** True if this agent is the team Manager */
  is_manager?: boolean
  /** Role template id this agent was generated from */
  role_template_id?: string | null
}

export type TaskSpec = {
  id: string
  description: string
  expected_output: string
  agent_id: string
  tools: string[]
  context_task_ids: string[]
  /** Optional timer / cron schedule */
  schedule?: TaskSchedule | null
  /** Allow concurrent run with other async tasks (no shared context). */
  async_execution?: boolean
}

export type InputSpec = {
  name: string
  description: string
  example: string
}

/** How the crew is kicked off from the Start node */
export type StartTrigger = 'manual' | 'schedule' | 'webhook' | 'payload'

/** Canvas start node: triggers, timer, and expected kickoff payload format */
export type StartSpec = {
  id: string
  label: string
  trigger: StartTrigger
  schedule?: TaskSchedule | null
  /** Expected user / upstream payload format (markdown or schema notes) */
  payload_format?: string
  payload_example?: string
  webhook_path?: string
  /** Downstream tasks; empty = auto-wire entry tasks (no context) */
  next_task_ids?: string[]
  notes?: string
}

/** uni = one-way info flow; bi = two-way communication */
export type EdgeDirection = 'uni' | 'bi'

export type EdgeOverride = {
  direction: EdgeDirection
  /** When uni, flip visual source/target without changing graph membership */
  reversed?: boolean
}

/** One field on the LangGraph global WorkflowState */
export type StateFieldSpec = {
  name: string
  type?: string
  default?: string
  description?: string
}

/** Outer-canvas module (input / Crew / router / HITL / output / end) */
export type GraphModuleSpec = {
  id: string
  kind: 'input' | 'crew' | 'router' | 'hitl' | 'tool' | 'output' | 'end'
  label?: string
  team_id?: string | null
  input_keys?: string[]
  output_keys?: string[]
  condition?: string | null
  sink_kind?: 'file' | 'website' | 'wechat_mp' | 'webhook' | 'none' | null
  sink_target?: string
  subdag_id?: string | null
  subdag_version?: string
  notes?: string
}

export type GraphEdgeSpec = {
  id: string
  source: string
  target: string
  condition?: string | null
  label?: string
  is_loop?: boolean
  max_loops?: number
}

export type RunPolicy = {
  token_budget_max?: number | null
  circuit_breaker?: boolean
  breakpoints?: string[]
  enable_langsmith?: boolean
}

export type CrewPlan = {
  name: string
  title: string
  summary: string
  teams: TeamSpec[]
  agents: AgentSpec[]
  tasks: TaskSpec[]
  inputs: InputSpec[]
  process: 'sequential' | 'hierarchical'
  /** Persisted canvas positions keyed by node id (team:x / agent:x / task:x) */
  layout?: Record<string, CanvasPosition>
  /** Per-edge direction overrides (collab / context arrow edges) */
  edge_overrides?: Record<string, EdgeOverride>
  /** Entry node for triggers / timers / formatted kickoff inputs */
  start?: StartSpec
  /** Outer engine: langgraph (default) or plain crew */
  orchestration?: 'crew' | 'langgraph'
  state_fields?: StateFieldSpec[]
  modules?: GraphModuleSpec[]
  graph_edges?: GraphEdgeSpec[]
  run_policy?: RunPolicy
}

export type TokenEstimate = {
  total_max: number
  by_task: Record<string, number>
  by_module: Record<string, number>
  method?: string
  notes?: string
}

export type ChatMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type ClarifyingQuestion = {
  id: string
  prompt: string
  options: string[]
  allow_custom?: boolean
}

export type StageTiming = {
  id?: string
  label: string
  duration_ms: number
  detail?: string
}

/** UI pipeline stage (running / done) for process + elapsed time. */
export type PipelineStage = {
  id: string
  label: string
  status: 'pending' | 'running' | 'waiting' | 'done' | 'error'
  detail?: string
  startedAt?: number
  endedAt?: number
  durationMs?: number
  /** If true, this stage is user-driven — never show elapsed time */
  userWait?: boolean
}

export type ChatResponse = {
  session_id: string
  assistant_message: string
  /** Structured questions for the clarify modal (options + optional free text). */
  clarifying_questions: ClarifyingQuestion[]
  ready_for_plan: boolean
  plan: CrewPlan | null
  thoughts: string[]
  stage_timings?: StageTiming[]
}

/** Coerce API payloads that still send plain strings. */
export function normalizeClarifyingQuestions(
  raw: unknown,
): ClarifyingQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: ClarifyingQuestion[] = []
  raw.forEach((item, i) => {
    if (typeof item === 'string') {
      const prompt = item.trim()
      if (!prompt) return
      out.push({ id: `q${i + 1}`, prompt, options: [], allow_custom: true })
      return
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const prompt = String(o.prompt ?? o.question ?? '').trim()
      if (!prompt) return
      const rawOpts = o.options ?? o.choices
      let options: string[] = []
      if (Array.isArray(rawOpts)) {
        options = rawOpts.map(String).map((s) => s.trim()).filter(Boolean)
      } else if (typeof rawOpts === 'string' && rawOpts.trim()) {
        options = rawOpts.split(/[/|；;、]/).map((s) => s.trim()).filter(Boolean)
      }
      out.push({
        id: String(o.id ?? `q${i + 1}`),
        prompt,
        options,
        allow_custom: o.allow_custom !== false,
      })
    }
  })
  return out
}

export type ReviseResponse = {
  session_id: string
  assistant_message: string
  plan: CrewPlan
  thoughts: string[]
  stage_timings?: StageTiming[]
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** Merge server stage_timings; complete running/pending build steps. */
export function applyServerTimings(
  stages: PipelineStage[],
  timings: StageTiming[] | undefined,
): PipelineStage[] {
  if (!timings?.length) return stages
  const byLabel = new Map(timings.map((t) => [t.label, t]))
  const byId = new Map(timings.filter((t) => t.id).map((t) => [t.id!, t]))
  const now = Date.now()
  return stages.map((s) => {
    const hit = byId.get(s.id) || byLabel.get(s.label)
    if (s.userWait || s.status === 'waiting') {
      const detailParts = [s.detail, hit?.detail].filter(Boolean)
      return {
        ...s,
        detail: detailParts.length ? detailParts.join(' · ') : s.detail,
        durationMs: undefined,
      }
    }
    const completing = s.status === 'running' || s.status === 'pending'
    const endedAt = completing ? now : s.endedAt
    // Prefer server duration for micro-stages (repo/tools/validate); else wall clock
    const durationMs =
      hit != null && hit.duration_ms >= 0
        ? hit.duration_ms
        : s.startedAt != null && endedAt != null
          ? Math.max(0, endedAt - s.startedAt)
          : s.durationMs
    const detailParts = [hit?.detail || s.detail].filter(Boolean)
    return {
      ...s,
      status: completing ? 'done' : s.status,
      durationMs,
      detail: detailParts.length ? detailParts.join(' · ') : s.detail,
      endedAt: endedAt ?? s.endedAt,
    }
  })
}

export type StudioPhase = 'chat' | 'review' | 'editor'

export type RunTaskResult = {
  task_id: string
  agent: string
  output: string
  tokens_in?: number
  tokens_out?: number
  module_id?: string | null
}

export type RunResponse = {
  ok: boolean
  result: string
  error?: string | null
  logs: string
  events: string[]
  task_results: RunTaskResult[]
  output_dir?: string
  saved_files?: string[]
  tokens_used?: number
  token_estimate?: TokenEstimate | null
  circuit_broken?: boolean
  waiting_human?: boolean
  interrupt_module_id?: string | null
  module_results?: Record<string, string>
}

/** Async run job snapshot from POST/GET /api/runs */
export type RunJob = {
  id: string
  status: 'running' | 'ok' | 'error' | 'waiting_human'
  ok: boolean
  result: string
  error?: string | null
  logs: string
  events: string[]
  task_results: RunTaskResult[]
  output_dir?: string
  saved_files?: string[]
  created_at?: string
  updated_at?: string
  deployment_id?: string | null
  tokens_used?: number
  token_estimate?: TokenEstimate | null
  circuit_broken?: boolean
  waiting_human?: boolean
  interrupt_module_id?: string | null
  module_results?: Record<string, string>
  module_id?: string | null
}

export function runJobToResponse(job: RunJob): RunResponse {
  return {
    ok: job.ok,
    result: job.result || '',
    error: job.error,
    logs: job.logs || '',
    events: job.events || [],
    task_results: job.task_results || [],
    output_dir: job.output_dir,
    saved_files: job.saved_files,
    tokens_used: job.tokens_used,
    token_estimate: job.token_estimate,
    circuit_broken: job.circuit_broken,
    waiting_human: job.waiting_human,
    interrupt_module_id: job.interrupt_module_id,
    module_results: job.module_results,
  }
}

export function defaultRunPolicy(): RunPolicy {
  return {
    token_budget_max: 200000,
    circuit_breaker: true,
    breakpoints: [],
    enable_langsmith: false,
  }
}

/** Ensure outer LangGraph modules exist (Teams → Crew sub-DAGs). */
export function ensureWorkflowPlan(plan: CrewPlan): CrewPlan {
  const base = ensurePlanTeams(plan)
  const orchestration = base.orchestration ?? 'langgraph'
  const run_policy = { ...defaultRunPolicy(), ...(base.run_policy ?? {}) }
  let state_fields = Array.isArray(base.state_fields) ? [...base.state_fields] : []
  if (state_fields.length === 0) {
    state_fields = [
      { name: 'inputs', type: 'dict', default: '{}', description: 'Kickoff inputs' },
      { name: 'messages', type: 'list', default: '[]', description: 'Module outputs' },
      { name: 'tokens_used', type: 'int', default: '0', description: 'Cumulative tokens' },
      { name: 'status', type: 'str', default: 'pending', description: 'Run status' },
    ]
  }
  let modules = Array.isArray(base.modules) ? [...base.modules] : []
  let graph_edges = Array.isArray(base.graph_edges) ? [...base.graph_edges] : []

  if (modules.length === 0) {
    if (base.teams.length > 0) {
      modules = base.teams.map((team) => ({
        id: `mod_${team.id}`,
        kind: 'crew' as const,
        label: team.name || team.id,
        team_id: team.id,
        input_keys: ['inputs'],
        output_keys: [`${team.id}_output`],
        subdag_id: team.id,
        subdag_version: '1.0.0',
        notes: team.description || '',
      }))
    } else {
      modules = [
        {
          id: 'mod_main_crew',
          kind: 'crew',
          label: base.title || 'Main Crew',
          team_id: null,
          input_keys: ['inputs'],
          output_keys: ['crew_output'],
          subdag_id: base.name,
          subdag_version: '1.0.0',
        },
      ]
    }
    modules.push({ id: 'mod_end', kind: 'end', label: '结束' })
  }

  if (graph_edges.length === 0 && modules.length) {
    const crewMods = modules.filter((m) => m.kind === 'crew')
    const endMod = modules.find((m) => m.kind === 'end')
    let prev = 'start'
    for (const mod of crewMods) {
      graph_edges.push({
        id: `e_${prev}_${mod.id}`,
        source: prev,
        target: mod.id,
        label: 'next',
      })
      prev = mod.id
    }
    if (endMod) {
      graph_edges.push({
        id: `e_${prev}_${endMod.id}`,
        source: prev,
        target: endMod.id,
        label: 'done',
      })
    }
  }

  return {
    ...base,
    orchestration,
    state_fields,
    modules,
    graph_edges,
    run_policy,
  }
}

export type SelectKind = 'team' | 'agent' | 'task' | 'edge' | 'start' | null

export function emptyGrants(): GrantSpec {
  return { tools: [], skills: [], knowledge: [] }
}

export function defaultSchedule(): TaskSchedule {
  return {
    enabled: true,
    mode: 'cron',
    cron: '0 9 * * *',
    label: '每天 09:00',
  }
}

export function defaultStart(): StartSpec {
  return {
    id: 'start',
    label: '开始',
    trigger: 'manual',
    schedule: null,
    payload_format: '',
    payload_example: '',
    webhook_path: '',
    next_task_ids: [],
    notes: '',
  }
}

export function ensurePlanTeams(plan: CrewPlan): CrewPlan {
  const teams = (Array.isArray(plan.teams) ? plan.teams : []).map((t) => ({
    ...t,
    agent_ids: t.agent_ids ?? [],
    grants: t.grants ?? emptyGrants(),
    collapsed: t.collapsed ?? false,
    // coding_general retired — hand code edits to Cline
    module: 'generic' as TeamModule,
    manager_agent_id: t.manager_agent_id ?? null,
    role_catalog: t.role_catalog ?? [],
    staffing: t.staffing ?? [],
    allow_parallel: t.allow_parallel ?? false,
  }))
  const agents = plan.agents.map((a) => ({
    ...a,
    tools: a.tools ?? [],
    skills: a.skills ?? [],
    knowledge: a.knowledge ?? [],
    team_id: a.team_id ?? null,
    is_manager: a.is_manager ?? false,
    role_template_id: a.role_template_id ?? null,
  }))
  const tasks = plan.tasks.map((t) => ({
    ...t,
    tools: t.tools ?? [],
    context_task_ids: t.context_task_ids ?? [],
    schedule: t.schedule ?? null,
    async_execution: t.async_execution ?? false,
  }))
  const baseStart = defaultStart()
  const start: StartSpec = {
    ...baseStart,
    ...(plan.start ?? {}),
    id: 'start',
    label: plan.start?.label?.trim() || baseStart.label,
    trigger: plan.start?.trigger ?? baseStart.trigger,
    schedule: plan.start?.schedule ?? null,
    payload_format: plan.start?.payload_format ?? '',
    payload_example: plan.start?.payload_example ?? '',
    webhook_path: plan.start?.webhook_path ?? '',
    next_task_ids: Array.isArray(plan.start?.next_task_ids)
      ? plan.start!.next_task_ids!.filter((id) => tasks.some((t) => t.id === id))
      : [],
    notes: plan.start?.notes ?? '',
  }
  return {
    ...plan,
    teams,
    agents,
    tasks,
    layout: plan.layout ?? {},
    edge_overrides: plan.edge_overrides ?? {},
    start,
    orchestration: plan.orchestration ?? 'langgraph',
    state_fields: plan.state_fields ?? [],
    modules: plan.modules ?? [],
    graph_edges: plan.graph_edges ?? [],
    run_policy: plan.run_policy ?? defaultRunPolicy(),
  }
}
