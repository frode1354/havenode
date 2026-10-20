import { useEffect, useMemo, useRef, useState } from 'react'
import {
  RequestAbortedError,
  fetchTokenEstimate,
  resumeRun,
  runCrewAsync,
} from '../api'
import { buildRunDocCards, type MdDocCard } from '../mdUtils'
import type { CrewPlan, RunJob, RunResponse, TokenEstimate } from '../types'
import { ensureWorkflowPlan, runJobToResponse } from '../types'
import { CrewCanvas } from './CrewCanvas'
import { MarkdownReaderModal } from './MarkdownReaderModal'

type Props = {
  plan: CrewPlan
  initialRun?: RunResponse | null
  onRunFinished?: (result: RunResponse) => void
  onDeploy?: () => void
}

type LogTab = 'details' | 'messages' | 'raw'

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

export function ExecutionView({
  plan,
  initialRun = null,
  onRunFinished,
  onDeploy,
}: Props) {
  const normalized = useMemo(() => ensureWorkflowPlan(plan), [plan])
  const crewModules = useMemo(
    () => (normalized.modules || []).filter((m) => m.kind === 'crew'),
    [normalized.modules],
  )
  const defaultInputs = useMemo(() => {
    const map: Record<string, string> = {}
    for (const i of normalized.inputs) map[i.name] = i.example || ''
    return map
  }, [normalized.inputs])

  const [inputs, setInputs] = useState(defaultInputs)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [job, setJob] = useState<RunJob | null>(null)
  const [runResult, setRunResult] = useState<RunResponse | null>(initialRun)
  const [runError, setRunError] = useState<string | null>(null)
  const [logTab, setLogTab] = useState<LogTab>('details')
  const [activeDoc, setActiveDoc] = useState<MdDocCard | null>(null)
  const [moduleId, setModuleId] = useState<string>('')
  const [estimate, setEstimate] = useState<TokenEstimate | null>(null)
  const [hitlFeedback, setHitlFeedback] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setInputs(defaultInputs)
  }, [defaultInputs])

  useEffect(() => {
    setRunResult(initialRun)
    setRunError(initialRun && !initialRun.ok ? initialRun.error || '运行失败' : null)
  }, [initialRun, plan.name])

  useEffect(() => {
    let cancelled = false
    void fetchTokenEstimate(normalized)
      .then((est) => {
        if (!cancelled) setEstimate(est)
      })
      .catch(() => {
        if (!cancelled) setEstimate(null)
      })
    return () => {
      cancelled = true
    }
  }, [normalized])

  useEffect(() => {
    if (!running) return
    setElapsed(0)
    const id = window.setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const events = job?.events?.length
    ? job.events
    : runResult?.events?.length
      ? runResult.events
      : running
        ? ['正在启动…']
        : ['等待运行']

  const liveResult: RunResponse | null = job
    ? runJobToResponse(job)
    : runResult

  const waitingHuman = job?.status === 'waiting_human' || liveResult?.waiting_human

  const cards = useMemo(
    () => (liveResult?.ok ? buildRunDocCards(liveResult) : []),
    [liveResult],
  )

  const taskMessages = liveResult?.task_results ?? []
  const budget = normalized.run_policy?.token_budget_max
  const overBudget =
    estimate && budget != null ? estimate.total_max > budget : false

  async function handleRun() {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setRunError(null)
    setRunResult(null)
    setJob(null)
    setLogTab('details')
    try {
      const final = await runCrewAsync(normalized, inputs, {
        signal: ac.signal,
        onUpdate: (j) => setJob(j),
        moduleId: moduleId || null,
        subdagOnly: Boolean(moduleId),
      })
      if (ac.signal.aborted) return
      const asRun = runJobToResponse(final)
      setRunResult(asRun)
      setJob(final)
      if (final.status !== 'waiting_human') {
        onRunFinished?.(asRun)
      }
      if (!final.ok && final.status !== 'waiting_human') {
        setRunError(final.error || '运行失败')
      }
    } catch (e) {
      if (e instanceof RequestAbortedError) {
        setRunError('已取消运行')
        return
      }
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  async function handleResume(approved: boolean) {
    if (!job?.id) return
    setRunning(true)
    setRunError(null)
    try {
      let current = await resumeRun(job.id, {
        feedback: hitlFeedback,
        approved,
      })
      setJob(current)
      while (current.status === 'running') {
        await new Promise((r) => setTimeout(r, 1500))
        const { getRun } = await import('../api')
        current = await getRun(current.id)
        setJob(current)
      }
      const asRun = runJobToResponse(current)
      setRunResult(asRun)
      if (current.status !== 'waiting_human') onRunFinished?.(asRun)
      if (!current.ok && current.status !== 'waiting_human') {
        setRunError(current.error || '运行失败')
      }
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
    setRunning(false)
    setRunError('已取消本次运行（后台可能仍在跑；重启后端可彻底停止）')
  }

  return (
    <>
      <div className="execution-grid">
        <aside className="execution-side">
          <p className="eyebrow">LangGraph · Inputs</p>
          {normalized.start?.payload_format ? (
            <div className="start-payload-hint">
              <p className="eyebrow">开始 · 输入格式</p>
              <pre className="start-payload-pre">{normalized.start.payload_format}</pre>
              {normalized.start.payload_example ? (
                <pre className="start-payload-pre muted">{normalized.start.payload_example}</pre>
              ) : null}
            </div>
          ) : null}
          {normalized.inputs.length === 0 ? (
            <p className="muted small">无输入变量</p>
          ) : (
            normalized.inputs.map((spec) => (
              <label key={spec.name} className="field">
                <span>
                  {spec.name}
                  <em>{spec.description}</em>
                </span>
                <input
                  value={inputs[spec.name] ?? ''}
                  disabled={running}
                  onChange={(e) =>
                    setInputs((prev) => ({ ...prev, [spec.name]: e.target.value }))
                  }
                  placeholder={spec.example || spec.name}
                />
              </label>
            ))
          )}

          <label className="field">
            <span>
              运行范围
              <em>整图或单独回放某个 Crew 子 DAG</em>
            </span>
            <select
              value={moduleId}
              disabled={running}
              onChange={(e) => setModuleId(e.target.value)}
            >
              <option value="">整图 LangGraph</option>
              {crewModules.map((m) => (
                <option key={m.id} value={m.id}>
                  子 DAG · {m.label || m.id}
                </option>
              ))}
            </select>
          </label>

          {estimate && (
            <div className="token-estimate-box">
              <p className="eyebrow">Token 静态预估</p>
              <p className="muted small">
                上界 <strong>{estimate.total_max.toLocaleString()}</strong>
                {budget != null ? ` · 熔断 ${budget.toLocaleString()}` : ''}
                {overBudget ? ' · ⚠ 预估已超熔断' : ''}
              </p>
              <p className="muted small">{estimate.notes}</p>
            </div>
          )}

          {(liveResult?.tokens_used != null && liveResult.tokens_used > 0) && (
            <p className="muted small">
              已用 tokens≈{liveResult.tokens_used.toLocaleString()}
              {liveResult.circuit_broken ? ' · 已熔断' : ''}
            </p>
          )}

          {!running && !waitingHuman ? (
            <button type="button" className="primary wide" onClick={() => void handleRun()}>
              {moduleId ? '回放子 DAG' : '运行 LangGraph'}
            </button>
          ) : running ? (
            <button type="button" className="secondary wide" onClick={handleCancel}>
              取消（已等待 {formatElapsed(elapsed)}）
            </button>
          ) : null}

          {waitingHuman && job?.id && (
            <div className="hitl-panel">
              <p className="eyebrow">Human-in-the-loop</p>
              <p className="muted small">
                断点 · {job.interrupt_module_id || liveResult?.interrupt_module_id}
              </p>
              <textarea
                value={hitlFeedback}
                onChange={(e) => setHitlFeedback(e.target.value)}
                placeholder="人工反馈（可选）"
                rows={3}
              />
              <div className="hitl-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running}
                  onClick={() => void handleResume(true)}
                >
                  批准继续
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={running}
                  onClick={() => void handleResume(false)}
                >
                  拒绝停止
                </button>
              </div>
            </div>
          )}

          {liveResult?.ok && onDeploy && (
            <button
              type="button"
              className="secondary wide"
              disabled={running}
              onClick={onDeploy}
            >
              结果满意 → 部署到平台
            </button>
          )}

          <p className="eyebrow" style={{ marginTop: '0.85rem' }}>
            Event timeline
          </p>
          <ul className="sandbox-events execution-timeline">
            {events.map((ev, i) => (
              <li key={`${ev}-${i}`}>{ev}</li>
            ))}
          </ul>
          {running && (
            <p className="muted small">
              状态：running · {formatElapsed(elapsed)}
              <br />
              多 Task 串行通常需数分钟；时间线会随轮询更新。
            </p>
          )}
        </aside>

        <section className="execution-canvas">
          <p className="eyebrow">Canvas · I/O & tokens</p>
          <div className="execution-canvas-frame">
            <CrewCanvas
              plan={normalized}
              selectedId={null}
              onSelect={() => {}}
              onChange={() => {}}
              interactive={false}
              lastRun={
                liveResult
                  ? {
                      ...liveResult,
                      token_estimate: liveResult.token_estimate || estimate,
                    }
                  : estimate
                    ? {
                        ok: false,
                        result: '',
                        logs: '',
                        events: [],
                        task_results: [],
                        token_estimate: estimate,
                      }
                    : null
              }
            />
          </div>
        </section>

        <section className="execution-logs">
          <div className="execution-log-tabs" role="tablist">
            {(
              [
                ['details', '详情'],
                ['messages', '消息'],
                ['raw', '原始'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={logTab === id}
                className={logTab === id ? 'active' : ''}
                onClick={() => setLogTab(id)}
              >
                {label}
              </button>
            ))}
          </div>

          {runError && <div className="run-error-banner">{runError}</div>}

          {logTab === 'details' && (
            <div className="execution-log-pane">
              <ul className="sandbox-events">
                {events.map((ev, i) => (
                  <li key={`d-${ev}-${i}`}>{ev}</li>
                ))}
              </ul>
              {liveResult?.ok && liveResult.output_dir && (
                <div className="output-folder-banner">
                  <strong>输出目录</strong>
                  <code>{liveResult.output_dir}</code>
                </div>
              )}
              <div className="md-card-grid">
                {cards.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={`md-card kind-${card.kind}`}
                    onClick={() => setActiveDoc(card)}
                  >
                    <span className="md-card-badge">
                      {card.kind === 'final' ? 'Final' : 'Task'}
                    </span>
                    <span className="md-card-title">{card.title}</span>
                    <span className="md-card-preview">{card.preview}</span>
                  </button>
                ))}
              </div>
              {!running && cards.length === 0 && !runError && (
                <div className="sandbox-empty">运行完成后在此显示结果卡片</div>
              )}
            </div>
          )}

          {logTab === 'messages' && (
            <div className="execution-log-pane">
              {taskMessages.length === 0 ? (
                <div className="sandbox-empty">
                  {running ? '等待 Task 产出…' : '尚无 Task 消息'}
                </div>
              ) : (
                <ul className="execution-messages">
                  {taskMessages.map((tr) => (
                    <li key={tr.task_id}>
                      <strong>{tr.task_id}</strong>
                      {tr.agent ? (
                        <span className="muted small"> · {tr.agent}</span>
                      ) : null}
                      {tr.module_id ? (
                        <span className="muted small"> · mod {tr.module_id}</span>
                      ) : null}
                      {(tr.tokens_in || tr.tokens_out) ? (
                        <span className="muted small">
                          {' '}
                          · tok {tr.tokens_in ?? 0}→{tr.tokens_out ?? 0}
                        </span>
                      ) : null}
                      <pre>{tr.output.slice(0, 4000)}</pre>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {logTab === 'raw' && (
            <div className="execution-log-pane">
              <pre className="execution-raw">
                {liveResult?.logs ||
                  liveResult?.result ||
                  (running ? '收集日志中…' : '尚无原始日志')}
              </pre>
            </div>
          )}
        </section>
      </div>

      <MarkdownReaderModal doc={activeDoc} onClose={() => setActiveDoc(null)} />
    </>
  )
}
