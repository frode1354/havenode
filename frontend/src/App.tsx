import { useEffect, useRef, useState } from 'react'
import {
  downloadBlob,
  exportZip,
  healthCheck,
  RequestAbortedError,
  revisePlan,
  sendChat,
} from './api'
import { ApproveModifyModal } from './components/ApproveModifyModal'
import { ChatPanel } from './components/ChatPanel'
import { ProjectHistory } from './components/ProjectHistory'
import { SettingsModal } from './components/SettingsModal'
import { StudioShell } from './components/StudioShell'
import {
  deleteProject,
  loadProjects,
  makeProjectId,
  upsertProject,
  type ProjectRecord,
} from './history'
import {
  activeApi,
  applyTheme,
  loadSettings,
  saveSettings,
  type StudioSettings,
} from './settings'
import {
  ensureQuestionOptions,
  formatInterviewContext,
  type InterviewAnswer,
} from './presetQuestions'
import type {
  ChatMessage,
  ClarifyingQuestion,
  CrewPlan,
  PipelineStage,
  RunResponse,
  StudioPhase,
} from './types'
import {
  applyServerTimings,
  ensurePlanTeams,
  normalizeClarifyingQuestions,
} from './types'
import './App.css'

function emptyWorkspace() {
  return {
    phase: 'chat' as StudioPhase,
    messages: [] as ChatMessage[],
    thoughts: [] as string[],
    sessionId: null as string | null,
    plan: null as CrewPlan | null,
    lastRun: null as RunResponse | null,
  }
}

