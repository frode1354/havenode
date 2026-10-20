import type {
  ChatMessage,
  ChatResponse,
  CrewPlan,
  ReviseResponse,
  RunJob,
  RunResponse,
} from './types'
import { activeApi, type StudioSettings } from './settings'

const BASE = ''

export async function healthCheck(): Promise<{
  ok: boolean
  model: string
  llm_configured: boolean
  provider?: string
  api_label?: string
}> {
  const res = await fetch(`${BASE}/api/health`)
  if (!res.ok) throw new Error('后端未启动')
  return res.json()
}

export class RequestAbortedError extends Error {
  constructor(message = '已取消') {
    super(message)
    this.name = 'RequestAbortedError'
  }
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === 'AbortError') ||
    (e instanceof Error && e.name === 'AbortError')
  )
}

export async function sendChat(
  messages: ChatMessage[],
  sessionId?: string | null,
  plan?: CrewPlan | null,
  forcePlan = false,
  signal?: AbortSignal,
): Promise<ChatResponse> {
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        messages,
        plan: plan ?? null,
        force_plan: forcePlan,
      }),
      signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const detail = err.detail
      const msg =
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
            ? detail.map((d: { msg?: string }) => d?.msg || String(d)).join('; ')
            : '对话失败'
      throw new Error(msg)
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw new RequestAbortedError()
    throw e
  }
}

export async function revisePlan(
  plan: CrewPlan,
  feedback: string,
  editedPlan?: CrewPlan | null,
  sessionId?: string | null,
  signal?: AbortSignal,
): Promise<ReviseResponse> {
  try {
    const res = await fetch(`${BASE}/api/plan/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        plan,
        feedback,
        edited_plan: editedPlan ?? null,
      }),
      signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      const detail = err.detail
      const msg =
        typeof detail === 'string'
          ? detail
          : Array.isArray(detail)
            ? detail.map((d: { msg?: string }) => d?.msg || String(d)).join('; ')
            : '修订失败'
      throw new Error(msg)
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw new RequestAbortedError()
    throw e
  }
}

export async function exportZip(
  plan: CrewPlan,
  opts?: { mode?: 'crew' | 'langgraph'; includeDockerfile?: boolean },
): Promise<Blob> {
  const res = await fetch(`${BASE}/api/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan,
      mode: opts?.mode ?? 'langgraph',
      include_dockerfile: opts?.includeDockerfile ?? true,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || '导出失败')
  }
  return res.blob()
}

export type WorkflowDocs = {
  mermaid: string
  markdown: string
  title: string
}

export async function fetchWorkflowDocs(plan: CrewPlan): Promise<WorkflowDocs> {
  const res = await fetch(`${BASE}/api/workflow/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '文档生成失败')
  }
  return res.json()
}

export async function fetchTokenEstimate(plan: CrewPlan): Promise<import('./types').TokenEstimate> {
  const res = await fetch(`${BASE}/api/workflow/token-estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : 'Token 预估失败')
  }
  return res.json()
}

export async function saveSubDag(
  plan: CrewPlan,
  teamId: string,
  opts?: { version?: string; title?: string },
): Promise<{ ok: boolean; subdag: { id: string; version: string; title: string } }> {
  const res = await fetch(`${BASE}/api/subdags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan,
      team_id: teamId,
      version: opts?.version ?? null,
      title: opts?.title ?? null,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '保存子 DAG 失败')
  }
  return res.json()
}

export async function listSubDags(): Promise<
  { id: string; title: string; version: string; team_id?: string; saved_at?: string }[]
> {
  const res = await fetch(`${BASE}/api/subdags`)
  if (!res.ok) throw new Error('读取子 DAG 库失败')
  const data = await res.json()
  return data.subdags || []
}

export async function resumeRun(
  runId: string,
  opts?: { feedback?: string; approved?: boolean; signal?: AbortSignal },
): Promise<RunJob> {
  const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      feedback: opts?.feedback ?? '',
      approved: opts?.approved ?? true,
    }),
    signal: opts?.signal,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '恢复运行失败')
  }
  return res.json()
}

export type OpenInClineResult = {
  ok: boolean
  opened: boolean
  workspace_dir: string
  package_dir?: string
  brief_path?: string
  editor?: string
  message?: string
}

export async function openInCline(plan: CrewPlan): Promise<OpenInClineResult> {
  const res = await fetch(`${BASE}/api/open-in-cline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '打开 Cline 失败')
  }
  return res.json()
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function runCrew(
  plan: CrewPlan,
  inputs: Record<string, string>,
  signal?: AbortSignal,
): Promise<RunResponse> {
  try {
    const res = await fetch(`${BASE}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, inputs }),
      signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(typeof err.detail === 'string' ? err.detail : '运行失败')
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) throw new RequestAbortedError('已取消运行')
    throw e
  }
}

export async function startRun(
  plan: CrewPlan,
  inputs: Record<string, string> = {},
  opts?: {
    deploymentId?: string | null
    signal?: AbortSignal
    moduleId?: string | null
    subdagOnly?: boolean
  },
): Promise<RunJob> {
  try {
    const res = await fetch(`${BASE}/api/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan,
        inputs,
        deployment_id: opts?.deploymentId ?? null,
        module_id: opts?.moduleId ?? null,
        subdag_only: opts?.subdagOnly ?? false,
      }),
      signal: opts?.signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(typeof err.detail === 'string' ? err.detail : '启动运行失败')
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || opts?.signal?.aborted) {
      throw new RequestAbortedError('已取消运行')
    }
    throw e
  }
}

