import { isClineAgent, makeClineAgent } from './clineAgent'
import type {
  AgentSpec,
  CanvasPosition,
  CrewPlan,
  EdgeDirection,
  EdgeOverride,
  GrantSpec,
  StartSpec,
  TaskSchedule,
  TaskSpec,
  TeamSpec,
} from './types'
import { defaultSchedule, defaultStart, emptyGrants, ensurePlanTeams } from './types'

export { isClineAgent } from './clineAgent'

export function updateAgent(plan: CrewPlan, agentId: string, patch: Partial<AgentSpec>): CrewPlan {
  const base = ensurePlanTeams(plan)
  let next: CrewPlan = {
    ...base,
    agents: base.agents.map((a) => (a.id === agentId ? { ...a, ...patch } : a)),
  }
  if (patch.team_id !== undefined) {
    next = syncTeamMembership(next, agentId, patch.team_id)
  }
  return next
}

export function updateTask(plan: CrewPlan, taskId: string, patch: Partial<TaskSpec>): CrewPlan {
  return {
    ...ensurePlanTeams(plan),
    tasks: plan.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)),
  }
}

export function updateStart(plan: CrewPlan, patch: Partial<StartSpec>): CrewPlan {
  const base = ensurePlanTeams(plan)
  const start: StartSpec = {
    ...(base.start ?? defaultStart()),
    ...patch,
    id: 'start',
  }
  // schedule trigger implies schedule.enabled when a schedule object exists
  if (patch.trigger === 'schedule' && !start.schedule) {
    start.schedule = defaultSchedule()
  }
  if (patch.trigger && patch.trigger !== 'schedule' && patch.schedule === undefined) {
    // keep schedule config but don't force-enable unless user set it
  }
  return { ...base, start }
}

/** Entry tasks: explicit next_task_ids, else tasks with no context deps */
export function startEntryTaskIds(plan: CrewPlan): string[] {
  const base = ensurePlanTeams(plan)
  const explicit = base.start?.next_task_ids ?? []
  if (explicit.length) {
    return explicit.filter((id) => base.tasks.some((t) => t.id === id))
  }
  return base.tasks.filter((t) => !(t.context_task_ids?.length)).map((t) => t.id)
}

export function updateTeam(plan: CrewPlan, teamId: string, patch: Partial<TeamSpec>): CrewPlan {
  const base = ensurePlanTeams(plan)
  return {
    ...base,
    teams: base.teams.map((t) => (t.id === teamId ? { ...t, ...patch } : t)),
  }
}

export function updateTeamGrants(plan: CrewPlan, teamId: string, grants: GrantSpec): CrewPlan {
  return updateTeam(plan, teamId, { grants })
}

export function setNodeLayout(
  plan: CrewPlan,
  nodeId: string,
  position: CanvasPosition,
): CrewPlan {
  const base = ensurePlanTeams(plan)
  return {
    ...base,
    layout: { ...(base.layout ?? {}), [nodeId]: position },
  }
}

export function setManyLayouts(
  plan: CrewPlan,
  updates: Record<string, CanvasPosition>,
): CrewPlan {
  const base = ensurePlanTeams(plan)
  return {
    ...base,
    layout: { ...(base.layout ?? {}), ...updates },
  }
}

export function defaultEdgeDirection(edgeId: string): EdgeDirection {
  if (edgeId.startsWith('collab-')) return 'bi'
  if (edgeId.startsWith('ctx-')) return 'uni'
  return 'uni'
}

export function getEdgeOverride(plan: CrewPlan, edgeId: string): EdgeOverride {
  const base = ensurePlanTeams(plan)
  const saved = base.edge_overrides?.[edgeId]
  return {
    direction: saved?.direction ?? defaultEdgeDirection(edgeId),
    reversed: saved?.reversed ?? false,
  }
}

export function setEdgeDirection(
  plan: CrewPlan,
  edgeId: string,
  direction: EdgeDirection,
): CrewPlan {
  const base = ensurePlanTeams(plan)
  const prev = getEdgeOverride(base, edgeId)
  return {
    ...base,
    edge_overrides: {
      ...(base.edge_overrides ?? {}),
      [edgeId]: { ...prev, direction },
    },
  }
}

export function toggleEdgeReversed(plan: CrewPlan, edgeId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const prev = getEdgeOverride(base, edgeId)
  return {
    ...base,
    edge_overrides: {
      ...(base.edge_overrides ?? {}),
      [edgeId]: { ...prev, reversed: !prev.reversed },
    },
  }
}