export default function App() {
  const [projects, setProjects] = useState<ProjectRecord[]>(() => loadProjects())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [phase, setPhase] = useState<StudioPhase>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [thoughts, setThoughts] = useState<string[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [plan, setPlan] = useState<CrewPlan | null>(null)
  const [lastRun, setLastRun] = useState<RunResponse | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Agent-prepared question batch; UI asks one-by-one near composer */
  const [interviewQueue, setInterviewQueue] = useState<ClarifyingQuestion[]>([])
  const [interviewIndex, setInterviewIndex] = useState(0)
  const [interviewAnswers, setInterviewAnswers] = useState<InterviewAnswer[]>([])
  const [settings, setSettings] = useState<StudioSettings>(() => loadSettings())
  const [loading, setLoading] = useState(false)
  const [revising, setRevising] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [status, setStatus] = useState('检查后端…')
  const [error, setError] = useState<string | null>(null)
  const [pipelineStages, setPipelineStages] = useState<PipelineStage[]>([])
  const [autoOpenSandbox, setAutoOpenSandbox] = useState(false)
  const skipPersist = useRef(false)
  /** In-flight chat/revise; aborted on project switch / new / superseding send */
  const chatAbortRef = useRef<AbortController | null>(null)
  const reviseAbortRef = useRef<AbortController | null>(null)
  /** Bumped on workspace switch so stale responses are ignored */
  const workspaceEpochRef = useRef(0)

  function abortInFlight() {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
    reviseAbortRef.current?.abort()
    reviseAbortRef.current = null
  }

  function beginChatRequest(): { signal: AbortSignal; epoch: number } {
    chatAbortRef.current?.abort()
    const ac = new AbortController()
    chatAbortRef.current = ac
    return { signal: ac.signal, epoch: workspaceEpochRef.current }
  }

  function isStale(epoch: number, signal?: AbortSignal) {
    return signal?.aborted || epoch !== workspaceEpochRef.current
  }

  function clearInterview() {
    setInterviewQueue([])
    setInterviewIndex(0)
    setInterviewAnswers([])
  }

  function resetGenerationUi() {
    setLoading(false)
    setRevising(false)
    setPipelineStages([])
    setThoughts([])
    clearInterview()
  }

  /** Snapshot current workspace (incl. interview) so switching projects does not drop options. */
  function snapshotWorkspace(idHint?: string | null): ProjectRecord | null {
    const hasContent =
      messages.length > 0 || !!plan || interviewQueue.length > 0
    if (!hasContent) return null
    const id = idHint ?? activeId ?? makeProjectId()
    const prev = projects.find((p) => p.id === id)
    const title =
      plan?.title ||
      messages.find((m) => m.role === 'user')?.content.slice(0, 36) ||
      '未命名项目'
    const summary =
      plan?.summary || messages.find((m) => m.role === 'user')?.content || ''
    return {
      id,
      title,
      summary,
      updatedAt: new Date().toISOString(),
      // Keep prior conversation time on switch/flush — upsert only bumps on chat changes
      conversationAt: prev?.conversationAt || prev?.updatedAt,
      phase,
      sessionId,
      messages,
      thoughts,
      plan,
      lastRun,
      interviewQueue,
      interviewIndex,
      interviewAnswers,
      pipelineStages,
    }
  }

  function flushWorkspace(idHint?: string | null): ProjectRecord[] {
    const snap = snapshotWorkspace(idHint)
    if (!snap) return projects
    const next = upsertProject(projects, snap)
    setProjects(next)
    if (!activeId) setActiveId(snap.id)
    return next
  }

  function beginStages(
    defs: { id: string; label: string; detail?: string; userWait?: boolean }[],
  ) {
    const now = Date.now()
    setPipelineStages(
      defs.map((d, i) => ({
        id: d.id,
        label: d.label,
        detail: d.detail,
        userWait: d.userWait,
        status: i === 0 ? 'running' : 'pending',
        startedAt: i === 0 && !d.userWait ? now : undefined,
      })),
    )
  }

  function markStageDone(id: string, detail?: string, durationMs?: number) {
    const now = Date.now()
    setPipelineStages((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        if (s.userWait) {
          return {
            ...s,
            status: 'done',
            detail: detail ?? s.detail,
            endedAt: now,
            durationMs: undefined,
            startedAt: undefined,
          }
        }
        const elapsed =
          durationMs ??
          (s.startedAt != null ? now - s.startedAt : s.durationMs)
        return {
          ...s,
          status: 'done',
          detail: detail ?? s.detail,
          endedAt: now,
          durationMs: elapsed,
        }
      }),
    )
  }

  function markStageWaiting(id: string, detail?: string) {
    setPipelineStages((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              status: 'waiting',
              userWait: true,
              detail: detail ?? s.detail,
              startedAt: undefined,
              endedAt: undefined,
              durationMs: undefined,
            }
          : s,
      ),
    )
  }

  function finishStagesWithServer(
    timings: { id?: string; label: string; duration_ms: number; detail?: string }[] | undefined,
  ) {
    setPipelineStages((prev) => {
      let next = applyServerTimings(prev, timings)
      if (!timings?.length) return next
      const have = new Set(next.map((s) => s.id))
      const extras = timings.filter(
        (t) =>
          !!t.id &&
          !have.has(t.id) &&
          t.id !== 'clarify' &&
          t.id !== 'interview',
      )
      if (extras.length) {
        const now = Date.now()
        next = [
          ...next,
          ...extras.map((t) => ({
            id: t.id!,
            label: t.label,
            status: 'done' as const,
            detail: t.detail,
            durationMs: t.duration_ms,
            endedAt: now,
          })),
        ]
      }
      return next
    })
  }

  const inInterview =
    phase === 'chat' && !plan && !loading && interviewQueue.length > 0
  const currentInterview =
    inInterview && interviewIndex < interviewQueue.length
      ? (interviewQueue[interviewIndex] ?? null)
      : null

  useEffect(() => {
    applyTheme(settings.theme)
  }, [settings.theme])

  useEffect(() => {
    healthCheck()
      .then((h) => {
        const api = activeApi(settings)
        setStatus(
          h.llm_configured
            ? `已连接 · ${h.api_label || api.label} · ${h.model}`
            : '后端在线，请在设置中配置模型 API Key',
        )
      })
      .catch(() => setStatus('后端未连接（请先启动 uvicorn）'))
  }, [settings.activeApiId, settings.apis])

  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false
      return
    }
    const hasContent =
      messages.length > 0 || !!plan || interviewQueue.length > 0
    if (!hasContent) return

    const id = activeId ?? makeProjectId()
    if (!activeId) setActiveId(id)

    const title =
      plan?.title ||
      messages.find((m) => m.role === 'user')?.content.slice(0, 36) ||
      '未命名项目'
    const summary = plan?.summary || messages.find((m) => m.role === 'user')?.content || ''

    setProjects((prev) => {
      const existing = prev.find((p) => p.id === id)
      const record: ProjectRecord = {
        id,
        title,
        summary,
        updatedAt: new Date().toISOString(),
        conversationAt: existing?.conversationAt || existing?.updatedAt,
        phase,
        sessionId,
        messages,
        thoughts,
        plan,
        lastRun,
        interviewQueue,
        interviewIndex,
        interviewAnswers,
        pipelineStages,
      }
      return upsertProject(prev, record)
    })
  }, [
    activeId,
    phase,
    messages,
    thoughts,
    sessionId,
    plan,
    lastRun,
    interviewQueue,
    interviewIndex,
    interviewAnswers,
    pipelineStages,
  ])

  function applyRecord(record: ProjectRecord) {
    abortInFlight()
    workspaceEpochRef.current += 1
    skipPersist.current = true
    setLoading(false)
    setRevising(false)
    setActiveId(record.id)
    setPhase(record.phase)
    setMessages(record.messages)
    setThoughts(record.thoughts)
    setSessionId(record.sessionId)
    setPlan(record.plan ? ensurePlanTeams(record.plan) : null)
    setLastRun(record.lastRun ?? null)
    setReviewOpen(record.phase === 'review' && !!record.plan)
    setWorkflowOpen(false)
    setAutoOpenSandbox(false)
    // Restore clarifying options — do not wipe interview on switch
    const queue = (record.interviewQueue ?? []).map(ensureQuestionOptions)
    setInterviewQueue(queue)
    setInterviewIndex(
      Math.min(record.interviewIndex ?? 0, Math.max(0, queue.length - 1)),
    )
    setInterviewAnswers(record.interviewAnswers ?? [])
    setPipelineStages(record.pipelineStages ?? [])
    setError(null)
  }

  function handleNewProject() {
    flushWorkspace(activeId)
    abortInFlight()
    workspaceEpochRef.current += 1
    skipPersist.current = true
    setActiveId(null)
    const empty = emptyWorkspace()
    setPhase(empty.phase)
    setMessages(empty.messages)
    setThoughts(empty.thoughts)
    setSessionId(empty.sessionId)
    setPlan(empty.plan)
    setLastRun(empty.lastRun)
    setReviewOpen(false)
    setWorkflowOpen(false)
    setAutoOpenSandbox(false)
    resetGenerationUi()
    setError(null)
  }

  async function finishInterviewAndPlan(answers: InterviewAnswer[]) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const goal = lastUser?.content ?? ''
    const enriched = formatInterviewContext(goal, answers)
    const apiMessages: ChatMessage[] = messages.map((m, i, arr) => {
      const isLastUser =
        m.role === 'user' && i === arr.map((x) => x.role).lastIndexOf('user')
      return isLastUser ? { ...m, content: enriched } : m
    })
    const { signal, epoch } = beginChatRequest()
    setThoughts(['正在根据澄清结果生成计划…'])
    setLoading(true)
    setError(null)
    clearInterview()
    {
      const now = Date.now()
      setPipelineStages((prev) => {
        const clarify = prev.find((s) => s.id === 'clarify')
        return [
          clarify
            ? { ...clarify, status: 'done' as const }
            : {
                id: 'clarify',
                label: '整理问题',
                status: 'done' as const,
                endedAt: now,
              },
          {
            id: 'interview',
            label: '逐题确认',
            status: 'done' as const,
            userWait: true,
            detail: answers.length ? `已答 ${answers.length}` : '已跳过',
            endedAt: now,
            durationMs: undefined,
          },
          {
            id: 'scan_agents',
            label: '代理仓库',
            status: 'running' as const,
            detail: '查找可复用代理',
            startedAt: now,
          },
          {
            id: 'check_tools',
            label: '检查工具',
            status: 'pending' as const,
            detail: '工具就绪',
          },
          {
            id: 'gen_plan',
            label: '生成计划',
            status: 'pending' as const,
            detail: '创建 Agent / Task',
          },
          {
            id: 'validate',
            label: '校验工作流',
            status: 'pending' as const,
            detail: '结构与工具',
          },
        ]
      })
    }
    try {
      const res = await sendChat(apiMessages, sessionId, plan, true, signal)
      if (isStale(epoch, signal)) return
      setSessionId(res.session_id)
      setThoughts(res.thoughts)
      finishStagesWithServer(res.stage_timings)
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: res.assistant_message },
      ])
      if (res.plan) {
        setPlan(ensurePlanTeams(res.plan))
        setReviewOpen(true)
        setPhase('review')
      }
    } catch (e) {
      if (e instanceof RequestAbortedError || isStale(epoch, signal)) return
      setPipelineStages((prev) =>
        prev.map((s) =>
          s.status === 'running' || s.status === 'pending'
            ? { ...s, status: 'error', detail: '失败' }
            : s,
        ),
      )
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!isStale(epoch)) setLoading(false)
    }
  }

  function advanceInterview(value?: string) {
    const q = interviewQueue[interviewIndex]
    let nextAnswers = interviewAnswers
    if (q && value) {
      nextAnswers = [
        ...interviewAnswers.filter((a) => a.id !== q.id),
        { id: q.id, prompt: q.prompt, value },
      ]
      setInterviewAnswers(nextAnswers)
    }
    if (interviewIndex + 1 >= interviewQueue.length) {
      markStageDone(
        'interview',
        `已答 ${nextAnswers.length}/${interviewQueue.length}`,
      )
      void finishInterviewAndPlan(nextAnswers)
      return
    }
    const next = interviewIndex + 1
    setInterviewIndex(next)
    markStageWaiting('interview', `第 ${next + 1}/${interviewQueue.length} 题`)
  }

  function skipInterview() {
    markStageDone('interview', '已跳过')
    void finishInterviewAndPlan(interviewAnswers)
  }

  function handleSelectProject(id: string) {
    if (id === activeId) return
    // Persist outgoing project (with interview options) before switching
    const list = flushWorkspace(activeId)
    const record = list.find((p) => p.id === id) ?? projects.find((p) => p.id === id)
    if (record) applyRecord(record)
  }

  function handleDeleteProject(id: string) {
    if (activeId === id) {
      flushWorkspace(activeId)
    }
    setProjects((prev) => deleteProject(prev, id))
    if (activeId === id) {
      abortInFlight()
      workspaceEpochRef.current += 1
      skipPersist.current = true
      setActiveId(null)
      const empty = emptyWorkspace()
      setPhase(empty.phase)
      setMessages(empty.messages)
      setThoughts(empty.thoughts)
      setSessionId(empty.sessionId)
      setPlan(empty.plan)
      setLastRun(empty.lastRun)
      setReviewOpen(false)
      setWorkflowOpen(false)
      setAutoOpenSandbox(false)
      resetGenerationUi()
      setError(null)
    }
  }

  async function handleSend(text: string) {
    setError(null)
    if (currentInterview) {
      advanceInterview(text.trim())
      return
    }
    clearInterview()
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: 'user', content: text.trim() },
    ]
    setMessages(nextMessages)
    const { signal, epoch } = beginChatRequest()
    setThoughts(['正在整理需要确认的问题…'])
    setLoading(true)
    beginStages([
      { id: 'clarify', label: '整理问题', detail: '澄清问题' },
      { id: 'interview', label: '逐题确认', detail: '待开始', userWait: true },
      { id: 'gen_plan', label: '生成计划', detail: '待开始' },
    ])
    try {
      const res = await sendChat(nextMessages, sessionId, plan, false, signal)
      if (isStale(epoch, signal)) return
      setSessionId(res.session_id)
      setThoughts(res.thoughts)
      finishStagesWithServer(res.stage_timings)
      setMessages([
        ...nextMessages,
        { role: 'assistant', content: res.assistant_message },
      ])
      let questions = normalizeClarifyingQuestions(res.clarifying_questions).map(
        ensureQuestionOptions,
      )
      // Backend/model said clarify but sent no usable questions — keep UI unblocked
      if (!res.plan && !res.ready_for_plan && questions.length === 0) {
        questions = [
          ensureQuestionOptions({
            id: 'q1',
            prompt: '还需要确认哪些关键约束？（可跳过直接生成）',
            options: [],
            allow_custom: true,
          }),
        ]
      }
      if (res.plan) {
        markStageDone('interview', '已跳过')
        markStageDone('gen_plan', '已完成')
        setPlan(ensurePlanTeams(res.plan))
        setReviewOpen(true)
        setPhase('review')
        return
      }
      if (questions.length > 0) {
        const now = Date.now()
        const modelMs = res.stage_timings?.find(
          (t) => t.id === 'clarify' || t.label === '整理问题',
        )?.duration_ms
        setPipelineStages((prev) => {
          const clarify = prev.find((s) => s.id === 'clarify')
          const wallMs =
            clarify?.startedAt != null
              ? now - clarify.startedAt
              : clarify?.durationMs
          const detail = [
            `${questions.length} 题`,
            modelMs != null && modelMs > 0
              ? `模型 ${modelMs < 1000 ? `${modelMs}ms` : `${(modelMs / 1000).toFixed(1)}s`}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')
          return [
            {
              id: 'clarify',
              label: '整理问题',
              status: 'done' as const,
              detail,
              startedAt: clarify?.startedAt,
              endedAt: now,
              durationMs: wallMs,
            },
            {
              id: 'interview',
              label: '逐题确认',
              status: 'waiting' as const,
              userWait: true,
              detail: `第 1/${questions.length} 题`,
            },
            {
              id: 'gen_plan',
              label: '生成计划',
              status: 'pending' as const,
              detail: '待开始',
            },
          ]
        })
        setInterviewQueue(questions)
        setInterviewIndex(0)
        setInterviewAnswers([])
        return
      }
      if (res.ready_for_plan && !res.plan) {
        markStageDone('interview', '无需澄清')
        beginStages([
          { id: 'scan_agents', label: '代理仓库', detail: '查找可复用代理' },
          { id: 'check_tools', label: '检查工具', detail: '工具就绪' },
          { id: 'gen_plan', label: '生成计划', detail: '创建 Agent / Task' },
          { id: 'validate', label: '校验工作流', detail: '结构与工具' },
        ])
        setThoughts(['正在扫描代理仓库与工具，并生成计划…'])
        const planRes = await sendChat(
          nextMessages,
          res.session_id,
          plan,
          true,
          signal,
        )
        if (isStale(epoch, signal)) return
        setThoughts(planRes.thoughts)
        finishStagesWithServer([
          ...(res.stage_timings || []),
          ...(planRes.stage_timings || []),
        ])
        if (planRes.plan) {
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: planRes.assistant_message },
          ])
          setPlan(ensurePlanTeams(planRes.plan))
          setReviewOpen(true)
          setPhase('review')
        }
      }
    } catch (e) {
      if (e instanceof RequestAbortedError || isStale(epoch, signal)) return
      setPipelineStages((prev) =>
        prev.map((s) =>
          s.status === 'running' || s.status === 'pending'
            ? { ...s, status: 'error', detail: '失败' }
            : s,
        ),
      )
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!isStale(epoch)) setLoading(false)
    }
  }

  async function handleRevise(edited: CrewPlan, feedback: string) {
    reviseAbortRef.current?.abort()
    const ac = new AbortController()
    reviseAbortRef.current = ac
    const epoch = workspaceEpochRef.current
    setRevising(true)
    setError(null)
    try {
      const res = await revisePlan(
        plan ?? edited,
        feedback,
        edited,
        sessionId,
        ac.signal,
      )
      if (isStale(epoch, ac.signal)) return
      setSessionId(res.session_id)
      setPlan(ensurePlanTeams(res.plan))
      setThoughts(res.thoughts)
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: `修改请求：${feedback}` },
        { role: 'assistant', content: res.assistant_message },
      ])
    } catch (e) {
      if (e instanceof RequestAbortedError || isStale(epoch, ac.signal)) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (!isStale(epoch)) setRevising(false)
    }
  }

  function handleApprove(approved: CrewPlan) {
    setPlan(ensurePlanTeams(approved))
    setReviewOpen(false)
    setPhase('editor')
    setAutoOpenSandbox(false)
    setWorkflowOpen(true)
  }

  function handleApproveAndRun(approved: CrewPlan) {
    setPlan(ensurePlanTeams(approved))
    setReviewOpen(false)
    setPhase('editor')
    setAutoOpenSandbox(true)
    setWorkflowOpen(true)
  }

  async function handleExport() {
    if (!plan) return
    setExporting(true)
    setError(null)
    try {
      const blob = await exportZip(plan, { mode: 'langgraph', includeDockerfile: true })
      downloadBlob(blob, `${plan.name}-langgraph.zip`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="app-root">
      <div className="atmosphere" aria-hidden />
      <header className="app-bar">
        <div className="app-bar-brand">
          <span className="logo-mark" />
          <span>Crew Studio</span>
        </div>
        <div className="app-bar-actions">
          {plan ? (
            <button
              type="button"
              className="secondary compact"
              onClick={() => {
                setPhase('editor')
                setWorkflowOpen(true)
              }}
            >
              打开工作流
            </button>
          ) : null}
          <button type="button" className="ghost compact" onClick={() => setSettingsOpen(true)}>
            设置
          </button>
          <span className="status-pill">{status}</span>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span className="error-banner-text">{error}</span>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setError(null)
              setLoading(false)
              setRevising(false)
              setPipelineStages((prev) =>
                prev.some((s) => s.status === 'error') ? [] : prev,
              )
            }}
          >
            关闭并继续
          </button>
        </div>
      )}

      <div className="workspace">
        <ProjectHistory
          projects={projects}
          activeId={activeId}
          onSelect={handleSelectProject}
          onNew={handleNewProject}
          onDelete={handleDeleteProject}
        />

        <main className="app-main focus">
          <ChatPanel
            messages={messages}
            thoughts={phase === 'chat' || phase === 'editor' ? thoughts : []}
            loading={loading}
            onSend={handleSend}
            brandHero={messages.length === 0 && phase === 'chat'}
            workflowTitle={plan ? plan.title : null}
            onOpenWorkflow={() => {
              setPhase('editor')
              setWorkflowOpen(true)
            }}
            presetQuestion={currentInterview}
            presetIndex={interviewIndex}
            presetTotal={interviewQueue.length}
            onPickPreset={(opt) => advanceInterview(opt)}
            onSkipPreset={skipInterview}
            stages={pipelineStages}
          />
        </main>
      </div>

      <ApproveModifyModal
        open={reviewOpen && !!plan}
        plan={plan}
        loading={revising}
        onClose={() => {
          setReviewOpen(false)
          if (phase !== 'editor') setPhase('chat')
        }}
        onApprove={handleApprove}
        onApproveAndRun={handleApproveAndRun}
        onRevise={handleRevise}
      />

      {plan && (
        <StudioShell
          open={workflowOpen}
          plan={plan}
          thoughts={thoughts}
          onChange={setPlan}
          onExport={handleExport}
          onReopenReview={() => {
            setWorkflowOpen(false)
            setReviewOpen(true)
          }}
          onClose={() => {
            setWorkflowOpen(false)
            setAutoOpenSandbox(false)
          }}
          exporting={exporting}
          onRunFinished={setLastRun}
          initialRun={lastRun}
          autoOpenSandbox={autoOpenSandbox}
        />
      )}

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onClose={() => {
          applyTheme(settings.theme)
          setSettingsOpen(false)
        }}
        onSave={(next) => {
          saveSettings(next)
          setSettings(next)
          applyTheme(next.theme)
        }}
      />
    </div>
  )
}