export async function getRun(
  runId: string,
  signal?: AbortSignal,
): Promise<RunJob> {
  try {
    const res = await fetch(`${BASE}/api/runs/${encodeURIComponent(runId)}`, {
      signal,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(typeof err.detail === 'string' ? err.detail : '读取运行状态失败')
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || signal?.aborted) {
      throw new RequestAbortedError('已取消运行')
    }
    throw e
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError('已取消运行'))
      return
    }
    const t = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      window.clearTimeout(t)
      reject(new RequestAbortedError('已取消运行'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Start async run and poll until terminal status (ok/error/waiting_human). */
export async function runCrewAsync(
  plan: CrewPlan,
  inputs: Record<string, string>,
  opts?: {
    deploymentId?: string | null
    signal?: AbortSignal
    onUpdate?: (job: RunJob) => void
    pollMs?: number
    moduleId?: string | null
    subdagOnly?: boolean
  },
): Promise<RunJob> {
  const job = await startRun(plan, inputs, {
    deploymentId: opts?.deploymentId,
    signal: opts?.signal,
    moduleId: opts?.moduleId,
    subdagOnly: opts?.subdagOnly,
  })
  opts?.onUpdate?.(job)
  if (job.status !== 'running') return job

  const pollMs = opts?.pollMs ?? 1500
  let current = job
  while (current.status === 'running') {
    if (opts?.signal?.aborted) throw new RequestAbortedError('已取消运行')
    await sleep(pollMs, opts?.signal)
    current = await getRun(current.id, opts?.signal)
    opts?.onUpdate?.(current)
  }
  return current
}

export type DeploymentRecord = {
  id: string
  plan_name: string
  title: string
  package_dir: string
  status:
    | 'prepared'
    | 'local'
    | 'deploying'
    | 'online'
    | 'needs_login'
    | 'failed'
    | string
  amp_console_url: string
  deployment_url?: string | null
  deployment_id?: string | null
  message: string
  cli_log?: string
  plan?: CrewPlan | null
  last_run?: RunResponse | null
  run_count?: number
  created_at: string
  updated_at: string
}

export async function deployToAmp(
  plan: CrewPlan,
  push = true,
): Promise<{ ok: boolean; deployment: DeploymentRecord }> {
  const res = await fetch(`${BASE}/api/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan, push }),
  })
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        '部署接口未找到（404）。请重启后端 uvicorn（含 /api/deploy），然后刷新页面再试。',
      )
    }
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    const detail = err.detail
    throw new Error(
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? detail.map((d: { msg?: string }) => d?.msg || String(d)).join('; ')
          : '部署失败',
    )
  }
  return res.json()
}

export async function listDeployments(
  planName?: string,
): Promise<{ deployments: DeploymentRecord[]; amp_console: string }> {
  const q = planName ? `?plan_name=${encodeURIComponent(planName)}` : ''
  const res = await fetch(`${BASE}/api/deployments${q}`)
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        '部署记录接口未找到（404）。请重启后端 uvicorn，然后刷新页面。',
      )
    }
    throw new Error('无法读取部署记录')
  }
  return res.json()
}

export async function getDeployment(
  depId: string,
): Promise<{ ok: boolean; deployment: DeploymentRecord }> {
  const res = await fetch(`${BASE}/api/deployments/${encodeURIComponent(depId)}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '读取部署失败')
  }
  return res.json()
}

export async function runDeployment(
  depId: string,
  inputs: Record<string, string> = {},
  opts?: { plan?: CrewPlan | null; signal?: AbortSignal },
): Promise<RunResponse> {
  try {
    const res = await fetch(
      `${BASE}/api/deployments/${encodeURIComponent(depId)}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs, plan: opts?.plan ?? null }),
        signal: opts?.signal,
      },
    )
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }))
      throw new Error(typeof err.detail === 'string' ? err.detail : '本地运行失败')
    }
    return res.json()
  } catch (e) {
    if (isAbortError(e) || opts?.signal?.aborted) {
      throw new RequestAbortedError('已取消运行')
    }
    throw e
  }
}

export type ScheduleJob = {
  id: string
  plan_name: string
  title: string
  enabled: boolean
  mode: 'interval' | 'cron' | 'once' | string
  interval_minutes?: number | null
  cron?: string | null
  run_at?: string | null
  label?: string
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  run_count?: number
}

export async function listSchedules(): Promise<{
  jobs: ScheduleJob[]
  scheduler: { running: boolean; tick_seconds: number }
}> {
  const res = await fetch(`${BASE}/api/schedules`)
  if (!res.ok) throw new Error('无法读取定时任务')
  return res.json()
}

export async function upsertSchedule(
  plan: CrewPlan,
  inputs: Record<string, string> = {},
  opts?: {
    enabled?: boolean
    mode?: 'interval' | 'cron' | 'once'
    interval_minutes?: number
    cron?: string
    run_at?: string
    label?: string
    job_id?: string
  },
): Promise<{ ok: boolean; job: ScheduleJob }> {
  const res = await fetch(`${BASE}/api/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plan,
      inputs,
      enabled: opts?.enabled ?? true,
      mode: opts?.mode,
      interval_minutes: opts?.interval_minutes,
      cron: opts?.cron,
      run_at: opts?.run_at,
      label: opts?.label,
      job_id: opts?.job_id,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '创建定时失败')
  }
  return res.json()
}

export async function toggleSchedule(
  jobId: string,
  enabled: boolean,
): Promise<{ ok: boolean; job: ScheduleJob }> {
  const res = await fetch(`${BASE}/api/schedules/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '更新定时失败')
  }
  return res.json()
}

export async function runScheduleNow(jobId: string): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`${BASE}/api/schedules/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '触发失败')
  }
  return res.json()
}

export async function deleteSchedule(jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/schedules/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '删除失败')
  }
}