/** Keep team.agent_ids and agent.team_id in sync. */
export function syncTeamMembership(
  plan: CrewPlan,
  agentId: string,
  teamId: string | null | undefined,
): CrewPlan {
  const base = ensurePlanTeams(plan)
  const teams = base.teams.map((team) => {
    const without = team.agent_ids.filter((id) => id !== agentId)
    if (teamId && team.id === teamId) {
      return { ...team, agent_ids: without.includes(agentId) ? without : [...without, agentId] }
    }
    return { ...team, agent_ids: without }
  })
  const agents = base.agents.map((a) =>
    a.id === agentId ? { ...a, team_id: teamId || null } : a,
  )
  return { ...base, teams, agents }
}

export function toggleTeamCollapsed(plan: CrewPlan, teamId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const team = base.teams.find((t) => t.id === teamId)
  if (!team) return base
  return updateTeam(base, teamId, { collapsed: !team.collapsed })
}

export function addTeam(plan: CrewPlan): CrewPlan {
  const base = ensurePlanTeams(plan)
  const id = `team_${base.teams.length + 1}`
  const team: TeamSpec = {
    id,
    name: '新 Team',
    description: '缩略与复用一组 Agent',
    agent_ids: [],
    grants: emptyGrants(),
    collapsed: false,
    module: 'generic',
  }
  return { ...base, teams: [...base.teams, team] }
}

export function addAgent(plan: CrewPlan, teamId?: string | null): CrewPlan {
  const base = ensurePlanTeams(plan)
  const id = `agent_${base.agents.length + 1}`
  const agent: AgentSpec = {
    id,
    role: '新 Agent',
    goal: '描述目标',
    backstory: '背景故事',
    tools: [],
    skills: [],
    knowledge: [],
    team_id: teamId ?? null,
  }
  let next: CrewPlan = { ...base, agents: [...base.agents, agent] }
  if (teamId) next = syncTeamMembership(next, id, teamId)
  return next
}

/**
 * Add the Cline coding individual (+ one coding task if none assigned to it yet).
 */
export function addClineAgent(plan: CrewPlan, teamId?: string | null): CrewPlan {
  const base = ensurePlanTeams(plan)
  if (base.agents.some((a) => isClineAgent(a))) {
    return base
  }
  const agent = makeClineAgent(base.agents.map((a) => a.id))
  if (teamId) agent.team_id = teamId
  let next: CrewPlan = { ...base, agents: [...base.agents, agent] }
  if (teamId) next = syncTeamMembership(next, agent.id, teamId)

  const hasCodingTask = next.tasks.some((t) => t.agent_id === agent.id)
  if (!hasCodingTask) {
    const taskId = `cline_task_${next.tasks.length + 1}`
    next = {
      ...next,
      tasks: [
        ...next.tasks,
        {
          id: taskId,
          description: [
            '【Cline 编码】完成目标：{goal}',
            '探索 → 编辑 → Shell 验证；交付改动摘要与验证结果。',
          ].join('\n'),
          expected_output: '改动文件列表、验证命令与结果。',
          agent_id: agent.id,
          tools: [],
          context_task_ids: [],
          async_execution: false,
        },
      ],
      inputs: next.inputs.some((i) => i.name === 'goal')
        ? next.inputs
        : [
            ...next.inputs,
            {
              name: 'goal',
              description: '编码目标 / 要完成的功能或修复',
              example: '实现功能并补测试',
            },
          ],
    }
  }
  return next
}

export function addTask(plan: CrewPlan, agentId?: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const id = `task_${base.tasks.length + 1}`
  const aid = agentId ?? base.agents[0]?.id ?? 'agent_1'
  return {
    ...base,
    tasks: [
      ...base.tasks,
      {
        id,
        description: '描述任务',
        expected_output: '期望输出',
        agent_id: aid,
        tools: [],
        context_task_ids: [],
        schedule: null,
      },
    ],
  }
}

export function addScheduledTask(plan: CrewPlan, agentId?: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const id = `cron_task_${base.tasks.length + 1}`
  const aid = agentId ?? base.agents[0]?.id ?? 'agent_1'
  const schedule: TaskSchedule = defaultSchedule()
  return {
    ...base,
    tasks: [
      ...base.tasks,
      {
        id,
        description: '定时执行的任务',
        expected_output: '定时产出',
        agent_id: aid,
        tools: [],
        context_task_ids: [],
        schedule,
      },
    ],
  }
}

export function removeTeam(plan: CrewPlan, teamId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const layout = { ...(base.layout ?? {}) }
  delete layout[`team:${teamId}`]
  return {
    ...base,
    teams: base.teams.filter((t) => t.id !== teamId),
    agents: base.agents.map((a) => (a.team_id === teamId ? { ...a, team_id: null } : a)),
    layout,
  }
}

