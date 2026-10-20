import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  CrewPlan,
  EdgeDirection,
  RunResponse,
  SelectKind,
  StartTrigger,
  TaskSchedule,
} from '../types'
import { defaultSchedule, ensurePlanTeams, ensureWorkflowPlan } from '../types'
import { ScheduleBadge } from './ScheduleDial'
import {
  addAgent,
  addScheduledTask,
  addTask,
  addTeam,
  duplicateAgent,
  duplicateTeam,
  getEdgeOverride,
  removeAgent,
  removeTask,
  removeTeam,
  setEdgeDirection,
  setManyLayouts,
  startEntryTaskIds,
  toggleEdgeReversed,
  updateTask,
  updateTeam,
} from '../planUtils'
import {
  CanvasContextMenu,
  type ContextAction,
  type ContextTarget,
} from './CanvasContextMenu'
import { AgentHistoryModal } from './AgentHistoryModal'

const TEAM_COLORS = ['#4d53e8', '#0d9488', '#c2410c', '#7c3aed', '#0369a1', '#b45309']
const AGENT_COLOR = '#6366f1'
const TASK_COLOR = '#f59e0b'
const SCHEDULE_COLOR = '#10b981'
const START_COLOR = '#0ea5e9'

const TRIGGER_LABEL: Record<StartTrigger, string> = {
  manual: '手动',
  schedule: '定时',
  webhook: 'Webhook',
  payload: '格式输入',
}

export type CanvasLayer =
  | { id: 'root'; kind: 'root'; title: string }
  | { id: string; kind: 'team'; teamId: string; title: string; depth: number }

type TeamNodeData = {
  kind: 'team'
  label: string
  name: string
  agentCount: number
  taskCount: number
  collapsed: boolean
  hasLayer: boolean
  selected: boolean
  color: string
  /** Outer LangGraph module id when this team is a Crew sub-DAG */
  moduleId?: string
  inputKeys?: string[]
  outputKeys?: string[]
  tokenEstimate?: number
  tokensUsed?: number
  onEnterLayer?: () => void
  onFoldToLayer?: () => void
}

type AgentNodeData = {
  kind: 'agent'
  label: string
  role: string
  teamName?: string
  selected: boolean
}

type TaskNodeData = {
  kind: 'task'
  label: string
  agentId: string
  selected: boolean
  scheduled: boolean
  scheduleLabel?: string
  schedule?: TaskSchedule | null
  /** Visualized I/O + tokens from last run / estimate */
  inputHint?: string
  outputPreview?: string
  tokensIn?: number
  tokensOut?: number
  tokenEstimate?: number
}

type StartNodeData = {
  kind: 'start'
  label: string
  trigger: StartTrigger
  triggerLabel: string
  scheduleLabel?: string
  hasPayload: boolean
  selected: boolean
}

type TeamGateNodeData = {
  kind: 'team-in' | 'team-out'
  label: string
  hint: string
  color: string
  selected: boolean
}

/** Entry / exit tasks for a team — used to inherit cross-layer edges onto Team. */
function getTeamBoundary(plan: CrewPlan, teamId: string) {
  const normalized = ensurePlanTeams(plan)
  const team = normalized.teams.find((t) => t.id === teamId)
  if (!team) {
    return {
      memberIds: new Set<string>(),
      layerTasks: [] as CrewPlan['tasks'],
      layerTaskIds: new Set<string>(),
      entryTasks: [] as CrewPlan['tasks'],
      exitTasks: [] as CrewPlan['tasks'],
    }
  }
  const members = normalized.agents.filter(
    (a) => a.team_id === teamId || team.agent_ids.includes(a.id),
  )
  const memberIds = new Set(members.map((m) => m.id))
  const layerTasks = normalized.tasks.filter((t) => memberIds.has(t.agent_id))
  const layerTaskIds = new Set(layerTasks.map((t) => t.id))

  const entryTasks = layerTasks.filter((t) => {
    const ctx = t.context_task_ids || []
    if (ctx.length === 0) return true
    // Entry if any dependency comes from outside the team (or only outside)
    return ctx.some((id) => !layerTaskIds.has(id)) || ctx.every((id) => !layerTaskIds.has(id))
  })
  // Prefer pure entries (no internal deps) first; keep mixed as entries for inbound inherit
  const pureEntries = entryTasks.filter((t) =>
    (t.context_task_ids || []).every((id) => !layerTaskIds.has(id)),
  )
  const entries = pureEntries.length ? pureEntries : entryTasks

  const referencedInside = new Set<string>()
  for (const t of layerTasks) {
    for (const ctx of t.context_task_ids || []) {
      if (layerTaskIds.has(ctx)) referencedInside.add(ctx)
    }
  }
  const exitTasks = layerTasks.filter((t) => {
    // Exit if nothing inside the team depends on it, or something outside does
    const usedOutside = normalized.tasks.some(
      (o) => !layerTaskIds.has(o.id) && (o.context_task_ids || []).includes(t.id),
    )
    const unusedInside = !referencedInside.has(t.id)
    return usedOutside || unusedInside
  })

  return { memberIds, layerTasks, layerTaskIds, entryTasks: entries, exitTasks }
}

/** Langflow-like datatype port colors (semantic, not decorative fills). */
const PORT = {
  message: '#4F46E5',
  text: '#2563EB',
  data: '#4B5563',
  tool: '#DB2777',
  success: '#059669',
  trigger: '#0891B2',
  amber: '#EA580C',
} as const

type PortSpec = { id: string; label: string; color: string; kind: 'in' | 'out' }

function LfPortRow({ port }: { port: PortSpec }) {
  const isIn = port.kind === 'in'
  return (
    <div className={`lf-port-row ${isIn ? 'is-in' : 'is-out'}`}>
      {isIn ? (
        <Handle
          type="target"
          position={Position.Left}
          id={port.id}
          className="lf-handle"
          style={{ background: port.color, borderColor: port.color }}
          title={port.label}
        />
      ) : (
        <Handle
          type="source"
          position={Position.Right}
          id={port.id}
          className="lf-handle"
          style={{ background: port.color, borderColor: port.color }}
          title={port.label}
        />
      )}
      <span className="lf-port-dot" style={{ background: port.color }} aria-hidden />
      <span className="lf-port-label">{port.label}</span>
      <span className="lf-port-type" style={{ color: port.color }}>
        {isIn ? 'in' : 'out'}
      </span>
    </div>
  )
}