export async function fetchSettings(): Promise<StudioSettings> {
  const res = await fetch(`${BASE}/api/settings`)
  if (!res.ok) throw new Error('无法读取后端设置')
  const data = await res.json()
  return normalizeSettingsPayload(data)
}

export async function pushSettings(settings: StudioSettings): Promise<StudioSettings> {
  const body = {
    theme: settings.theme,
    activeApiId: settings.activeApiId,
    apis: settings.apis.map((a) => ({
      id: a.id,
      label: a.label,
      provider: a.provider,
      model: a.model,
      apiKey: a.apiKey,
      baseUrl: a.baseUrl,
    })),
    skills: settings.skills,
    tools: settings.tools,
    knowledge: settings.knowledge,
    editorCommand: settings.editorCommand || 'cursor',
  }
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(typeof err.detail === 'string' ? err.detail : '保存设置失败')
  }
  return normalizeSettingsPayload(await res.json())
}

function normalizeSettingsPayload(data: Record<string, unknown>): StudioSettings {
  const apisRaw = Array.isArray(data.apis) ? data.apis : []
  const apis = apisRaw.map((item, i) => {
    const a = item as Record<string, unknown>
    return {
      id: String(a.id || `api_${i}`),
      label: String(a.label || `API ${i + 1}`),
      provider: (a.provider as StudioSettings['apis'][0]['provider']) || 'deepseek',
      model: String(a.model || 'deepseek/deepseek-chat'),
      apiKey: String(a.api_key || a.apiKey || ''),
      baseUrl: String(a.base_url || a.baseUrl || ''),
    }
  })
  // legacy single model
  if (apis.length === 0 && data.model && typeof data.model === 'object') {
    const model = data.model as Record<string, unknown>
    apis.push({
      id: 'api_legacy',
      label: '默认',
      provider: (model.provider as StudioSettings['apis'][0]['provider']) || 'deepseek',
      model: String(model.model || 'deepseek/deepseek-chat'),
      apiKey: String(model.api_key || model.apiKey || ''),
      baseUrl: String(model.base_url || model.baseUrl || ''),
    })
  }
  const activeApiId = String(data.activeApiId || data.active_api_id || apis[0]?.id || '')
  const normalized: StudioSettings = {
    theme: (data.theme as StudioSettings['theme']) || 'light',
    activeApiId,
    apis,
    skills: (data.skills as StudioSettings['skills']) || [],
    tools: (data.tools as StudioSettings['tools']) || [],
    knowledge: (data.knowledge as StudioSettings['knowledge']) || [],
    editorCommand: String(data.editorCommand || data.editor_command || 'cursor'),
  }
  // ensure activeApi resolves
  void activeApi(normalized)
  return normalized
}