export function removeAgent(plan: CrewPlan, agentId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const layout = { ...(base.layout ?? {}) }
  delete layout[`agent:${agentId}`]
  const fallback = base.agents.find((a) => a.id !== agentId)?.id ?? 'agent_1'
  return {
    ...base,
    agents: base.agents.filter((a) => a.id !== agentId),
    teams: base.teams.map((t) => ({
      ...t,
      agent_ids: t.agent_ids.filter((id) => id !== agentId),
    })),
    tasks: base.tasks.map((t) =>
      t.agent_id === agentId ? { ...t, agent_id: fallback } : t,
    ),
    layout,
  }
}

export function removeTask(plan: CrewPlan, taskId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const layout = { ...(base.layout ?? {}) }
  delete layout[`task:${taskId}`]
  return {
    ...base,
    tasks: base.tasks
      .filter((t) => t.id !== taskId)
      .map((t) => ({
        ...t,
        context_task_ids: t.context_task_ids.filter((id) => id !== taskId),
      })),
    layout,
  }
}

/** Duplicate a team + its agents as a reusable unit (new ids). */
export function duplicateTeam(plan: CrewPlan, teamId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const src = base.teams.find((t) => t.id === teamId)
  if (!src) return base
  const newTeamId = `team_${base.teams.length + 1}_${Date.now().toString(36).slice(-3)}`
  const idMap = new Map<string, string>()
  const members = base.agents.filter(
    (a) => a.team_id === teamId || src.agent_ids.includes(a.id),
  )
  const clonedAgents: AgentSpec[] = members.map((a, i) => {
    const nid = `agent_${base.agents.length + i + 1}_${Date.now().toString(36).slice(-3)}`
    idMap.set(a.id, nid)
    return {
      ...a,
      id: nid,
      team_id: newTeamId,
      role: `${a.role}（复用）`,
    }
  })
  const newTeam: TeamSpec = {
    ...src,
    id: newTeamId,
    name: `${src.name}（复用）`,
    agent_ids: clonedAgents.map((a) => a.id),
    collapsed: true,
  }
  const origin = base.layout?.[`team:${teamId}`]
  const layout = { ...(base.layout ?? {}) }
  if (origin) {
    layout[`team:${newTeamId}`] = { x: origin.x + 40, y: origin.y + 40 }
  }
  return {
    ...base,
    teams: [...base.teams, newTeam],
    agents: [...base.agents, ...clonedAgents],
    layout,
  }
}

export function duplicateAgent(plan: CrewPlan, agentId: string): CrewPlan {
  const base = ensurePlanTeams(plan)
  const src = base.agents.find((a) => a.id === agentId)
  if (!src) return base
  const nid = `agent_${base.agents.length + 1}_${Date.now().toString(36).slice(-3)}`
  const clone: AgentSpec = {
    ...src,
    id: nid,
    role: `${src.role}（副本）`,
  }
  let next: CrewPlan = { ...base, agents: [...base.agents, clone] }
  if (src.team_id) next = syncTeamMembership(next, nid, src.team_id)
  const origin = base.layout?.[`agent:${agentId}`]
  if (origin) {
    next = setNodeLayout(next, `agent:${nid}`, { x: origin.x + 24, y: origin.y + 24 })
  }
  return next
}

/** Effective grants for an agent = team grants ∪ agent grants. */
export function effectiveGrants(plan: CrewPlan, agentId: string): GrantSpec {
  const base = ensurePlanTeams(plan)
  const agent = base.agents.find((a) => a.id === agentId)
  if (!agent) return emptyGrants()
  const team = agent.team_id ? base.teams.find((t) => t.id === agent.team_id) : undefined
  const tg = team?.grants ?? emptyGrants()
  return {
    tools: uniq([...(tg.tools ?? []), ...(agent.tools ?? [])]),
    skills: uniq([...(tg.skills ?? []), ...(agent.skills ?? [])]),
    knowledge: uniq([...(tg.knowledge ?? []), ...(agent.knowledge ?? [])]),
  }
}

function uniq(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}

export function toggleGrantList(list: string[], id: string, checked: boolean): string[] {
  if (checked) return list.includes(id) ? list : [...list, id]
  return list.filter((x) => x !== id)
}

export const TOOL_CATALOG = [
  'ScrapeWebsiteTool',
  'SerperDevTool',
  'FileReadTool',
  'FileWriterTool',
  'DirectoryReadTool',
  'CodeInterpreterTool',
  'ProjectShellTool',
  'CodebaseGrepTool',
] as const