function LfNodeShell({
  selected,
  accent,
  icon,
  typeLabel,
  title,
  description,
  inputs = [],
  outputs = [],
  footer,
  className = '',
}: {
  selected: boolean
  accent: string
  icon: string
  typeLabel: string
  title: string
  description?: string
  inputs?: PortSpec[]
  outputs?: PortSpec[]
  footer?: ReactNode
  className?: string
}) {
  return (
    <div className={`lf-node ${selected ? 'selected' : ''} ${className}`}>
      <div className="lf-node-head">
        <span className="lf-node-icon" style={{ background: `${accent}22`, color: accent }}>
          {icon}
        </span>
        <div className="lf-node-head-text">
          <span className="lf-node-type" style={{ color: accent }}>
            {typeLabel}
          </span>
          <strong className="lf-node-name">{title}</strong>
          {description ? <span className="lf-node-desc">{description}</span> : null}
        </div>
        <span className="lf-node-status" title="idle" />
      </div>
      {(inputs.length > 0 || outputs.length > 0) && (
        <div className="lf-node-body" onClick={(e) => e.stopPropagation()}>
          {inputs.map((p) => (
            <LfPortRow key={`in-${p.id}`} port={p} />
          ))}
          {outputs.map((p) => (
            <LfPortRow key={`out-${p.id}`} port={p} />
          ))}
        </div>
      )}
      {footer ? <div className="lf-node-footer">{footer}</div> : null}
    </div>
  )
}

function TeamNode({ data }: { data: TeamNodeData }) {
  return (
    <div
      className={`flow-team-frame collapsed ${data.selected ? 'selected' : ''}`}
      style={{ borderColor: `${data.color}66` }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        data.onEnterLayer?.()
      }}
      title="双击进入 Crew 子 DAG 画布"
    >
      <div className="flow-team-header lf-team-card">
        <div className="lf-node-head">
          <span
            className="lf-node-icon"
            style={{ background: `${data.color}22`, color: data.color }}
          >
            ⌘
          </span>
          <div className="lf-node-head-text">
            <span className="lf-node-type" style={{ color: data.color }}>
              Team · Sub-canvas
            </span>
            <strong className="lf-node-name">{data.name}</strong>
            <span className="lf-node-desc">
              {data.agentCount} agents · {data.taskCount} tasks
              {data.moduleId ? ` · ${data.moduleId}` : ''}
            </span>
          </div>
        </div>
        {(data.inputKeys?.length || data.outputKeys?.length) ? (
          <div className="lf-team-io">
            {data.inputKeys?.length ? `in: ${data.inputKeys.join(', ')}` : ''}
            {data.inputKeys?.length && data.outputKeys?.length ? ' · ' : ''}
            {data.outputKeys?.length ? `out: ${data.outputKeys.join(', ')}` : ''}
          </div>
        ) : null}
        {(data.tokenEstimate != null || data.tokensUsed != null) && (
          <div className="lf-team-io">
            {data.tokensUsed != null ? `tokens≈${data.tokensUsed}` : ''}
            {data.tokensUsed != null && data.tokenEstimate != null ? ' / ' : ''}
            {data.tokenEstimate != null ? `ceil ${data.tokenEstimate}` : ''}
          </div>
        )}
        <div className="team-toggle-row">
          <button
            type="button"
            className="team-toggle"
            onClick={(e) => {
              e.stopPropagation()
              data.onFoldToLayer?.()
            }}
          >
            折叠进子画布
          </button>
          <button
            type="button"
            className="team-toggle primary-toggle"
            onClick={(e) => {
              e.stopPropagation()
              data.onEnterLayer?.()
            }}
          >
            进入子画布
          </button>
        </div>
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="lf-handle"
        style={{ background: data.color, borderColor: data.color }}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="lf-handle"
        style={{ background: data.color, borderColor: data.color }}
      />
    </div>
  )
}

function AgentNode({ data }: { data: AgentNodeData }) {
  return (
    <LfNodeShell
      selected={data.selected}
      accent={PORT.message}
      icon="A"
      typeLabel="Agent"
      title={data.role}
      description={`${data.label}${data.teamName ? ` · ${data.teamName}` : ''}`}
      inputs={[{ id: 'in', label: 'Message', color: PORT.message, kind: 'in' }]}
      outputs={[{ id: 'out', label: 'Response', color: PORT.message, kind: 'out' }]}
      className="lf-agent"
    />
  )
}

