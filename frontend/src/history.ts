import type {
  ChatMessage,
  ClarifyingQuestion,
  CrewPlan,
  PipelineStage,
  RunResponse,
  StudioPhase,
} from './types'

const STORAGE_KEY = 'crew-studio.projects.v1'

export type InterviewAnswerRecord = {
  id: string
  prompt: string
  value: string
}

export type ProjectRecord = {
  id: string
  title: string
  summary: string
  updatedAt: string
  /** Last chat activity (message / plan). Used for list order — not bumped on switch/flush. */
  conversationAt?: string
  phase: StudioPhase
  sessionId: string | null
  messages: ChatMessage[]
  thoughts: string[]
  plan: CrewPlan | null
  lastRun?: RunResponse | null
  /** In-progress clarifying interview — must survive project switches */
  interviewQueue?: ClarifyingQuestion[]
  interviewIndex?: number
  interviewAnswers?: InterviewAnswerRecord[]
  pipelineStages?: PipelineStage[]
}

export function conversationTime(p: ProjectRecord): number {
  const iso = p.conversationAt || p.updatedAt
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : 0
}

export function sortProjectsByConversation(projects: ProjectRecord[]): ProjectRecord[] {
  return [...projects].sort((a, b) => conversationTime(b) - conversationTime(a))
}

/** True when chat content changed (not interview-only / metadata flush). */
export function chatActivityChanged(
  prev: ProjectRecord | undefined,
  next: Pick<ProjectRecord, 'messages' | 'plan'>,
): boolean {
  if (!prev) return true
  if (prev.messages.length !== next.messages.length) return true
  const a = prev.messages.at(-1)
  const b = next.messages.at(-1)
  if ((a?.role ?? '') !== (b?.role ?? '')) return true
  if ((a?.content ?? '') !== (b?.content ?? '')) return true
  if (!!prev.plan !== !!next.plan) return true
  if ((prev.plan?.name ?? '') !== (next.plan?.name ?? '')) return true
  return false
}

export function loadProjects(): ProjectRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ProjectRecord[]
    if (!Array.isArray(parsed)) return []
    return sortProjectsByConversation(parsed)
  } catch {
    return []
  }
}

export function saveProjects(projects: ProjectRecord[]) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(sortProjectsByConversation(projects).slice(0, 50)),
  )
}

export function upsertProject(
  projects: ProjectRecord[],
  record: ProjectRecord,
): ProjectRecord[] {
  const prev = projects.find((p) => p.id === record.id)
  const now = new Date().toISOString()
  const conversationAt = chatActivityChanged(prev, record)
    ? now
    : record.conversationAt || prev?.conversationAt || prev?.updatedAt || now
  const merged: ProjectRecord = {
    ...record,
    conversationAt,
    updatedAt: record.updatedAt || now,
  }
  const next = sortProjectsByConversation([
    merged,
    ...projects.filter((p) => p.id !== record.id),
  ])
  saveProjects(next)
  return next
}

export function deleteProject(projects: ProjectRecord[], id: string): ProjectRecord[] {
  const next = sortProjectsByConversation(projects.filter((p) => p.id !== id))
  saveProjects(next)
  return next
}

export function makeProjectId(): string {
  return `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function formatUpdatedAt(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    if (sameDay) {
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    }
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}