function StartNode({ data }: { data: StartNodeData }) {
  return (
    <LfNodeShell
      selected={data.selected}
      accent={PORT.trigger}
      icon="▶"
      typeLabel="Chat Input"
      title={data.label}
      description={[
        data.triggerLabel,
        data.scheduleLabel,
        data.hasPayload ? 'payload' : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      outputs={[{ id: 'out', label: 'Kickoff', color: PORT.trigger, kind: 'out' }]}
      className="lf-start"
    />
  )
}

function TeamGateNode({ data }: { data: TeamGateNodeData }) {
  const isIn = data.kind === 'team-in'
  return (
    <LfNodeShell
      selected={data.selected}
      accent={data.color}
      icon={isIn ? '▹' : '◃'}
      typeLabel={isIn ? 'Entry' : 'Exit'}
      title={data.label}
      description={data.hint}
      inputs={[{ id: 'in', label: isIn ? 'Inbound' : 'From task', color: data.color, kind: 'in' }]}
      outputs={[{ id: 'out', label: isIn ? 'Into team' : 'Outbound', color: data.color, kind: 'out' }]}
      className={`lf-gate ${data.kind}`}
    />
  )
}

function TaskNode({ data }: { data: TaskNodeData }) {
  const tok =
    data.tokensIn != null || data.tokensOut != null
      ? `${data.tokensIn ?? 0}→${data.tokensOut ?? 0} tok`
      : data.tokenEstimate != null
        ? `ceil≈${data.tokenEstimate}`
        : ''
  const descParts = [
    `agent: ${data.agentId}`,
    data.scheduled && data.scheduleLabel ? data.scheduleLabel : null,
    tok || null,
  ].filter(Boolean)
  return (
    <LfNodeShell
      selected={data.selected}
      accent={data.scheduled ? PORT.success : PORT.amber}
      icon="T"
      typeLabel={data.scheduled ? 'Scheduled Task' : 'Task'}
      title={data.label}
      description={descParts.join(' · ')}
      inputs={[
        { id: 'in', label: data.inputHint ? `Context · ${data.inputHint}` : 'Context', color: PORT.data, kind: 'in' },
      ]}
      outputs={[
        {
          id: 'out',
          label: data.outputPreview ? `Output · ${data.outputPreview}` : 'Output',
          color: data.scheduled ? PORT.success : PORT.amber,
          kind: 'out',
        },
      ]}
      footer={
        data.scheduled && data.schedule ? (
          <ScheduleBadge
            mode={data.schedule.mode}
            minutes={data.schedule.interval_minutes}
            cron={data.schedule.cron}
          />
        ) : null
      }
      className={`lf-task ${data.scheduled ? 'scheduled' : ''}`}
    />
  )
}

const nodeTypes = {
  team: TeamNode,
  agent: AgentNode,
  task: TaskNode,
  start: StartNode,
  'team-gate': TeamGateNode,
}

function structureKey(plan: CrewPlan, layerId: string): string {
  const p = ensurePlanTeams(plan)
  const edges = Object.entries(p.edge_overrides ?? {})
    .map(([id, o]) => `${id}:${o.direction}:${o.reversed ? 1 : 0}`)
    .join('|')
  const st = p.start
  const startKey = st
    ? `${st.trigger}:${(st.next_task_ids || []).join(',')}:${st.schedule?.enabled ? 1 : 0}:${(st.payload_format || '').length}`
    : '0'
  return [
    layerId,
    startKey,
    p.teams.map((t) => `${t.id}:${t.collapsed ? 1 : 0}:${t.agent_ids.join(',')}`).join('|'),
    p.agents.map((a) => `${a.id}:${a.team_id ?? ''}`).join('|'),
    p.tasks
      .map((t) => {
        const s = t.schedule
        const sk = s?.enabled
          ? `${s.mode}:${s.interval_minutes ?? ''}:${s.cron ?? ''}`
          : '0'
        return `${t.id}:${t.agent_id}:${t.context_task_ids.join(',')}:${sk}`
      })
      .join('|'),
    edges,
  ].join('||')
}

function arrowMarker(color: string) {
  return { type: MarkerType.ArrowClosed, width: 15, height: 15, color }
}

/** Apply uni/bi direction + optional reverse to a directed edge. */
function withDirection(
  edge: Edge,
  plan: CrewPlan,
  color: string,
  selectable = true,
): Edge {
  if (edge.id.startsWith('exclusive-')) {
    return {
      ...edge,
      selectable: false,
      data: { ...(edge.data as object), kind: 'exclusive', editable: false },
    }
  }
  if (
    edge.id.startsWith('start-') ||
    edge.id.startsWith('team-in-') ||
    edge.id.startsWith('team-out-') ||
    edge.id.startsWith('gate-in-') ||
    edge.id.startsWith('gate-out-')
  ) {
    return {
      ...edge,
      selectable: false,
      markerEnd: arrowMarker(color),
      data: {
        ...(edge.data as object),
        kind: edge.id.startsWith('start-') ? 'start' : 'team-boundary',
        editable: false,
      },
    }
  }
  const ov = getEdgeOverride(plan, edge.id)
  const direction: EdgeDirection = ov.direction
  let source = edge.source
  let target = edge.target
  if (ov.reversed) {
    source = edge.target
    target = edge.source
  }
  const label = direction === 'bi' ? '双向通讯' : '单向传信'
  const base: Edge = {
    ...edge,
    source,
    target,
    selectable,
    label,
    labelStyle: { fill: color, fontSize: 10, fontWeight: 600 },
    style: {
      ...(edge.style as object),
      stroke: color,
      strokeWidth: direction === 'bi' ? 2 : 1.6,
    },
    data: {
      ...(edge.data as object),
      kind: edge.id.startsWith('collab-') ? 'comm' : 'context',
      direction,
      reversed: !!ov.reversed,
      editable: true,
    },
  }
  if (direction === 'bi') {
    return {
      ...base,
      markerStart: arrowMarker(color),
      markerEnd: arrowMarker(color),
    }
  }
  return {
    ...base,
    markerStart: undefined,
    markerEnd: arrowMarker(color),
  }
}

function layoutKey(layerId: string, nodeId: string): string {
  return layerId === 'root' ? nodeId : `${layerId}::${nodeId}`
}

/** RF12 MiniMap uses node.width/height (not style) for bounds — missing → 0×0 empty map. */
function withSize(node: Node, width: number, height: number): Node {
  return {
    ...node,
    width,
    height,
    style: { ...(node.style as object), width, height },
  }
}

function buildRootGraph(
  plan: CrewPlan,
  selectedId: string | null,
  interactive: boolean,
  openLayerIds: Set<string>,
  onEnterLayer: (teamId: string) => void,
  onFoldToLayer: (teamId: string) => void,
  lastRun: RunResponse | null = null,
): { nodes: Node[]; edges: Edge[] } {
  const normalized = ensureWorkflowPlan(plan)
  const layout = normalized.layout ?? {}
  const ns: Node[] = []
  const es: Edge[] = []
  const AGENT_W = 260
  const AGENT_H = 148
  const TEAM_W = 280
  const TEAM_H = 188
  const GAP_Y = 28
  const START_X = -220
  const TASK_X = 460
  const est = lastRun?.token_estimate

  let cursorY = 24
  const foldedAgentIds = new Set<string>()

  // Start node — entry for triggers / timers / payload format
  const start = normalized.start!
  const startNodeId = 'start:start'
  const startSaved = layout[layoutKey('root', startNodeId)]
  const startSched = start.schedule?.enabled ? start.schedule : null
  const startSchedLabel = startSched
    ? startSched.label ||
      (startSched.mode === 'cron'
        ? startSched.cron || '定时'
        : startSched.mode === 'once'
          ? '仅一次'
          : startSched.interval_minutes
            ? `每 ${startSched.interval_minutes} 分钟`
            : '定时')
    : undefined
  ns.push(
    withSize(
      {
        id: startNodeId,
        type: 'start',
        position: startSaved ?? { x: START_X, y: 80 },
        style: { zIndex: 2 },
        data: {
          kind: 'start',
          label: start.label || '开始',
          trigger: start.trigger,
          triggerLabel: TRIGGER_LABEL[start.trigger] || start.trigger,
          scheduleLabel: startSchedLabel,
          hasPayload: !!(
            start.payload_format ||
            start.payload_example ||
            start.trigger === 'payload'
          ),
          selected: selectedId === startNodeId,
        } satisfies StartNodeData,
        draggable: interactive,
      },
      260,
      132,
    ),
  )

  normalized.teams.forEach((team, ti) => {
    const members = normalized.agents.filter(
      (a) => a.team_id === team.id || team.agent_ids.includes(a.id),
    )
    members.forEach((a) => foldedAgentIds.add(a.id))
    const memberIds = new Set(members.map((m) => m.id))
    const memberTasks = normalized.tasks.filter((t) => memberIds.has(t.agent_id))
    const teamNodeId = `team:${team.id}`
    const color = TEAM_COLORS[ti % TEAM_COLORS.length]
    const saved = layout[layoutKey('root', teamNodeId)]
    const hasLayer = openLayerIds.has(`team-layer:${team.id}`)
    const mod = (normalized.modules || []).find(
      (m) => m.kind === 'crew' && m.team_id === team.id,
    )
    const modTokens = mod
      ? (lastRun?.task_results || [])
          .filter((t) => t.module_id === mod.id)
          .reduce((s, t) => s + (t.tokens_in || 0) + (t.tokens_out || 0), 0)
      : undefined

    ns.push(
      withSize(
        {
          id: teamNodeId,
          type: 'team',
          position: saved ?? { x: 24, y: cursorY },
          style: { zIndex: 0 },
          data: {
            kind: 'team',
            label: team.id,
            name: team.name,
            agentCount: members.length,
            taskCount: memberTasks.length,
            collapsed: true,
            hasLayer,
            selected: selectedId === teamNodeId,
            color,
            moduleId: mod?.id,
            inputKeys: mod?.input_keys,
            outputKeys: mod?.output_keys,
            tokenEstimate: mod && est?.by_module ? est.by_module[mod.id] : undefined,
            tokensUsed: modTokens || undefined,
            onEnterLayer: () => onEnterLayer(team.id),
            onFoldToLayer: () => onFoldToLayer(team.id),
          } satisfies TeamNodeData,
          draggable: interactive,
        },
        TEAM_W,
        TEAM_H,
      ),
    )
    cursorY += TEAM_H + GAP_Y
  })

  // Outer control / I/O modules (input / router / hitl / output / end)
  const KIND_LABEL: Record<string, string> = {
    input: '用户输入',
    router: '条件路由',
    hitl: '人工确认',
    output: '输出发布',
    end: '结束',
    tool: '工具',
  }
  const outerMods = (normalized.modules || []).filter((m) => m.kind !== 'crew')
  outerMods.forEach((mod, i) => {
    const nodeId = `module:${mod.id}`
    const saved = layout[layoutKey('root', nodeId)]
    const sinkHint =
      mod.kind === 'output' && mod.sink_kind ? ` · ${mod.sink_kind}` : ''
    ns.push(
      withSize(
        {
          id: nodeId,
          type: 'start',
          position: saved ?? { x: 320 + (i % 3) * 40, y: 24 + i * 100 },
          style: { zIndex: 1 },
          data: {
            kind: 'start',
            label: mod.label || mod.id,
            trigger: 'manual',
            triggerLabel: `${KIND_LABEL[mod.kind] || mod.kind}${sinkHint}`,
            hasPayload: mod.kind === 'input',
            selected: selectedId === nodeId,
          } satisfies StartNodeData,
          draggable: interactive,
        },
        260,
        132,
      ),
    )
  })

  // Wire LangGraph outer edges (start / modules / teams)
  const canvasIdFor = (ref: string): string | null => {
    if (ref === 'start') return startNodeId
    const mod = (normalized.modules || []).find((m) => m.id === ref)
    if (!mod) return null
    if (mod.kind === 'crew' && mod.team_id) {
      const tid = `team:${mod.team_id}`
      return ns.some((n) => n.id === tid) ? tid : null
    }
    const mid = `module:${mod.id}`
    return ns.some((n) => n.id === mid) ? mid : null
  }
  for (const ge of normalized.graph_edges || []) {
    const src = canvasIdFor(ge.source)
    const tgt = canvasIdFor(ge.target)
    if (!src || !tgt) continue
    const isLoop = !!ge.is_loop
    const stroke = isLoop ? '#f59e0b' : ge.condition ? '#38bdf8' : '#a1a1aa'
    es.push(
      withDirection(
        {
          id: `gedge-${ge.id}`,
          source: src,
          target: tgt,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          style: {
            stroke,
            strokeWidth: isLoop ? 2.2 : 1.8,
            strokeDasharray: isLoop ? '6 4' : undefined,
          },
          label: ge.label || ge.condition || (isLoop ? 'loop' : ''),
          labelStyle: { fontSize: 10, fill: stroke },
          data: { kind: 'start', editable: false },
        },
        plan,
        stroke,
        false,
      ),
    )
  }

  // Root only shows ungrouped agents/tasks (team contents live on sub-layers)
  const ungrouped = normalized.agents.filter((a) => !foldedAgentIds.has(a.id))
  ungrouped.forEach((agent, i) => {
    const nodeId = `agent:${agent.id}`
    const saved = layout[layoutKey('root', nodeId)]
    ns.push(
      withSize(
        {
          id: nodeId,
          type: 'agent',
          position: saved ?? { x: 24, y: cursorY + i * (AGENT_H + 24) },
          style: { zIndex: 1 },
          data: {
            kind: 'agent',
            label: agent.id,
            role: agent.role,
            selected: selectedId === nodeId,
          } satisfies AgentNodeData,
          draggable: interactive,
        },
        AGENT_W,
        AGENT_H,
      ),
    )
  })

  const rootTasks = normalized.tasks.filter((t) => !foldedAgentIds.has(t.agent_id))
  rootTasks.forEach((task, i) => {
    pushTaskNode(
      ns,
      es,
      task,
      i,
      selectedId,
      interactive,
      layout,
      'root',
      TASK_X,
      ns,
      plan,
      null,
      lastRun,
    )
  })

  // Start → entry tasks (ungrouped only)
  const entryIds = new Set(startEntryTaskIds(normalized))
  for (const task of rootTasks) {
    if (!entryIds.has(task.id)) continue
    const tid = `task:${task.id}`
    if (!ns.some((n) => n.id === tid)) continue
    es.push(
      withDirection(
        {
          id: `start-${task.id}`,
          source: startNodeId,
          target: tid,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          style: { stroke: START_COLOR, strokeWidth: 2 },
          label: '启动',
          labelStyle: { fontSize: 10, fill: START_COLOR },
          data: { kind: 'start', editable: false },
        },
        plan,
        START_COLOR,
        false,
      ),
    )
  }

  // Inherit team-internal entry/exit edges onto Team front/back nodes
  for (const team of normalized.teams) {
    const teamNodeId = `team:${team.id}`
    if (!ns.some((n) => n.id === teamNodeId)) continue
    const color =
      TEAM_COLORS[normalized.teams.findIndex((t) => t.id === team.id) % TEAM_COLORS.length]
    const { layerTaskIds, entryTasks, exitTasks } = getTeamBoundary(normalized, team.id)

    // Start → Team if any team entry is a kickoff entry
    // Skip when outer LangGraph already wires start → input → crews
    const hasOuterGraph = (normalized.graph_edges || []).some(
      (e) => e.source === 'start' && e.target.startsWith('mod_'),
    )
    if (!hasOuterGraph && entryTasks.some((t) => entryIds.has(t.id))) {
      es.push(
        withDirection(
          {
            id: `start-team-${team.id}`,
            source: startNodeId,
            target: teamNodeId,
            sourceHandle: 'out',
            targetHandle: 'in',
            type: 'smoothstep',
            style: { stroke: START_COLOR, strokeWidth: 2 },
            label: '启动',
            labelStyle: { fontSize: 10, fill: START_COLOR },
            data: { kind: 'start', editable: false },
          },
          plan,
          START_COLOR,
          false,
        ),
      )
    }

    // External task → Team (inbound to entry tasks)
    for (const entry of entryTasks) {
      for (const ctx of entry.context_task_ids || []) {
        if (layerTaskIds.has(ctx)) continue
        const srcId = `task:${ctx}`
        if (!ns.some((n) => n.id === srcId)) continue
        es.push(
          withDirection(
            {
              id: `team-in-${team.id}-${ctx}-${entry.id}`,
              source: srcId,
              target: teamNodeId,
              sourceHandle: 'out',
              targetHandle: 'in',
              type: 'smoothstep',
              style: { stroke: color, strokeWidth: 1.8 },
              label: '进入',
              labelStyle: { fontSize: 10, fill: color },
              data: { kind: 'team-boundary', editable: false },
            },
            plan,
            color,
            false,
          ),
        )
      }
    }

    // Team → external task (outbound from exit tasks)
    for (const ext of rootTasks) {
      for (const ctx of ext.context_task_ids || []) {
        if (!exitTasks.some((t) => t.id === ctx)) continue
        es.push(
          withDirection(
            {
              id: `team-out-${team.id}-${ctx}-${ext.id}`,
              source: teamNodeId,
              target: `task:${ext.id}`,
              sourceHandle: 'out',
              targetHandle: 'in',
              type: 'smoothstep',
              style: { stroke: color, strokeWidth: 1.8 },
              label: '离开',
              labelStyle: { fontSize: 10, fill: color },
              data: { kind: 'team-boundary', editable: false },
            },
            plan,
            color,
            false,
          ),
        )
      }
    }
  }

  return { nodes: ns, edges: es }
}

function buildTeamLayerGraph(
  plan: CrewPlan,
  teamId: string,
  selectedId: string | null,
  interactive: boolean,
  layerId: string,
  lastRun: RunResponse | null = null,
): { nodes: Node[]; edges: Edge[] } {
  const normalized = ensurePlanTeams(plan)
  const layout = normalized.layout ?? {}
  const team = normalized.teams.find((t) => t.id === teamId)
  const ns: Node[] = []
  const es: Edge[] = []
  if (!team) return { nodes: ns, edges: es }

  const color =
    TEAM_COLORS[normalized.teams.findIndex((t) => t.id === teamId) % TEAM_COLORS.length]
  const members = normalized.agents.filter(
    (a) => a.team_id === teamId || team.agent_ids.includes(a.id),
  )
  const { layerTasks, layerTaskIds, entryTasks, exitTasks } = getTeamBoundary(
    normalized,
    teamId,
  )
  const entryIds = new Set(startEntryTaskIds(normalized))

  const AGENT_W = 260
  const AGENT_H = 148
  const TASK_X = 400
  const GATE_IN = `gate-in:${teamId}`
  const GATE_OUT = `gate-out:${teamId}`

  // Boundary gates — inherit parent front/back wires into this layer
  const inboundHints: string[] = []
  if (entryTasks.some((t) => entryIds.has(t.id))) inboundHints.push('Start')
  for (const entry of entryTasks) {
    for (const ctx of entry.context_task_ids || []) {
      if (!layerTaskIds.has(ctx)) inboundHints.push(ctx)
    }
  }
  const outboundHints: string[] = []
  for (const t of normalized.tasks) {
    if (layerTaskIds.has(t.id)) continue
    for (const ctx of t.context_task_ids || []) {
      if (exitTasks.some((e) => e.id === ctx)) outboundHints.push(t.id)
    }
  }

  ns.push(
    withSize(
      {
        id: GATE_IN,
        type: 'team-gate',
        position: layout[layoutKey(layerId, GATE_IN)] ?? { x: -200, y: 80 },
        style: { zIndex: 2 },
        data: {
          kind: 'team-in',
          label: '起点',
          hint: inboundHints.length
            ? `承接 · ${[...new Set(inboundHints)].slice(0, 3).join('、')}`
            : 'Team 入口（继承外侧连线）',
          color,
          selected: selectedId === GATE_IN || selectedId === `team:${teamId}`,
        } satisfies TeamGateNodeData,
        draggable: interactive,
      },
      240,
      128,
    ),
  )
  ns.push(
    withSize(
      {
        id: GATE_OUT,
        type: 'team-gate',
        position: layout[layoutKey(layerId, GATE_OUT)] ?? { x: 680, y: 80 },
        style: { zIndex: 2 },
        data: {
          kind: 'team-out',
          label: '末端',
          hint: outboundHints.length
            ? `接出 · ${[...new Set(outboundHints)].slice(0, 3).join('、')}`
            : 'Team 出口（继承外侧连线）',
          color,
          selected: selectedId === GATE_OUT || selectedId === `team:${teamId}`,
        } satisfies TeamGateNodeData,
        draggable: interactive,
      },
      240,
      128,
    ),
  )

  members.forEach((agent, i) => {
    const nodeId = `agent:${agent.id}`
    const saved = layout[layoutKey(layerId, nodeId)]
    ns.push(
      withSize(
        {
          id: nodeId,
          type: 'agent',
          position: saved ?? { x: 48, y: 40 + i * (AGENT_H + 28) },
          style: { zIndex: 1 },
          data: {
            kind: 'agent',
            label: agent.id,
            role: agent.role,
            teamName: team.name,
            selected: selectedId === nodeId,
          } satisfies AgentNodeData,
          draggable: interactive,
        },
        AGENT_W,
        AGENT_H,
      ),
    )
  })

  for (let i = 0; i < members.length - 1; i++) {
    const a = members[i]
    const b = members[i + 1]
    es.push(
      withDirection(
        {
          id: `collab-${a.id}-${b.id}`,
          source: `agent:${a.id}`,
          target: `agent:${b.id}`,
          sourceHandle: 'out',
          targetHandle: 'in',
          style: { stroke: color },
        },
        plan,
        color,
      ),
    )
  }

  layerTasks.forEach((task, i) => {
    pushTaskNode(
      ns,
      es,
      task,
      i,
      selectedId,
      interactive,
      layout,
      layerId,
      TASK_X,
      ns,
      plan,
      layerTaskIds,
      lastRun,
    )
  })

  // Gate → entry tasks (inherit front wires)
  for (const entry of entryTasks) {
    es.push(
      withDirection(
        {
          id: `gate-in-${teamId}-${entry.id}`,
          source: GATE_IN,
          target: `task:${entry.id}`,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          style: { stroke: color, strokeWidth: 2 },
          label: '进入',
          labelStyle: { fontSize: 10, fill: color },
          data: { kind: 'team-boundary', editable: false },
        },
        plan,
        color,
        false,
      ),
    )
  }

  // Exit tasks → gate (inherit back wires)
  for (const exit of exitTasks) {
    es.push(
      withDirection(
        {
          id: `gate-out-${teamId}-${exit.id}`,
          source: `task:${exit.id}`,
          target: GATE_OUT,
          sourceHandle: 'out',
          targetHandle: 'in',
          type: 'smoothstep',
          style: { stroke: color, strokeWidth: 2 },
          label: '离开',
          labelStyle: { fontSize: 10, fill: color },
          data: { kind: 'team-boundary', editable: false },
        },
        plan,
        color,
        false,
      ),
    )
  }

  return { nodes: ns, edges: es }
}

function pushTaskNode(
  ns: Node[],
  es: Edge[],
  task: CrewPlan['tasks'][number],
  i: number,
  selectedId: string | null,
  interactive: boolean,
  layout: Record<string, { x: number; y: number }>,
  layerId: string,
  taskX: number,
  allNodes: Node[],
  plan: CrewPlan,
  layerTaskIds: Set<string> | null = null,
  lastRun: RunResponse | null = null,
) {
  const nodeId = `task:${task.id}`
  const saved = layout[layoutKey(layerId, nodeId)]
  const scheduled = !!(task.schedule && task.schedule.enabled)
  const scheduleLabel =
    task.schedule?.label ||
    (task.schedule?.mode === 'once'
      ? '仅一次'
      : task.schedule?.mode === 'cron'
        ? task.schedule.cron || '定时'
        : task.schedule?.interval_minutes
          ? `每 ${task.schedule.interval_minutes} 分钟`
          : '定时')
  const tr = lastRun?.task_results?.find((r) => r.task_id === task.id)
  const estTok = lastRun?.token_estimate?.by_task?.[task.id]
  const inputHint =
    (task.context_task_ids || []).length > 0
      ? (task.context_task_ids || []).slice(0, 2).join(', ')
      : 'start/inputs'
  const outputPreview = tr?.output
    ? tr.output.replace(/\s+/g, ' ').slice(0, 48) + (tr.output.length > 48 ? '…' : '')
    : undefined

  ns.push(
    withSize(
      {
        id: nodeId,
        type: 'task',
        position: saved ?? { x: taskX, y: 40 + i * 140 },
        style: { zIndex: 1 },
        data: {
          kind: 'task',
          label: task.id,
          agentId: task.agent_id,
          selected: selectedId === nodeId,
          scheduled,
          scheduleLabel: scheduled ? scheduleLabel : undefined,
          schedule: scheduled ? task.schedule : null,
          inputHint,
          outputPreview,
          tokensIn: tr?.tokens_in,
          tokensOut: tr?.tokens_out,
          tokenEstimate: estTok,
        } satisfies TaskNodeData,
        draggable: interactive,
      },
      280,
      tr || estTok || scheduled ? 188 : 168,
    ),
  )

  const agentVisible = allNodes.some((n) => n.id === `agent:${task.agent_id}`)
  if (agentVisible) {
    es.push(
      withDirection(
        {
          id: `exclusive-${task.agent_id}-${task.id}`,
          source: `agent:${task.agent_id}`,
          target: nodeId,
          sourceHandle: 'out',
          targetHandle: 'in',
          style: {
            stroke: scheduled ? SCHEDULE_COLOR : TASK_COLOR,
            strokeWidth: 1.8,
            strokeDasharray: '6 4',
          },
          label: '专属',
          labelStyle: { fontSize: 10, fill: scheduled ? SCHEDULE_COLOR : TASK_COLOR },
          animated: scheduled,
        },
        plan,
        scheduled ? SCHEDULE_COLOR : TASK_COLOR,
        false,
      ),
    )
  }

  for (const ctx of task.context_task_ids) {
    // Inside team layer: external deps already shown via 起点 gate — skip duplicate
    if (layerTaskIds && !layerTaskIds.has(ctx)) {
      continue
    }
    // Root: skip edges into folded team tasks (shown as Team inbound instead)
    if (!layerTaskIds && !allNodes.some((n) => n.id === `task:${ctx}`)) {
      continue
    }
    es.push(
      withDirection(
        {
          id: `ctx-${ctx}-${task.id}`,
          source: `task:${ctx}`,
          target: nodeId,
          sourceHandle: 'out',
          targetHandle: 'in',
          style: { stroke: '#64748b' },
        },
        plan,
        '#64748b',
      ),
    )
  }

}

type Props = {
  plan: CrewPlan
  selectedId: string | null
  onSelect: (id: string | null, kind: SelectKind) => void
  onChange: (plan: CrewPlan) => void
  interactive?: boolean
  lastRun?: RunResponse | null
}

const ROOT_LAYER: CanvasLayer = { id: 'root', kind: 'root', title: '总览画布' }

export function CrewCanvas({
  plan,
  selectedId,
  onSelect,
  onChange,
  interactive = true,
  lastRun = null,
}: Props) {
  const normalized = useMemo(() => ensurePlanTeams(plan), [plan])
  const wrapperRef = useRef<HTMLDivElement>(null)
  const rfRef = useRef<ReactFlowInstance | null>(null)
  const [layers, setLayers] = useState<CanvasLayer[]>([ROOT_LAYER])
  const [activeLayerId, setActiveLayerId] = useState<string>('root')
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [menu, setMenu] = useState<{
    x: number
    y: number
    target: ContextTarget
  } | null>(null)
  const [historyAgentId, setHistoryAgentId] = useState<string | null>(null)
  /** Ignore pane-clear for a tick after node/edge select (RF can fire both). */
  const skipPaneClearRef = useRef(false)

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? ROOT_LAYER
  const openLayerIds = useMemo(
    () => new Set(layers.filter((l) => l.kind === 'team').map((l) => l.id)),
    [layers],
  )

  const openTeamLayer = useCallback(
    (teamId: string, fold = false) => {
      const team = normalized.teams.find((t) => t.id === teamId)
      if (!team) return
      const layerId = `team-layer:${teamId}`
      setLayers((prev) => {
        if (prev.some((l) => l.id === layerId)) return prev
        const depth = prev.filter((l) => l.kind === 'team').length + 1
        return [
          ...prev,
          {
            id: layerId,
            kind: 'team' as const,
            teamId,
            title: team.name,
            depth,
          },
        ]
      })
      setActiveLayerId(layerId)
      if (fold) {
        onChange(updateTeam(normalized, teamId, { collapsed: true }))
      }
      onSelect(`team:${teamId}`, 'team')
    },
    [normalized, onChange, onSelect],
  )

  const closeLayer = useCallback(
    (layerId: string) => {
      if (layerId === 'root') return
      setLayers((prev) => prev.filter((l) => l.id !== layerId))
      setActiveLayerId((cur) => (cur === layerId ? 'root' : cur))
    },
    [],
  )

  const key = structureKey(normalized, activeLayerId)

  useEffect(() => {
    const el = wrapperRef.current
    if (!el || !interactive) return
    const onWheel = (e: globalThis.WheelEvent) => {
      const rf = rfRef.current
      if (!rf) return
      e.preventDefault()
      e.stopPropagation()
      const bounds = el.getBoundingClientRect()
      const px = e.clientX - bounds.left
      const py = e.clientY - bounds.top
      const { x, y, zoom } = rf.getViewport()
      const factor = e.ctrlKey ? 10 : 1
      const delta =
        -e.deltaY * (e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002) * factor
      const nextZoom = Math.min(4, Math.max(0.08, zoom * Math.pow(2, delta)))
      if (Math.abs(nextZoom - zoom) < 1e-6) return
      const flowX = (px - x) / zoom
      const flowY = (py - y) / zoom
      rf.setViewport(
        { x: px - flowX * nextZoom, y: py - flowY * nextZoom, zoom: nextZoom },
        { duration: 0 },
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [interactive, activeLayerId])

  useEffect(() => {
    let g: { nodes: Node[]; edges: Edge[] }
    if (activeLayer.kind === 'root') {
      g = buildRootGraph(
        normalized,
        selectedId,
        interactive,
        openLayerIds,
        (teamId) => openTeamLayer(teamId, false),
        (teamId) => openTeamLayer(teamId, true),
        lastRun,
      )
    } else {
      g = buildTeamLayerGraph(
        normalized,
        activeLayer.teamId,
        selectedId,
        interactive,
        activeLayer.id,
        lastRun,
      )
    }
    setNodes(g.nodes)
    setEdges(
      g.edges.map((e) => ({
        ...e,
        selected: selectedId === e.id,
        className: selectedId === e.id ? 'edge-selected' : undefined,
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interactive, activeLayerId, openLayerIds, lastRun])

  useEffect(() => {
    requestAnimationFrame(() => {
      rfRef.current?.fitView({ padding: 0.28, duration: 220 })
    })
  }, [activeLayerId])

  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, selected: n.id === selectedId },
      })),
    )
    setEdges((eds) =>
      eds.map((e) => ({
        ...e,
        selected: selectedId === e.id,
        className: selectedId === e.id ? 'edge-selected' : undefined,
      })),
    )
  }, [selectedId, setNodes, setEdges])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => onNodesChangeInternal(changes),
    [onNodesChangeInternal],
  )

  const persistLayouts = useCallback(
    (list: Node[]) => {
      const updates: Record<string, { x: number; y: number }> = {}
      for (const n of list) {
        if (n.parentId) continue
        updates[layoutKey(activeLayerId, n.id)] = { x: n.position.x, y: n.position.y }
      }
      if (Object.keys(updates).length) {
        onChange(setManyLayouts(normalized, updates))
      }
    },
    [activeLayerId, normalized, onChange],
  )

  const closeMenu = () => setMenu(null)

  const runAction = (action: ContextAction) => {
    if (!menu) return
    const { target } = menu
    const select = (id: string, kind: SelectKind) => onSelect(id, kind)
    const teamCtx =
      activeLayer.kind === 'team'
        ? activeLayer.teamId
        : target.kind === 'team'
          ? target.id
          : null

    if (action === 'add-team') {
      const next = addTeam(normalized)
      onChange(next)
      const tid = next.teams[next.teams.length - 1]?.id
      if (tid) select(`team:${tid}`, 'team')
      return
    }
    if (action === 'add-agent' || action === 'add-member') {
      const next = addAgent(normalized, teamCtx)
      onChange(next)
      const aid = next.agents[next.agents.length - 1]?.id
      if (aid) select(`agent:${aid}`, 'agent')
      return
    }
    if (action === 'add-task') {
      const next = addTask(normalized)
      onChange(next)
      const tid = next.tasks[next.tasks.length - 1]?.id
      if (tid) select(`task:${tid}`, 'task')
      return
    }
    if (action === 'exclusive-task' && target.kind === 'agent') {
      const next = addTask(normalized, target.id)
      onChange(next)
      const tid = next.tasks[next.tasks.length - 1]?.id
      if (tid) select(`task:${tid}`, 'task')
      return
    }
    if (action === 'add-schedule') {
      if (target.kind === 'task') {
        const task = normalized.tasks.find((t) => t.id === target.id)
        onChange(
          updateTask(normalized, target.id, {
            schedule: task?.schedule?.enabled ? { ...task.schedule } : defaultSchedule(),
          }),
        )
        select(`task:${target.id}`, 'task')
        return
      }
      const agentId = target.kind === 'agent' ? target.id : undefined
      const next = addScheduledTask(normalized, agentId)
      onChange(next)
      const tid = next.tasks[next.tasks.length - 1]?.id
      if (tid) select(`task:${tid}`, 'task')
      return
    }
    if (action === 'edit') {
      if (target.kind === 'team') {
        select(`team:${target.id}`, 'team')
        openTeamLayer(target.id, false)
      }
      if (target.kind === 'agent') select(`agent:${target.id}`, 'agent')
      if (target.kind === 'task') select(`task:${target.id}`, 'task')
      if (target.kind === 'edge') select(target.id, 'edge')
      return
    }
    if (action === 'edge-uni' && target.kind === 'edge') {
      onChange(setEdgeDirection(normalized, target.id, 'uni'))
      select(target.id, 'edge')
      return
    }
    if (action === 'edge-bi' && target.kind === 'edge') {
      onChange(setEdgeDirection(normalized, target.id, 'bi'))
      select(target.id, 'edge')
      return
    }
    if (action === 'edge-reverse' && target.kind === 'edge') {
      onChange(toggleEdgeReversed(normalized, target.id))
      select(target.id, 'edge')
      return
    }
    if (action === 'delete') {
      if (target.kind === 'team') {
        closeLayer(`team-layer:${target.id}`)
        onChange(removeTeam(normalized, target.id))
      }
      if (target.kind === 'agent') onChange(removeAgent(normalized, target.id))
      if (target.kind === 'task') onChange(removeTask(normalized, target.id))
      onSelect(null, null)
      return
    }
    if (action === 'duplicate' && target.kind === 'agent') {
      onChange(duplicateAgent(normalized, target.id))
      return
    }
    if (action === 'duplicate-team' && target.kind === 'team') {
      onChange(duplicateTeam(normalized, target.id))
      return
    }
    if (action === 'toggle-collapse' && target.kind === 'team') {
      openTeamLayer(target.id, true)
      return
    }
    if (action === 'history' && target.kind === 'agent') {
      setHistoryAgentId(target.id)
    }
  }

  const historyAgent = normalized.agents.find((a) => a.id === historyAgentId) ?? null
  const layerDepth =
    activeLayer.kind === 'team' ? activeLayer.depth : 0

  return (
    <div className="crew-canvas layered" ref={wrapperRef} onClick={closeMenu}>
      <div className="canvas-layer-bar" onMouseDown={(e) => e.stopPropagation()}>
        <div className="canvas-layer-tabs">
          {layers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              className={`canvas-layer-tab ${layer.id === activeLayerId ? 'active' : ''}`}
              onClick={() => setActiveLayerId(layer.id)}
            >
              <span className="layer-depth">
                {layer.kind === 'root' ? 'L0' : `L${layer.kind === 'team' ? layer.depth : 1}`}
              </span>
              {layer.title}
              {layer.kind === 'team' && (
                <span
                  className="layer-close"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeLayer(layer.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') closeLayer(layer.id)
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>
        <p className="canvas-layer-hint">
          {activeLayer.kind === 'root'
            ? '总览：Team 折叠进子画布；可同时打开多层'
            : `第 ${layerDepth} 层 · ${activeLayer.title} 的 Agents / Tasks`}
        </p>
      </div>

      <div className="crew-canvas-stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={interactive ? onNodesChange : undefined}
          onEdgesChange={interactive ? onEdgesChange : undefined}
          fitView={false}
          nodesDraggable={interactive}
          nodesConnectable={false}
          elementsSelectable={interactive}
          edgesFocusable={interactive}
          panOnDrag={interactive}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          selectionOnDrag={false}
          preventScrolling
          noDragClassName="nodrag"
          noWheelClassName="nowheel"
          translateExtent={[
            [-20000, -20000],
            [20000, 20000],
          ]}
          minZoom={0.08}
          maxZoom={4}
          onInit={(instance) => {
            rfRef.current = instance
            instance.fitView({ padding: 0.28, duration: 200 })
          }}
          onNodeDragStop={(_, __, list) => {
            if (!interactive) return
            persistLayouts(list)
          }}
          onNodeDoubleClick={(_, node) => {
            if (!interactive) return
            if (node.id.startsWith('team:')) {
              openTeamLayer(node.id.slice(5), true)
            }
          }}
          onNodeClick={(e, node) => {
            if (!interactive) return
            e.stopPropagation()
            skipPaneClearRef.current = true
            window.setTimeout(() => {
              skipPaneClearRef.current = false
            }, 0)
            closeMenu()
            if (node.id.startsWith('team:')) onSelect(node.id, 'team')
            else if (node.id.startsWith('agent:')) onSelect(node.id, 'agent')
            else if (node.id.startsWith('task:')) onSelect(node.id, 'task')
            else if (node.id.startsWith('start:')) onSelect(node.id, 'start')
            else if (node.id.startsWith('gate-in:') || node.id.startsWith('gate-out:')) {
              const tid = node.id.split(':')[1]
              if (tid) onSelect(`team:${tid}`, 'team')
            }
          }}
          onEdgeClick={(e, edge) => {
            if (!interactive) return
            e.stopPropagation()
            if (edge.id.startsWith('exclusive-') || edge.id.startsWith('start-')) return
            skipPaneClearRef.current = true
            window.setTimeout(() => {
              skipPaneClearRef.current = false
            }, 0)
            closeMenu()
            onSelect(edge.id, 'edge')
          }}
          onPaneClick={() => {
            if (skipPaneClearRef.current) return
            onSelect(null, null)
            closeMenu()
          }}
          onEdgeContextMenu={(e, edge) => {
            if (!interactive || edge.id.startsWith('exclusive-')) return
            e.preventDefault()
            e.stopPropagation()
            const rect = wrapperRef.current?.getBoundingClientRect()
            setMenu({
              x: e.clientX - (rect?.left ?? 0),
              y: e.clientY - (rect?.top ?? 0),
              target: { kind: 'edge', id: edge.id },
            })
            onSelect(edge.id, 'edge')
          }}
          onNodeContextMenu={(e, node) => {
            if (!interactive) return
            e.preventDefault()
            e.stopPropagation()
            skipPaneClearRef.current = true
            window.setTimeout(() => {
              skipPaneClearRef.current = false
            }, 0)
            const rect = wrapperRef.current?.getBoundingClientRect()
            const x = e.clientX - (rect?.left ?? 0)
            const y = e.clientY - (rect?.top ?? 0)
            if (node.id.startsWith('team:')) {
              setMenu({ x, y, target: { kind: 'team', id: node.id.slice(5) } })
              onSelect(node.id, 'team')
            } else if (node.id.startsWith('agent:')) {
              setMenu({ x, y, target: { kind: 'agent', id: node.id.slice(6) } })
              onSelect(node.id, 'agent')
            } else if (node.id.startsWith('task:')) {
              setMenu({ x, y, target: { kind: 'task', id: node.id.slice(5) } })
              onSelect(node.id, 'task')
            } else if (node.id.startsWith('start:')) {
              onSelect(node.id, 'start')
            }
          }}
          onPaneContextMenu={(e) => {
            if (!interactive) return
            e.preventDefault()
            const rect = wrapperRef.current?.getBoundingClientRect()
            setMenu({
              x: e.clientX - (rect?.left ?? 0),
              y: e.clientY - (rect?.top ?? 0),
              target: { kind: 'pane' },
            })
          }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            id={`grid-${activeLayerId}`}
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1}
            color={activeLayer.kind === 'root' ? '#A1A1AA' : '#86efac'}
          />
          <Controls showInteractive={false} position="top-left" />
          <MiniMap
            key={`minimap-${activeLayerId}-${nodes.length}`}
            position="bottom-left"
            pannable
            zoomable
            nodeStrokeWidth={2}
            nodeBorderRadius={6}
            bgColor="#F4F4F5"
            maskColor="rgba(24, 24, 27, 0.14)"
            ariaLabel="画布缩略图"
            className="crew-minimap"
            style={{ width: 180, height: 120, margin: 12 }}
            nodeColor={(node) => {
              try {
                if (node.type === 'team') {
                  const d = node.data as TeamNodeData
                  return d?.color || TEAM_COLORS[0]
                }
                if (node.type === 'start') return START_COLOR
                if (node.type === 'team-gate') return '#6366f1'
                if (node.type === 'agent') return AGENT_COLOR
                if (node.type === 'task') {
                  const d = node.data as TaskNodeData
                  return d?.scheduled ? SCHEDULE_COLOR : TASK_COLOR
                }
              } catch {
                /* fall through */
              }
              return '#94a3b8'
            }}
            nodeStrokeColor="#64748b"
          />
        </ReactFlow>
      </div>

      {menu && (
        <CanvasContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.target}
          onAction={runAction}
          onClose={closeMenu}
        />
      )}

      <AgentHistoryModal
        open={!!historyAgentId}
        agent={historyAgent}
        lastRun={lastRun}
        onClose={() => setHistoryAgentId(null)}
      />
    </div>
  )
}
