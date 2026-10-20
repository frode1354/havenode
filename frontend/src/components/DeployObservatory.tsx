import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getDeployment,
  RequestAbortedError,
  runCrewAsync,
  type DeploymentRecord,
} from '../api'
import { buildRunDocCards, type MdDocCard } from '../mdUtils'
import type { CrewPlan, RunJob, RunResponse } from '../types'
import { ensurePlanTeams, runJobToResponse } from '../types'
import { CrewCanvas } from './CrewCanvas'
import { MarkdownReaderModal } from './MarkdownReaderModal'

type Props = {
  open: boolean
  deploymentId: string | null
  fallbackPlan: CrewPlan
  onClose: () => void
}

type LogTab = 'details' | 'messages' | 'raw'

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

export function DeployObservatory({
  open,
  deploymentId,
  fallbackPlan,
  onClose,
}: Props) {
  const [rec, setRec] = useState<DeploymentRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [job, setJob] = useState<RunJob | null>(null)
  const [runResult, setRunResult] = useState<RunResponse | null>(null)
  const [logTab, setLogTab] = useState<LogTab>('details')
  const [activeDoc, setActiveDoc] = useState<MdDocCard | null>(null)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)

  const plan = useMemo(() => {
    const raw = rec?.plan || fallbackPlan
    return ensurePlanTeams(raw)
  }, [rec?.plan, fallbackPlan])

  useEffect(() => {
    if (!open || !deploymentId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await getDeployment(deploymentId)
        if (cancelled) return
        setRec(res.deployment)
        const p = ensurePlanTeams(res.deployment.plan || fallbackPlan)
        const map: Record<string, string> = {}
        for (const i of p.inputs) map[i.name] = i.example || ''
        setInputs(map)
        if (res.deployment.last_run) {
          setRunResult(res.deployment.last_run as RunResponse)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, deploymentId, fallbackPlan])

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

  const liveResult: RunResponse | null = job ? runJobToResponse(job) : runResult
  const events = job?.events?.length
    ? job.events
    : runResult?.events?.length
      ? runResult.events
      : running
        ? ['正在启动…']
        : ['等待运行']

  const cards = useMemo(
    () => (liveResult?.ok ? buildRunDocCards(liveResult) : []),
    [liveResult],
  )

  const taskMessages = liveResult?.task_results ?? []

  if (!open || !deploymentId) return null

  async function handleRun() {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setError(null)
    setRunResult(null)
    setJob(null)
    setLogTab('details')
    try {
      const final = await runCrewAsync(plan, inputs, {
        deploymentId: deploymentId!,
        signal: ac.signal,
        onUpdate: (j) => setJob(j),
      })
      if (ac.signal.aborted) return
      const asRun = runJobToResponse(final)
      setRunResult(asRun)
      setJob(final)
      if (!final.ok) setError(final.error || '运行失败')
      try {
        const refreshed = await getDeployment(deploymentId!)
        setRec(refreshed.deployment)
      } catch {
        /* ignore */
      }
    } catch (e) {
      if (e instanceof RequestAbortedError) {
        setError('已取消本次运行（若后端仍在跑任务，重启后端可彻底停止）')
        return
      }
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  function handleCancel() {
    abortRef.current?.abort()
    setRunning(false)
    setError(
      '已取消请求。多 Agent 全链路可能需数分钟；若反复卡住请确认后端用 --reload-dir app 启动。',
    )
  }

  return (
    <>
      <div
        className="modal-backdrop observatory-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="本地观测台"
      >
        <div className="observatory-panel animate-in">
          <header className="sandbox-header">
            <div>
              <p className="eyebrow">Local Observatory</p>
              <h2>{plan.title || rec?.title || '本地观测台'}</h2>
              <p className="muted">
                异步执行 · 时间线与画布
                {rec?.package_dir ? (
                  <>
                    {' '}
                    · <code className="obs-code">{rec.package_dir}</code>
                  </>
                ) : null}
              </p>
            </div>
            <button type="button" className="ghost" onClick={onClose} disabled={running}>
              关闭
            </button>
          </header>

          {loading ? (
            <p className="muted" style={{ padding: '1rem' }}>
              加载部署…
            </p>
          ) : (
            <div className="execution-grid observatory-execution">
              <aside className="execution-side">
                <p className="eyebrow">框架</p>
                <ul className="obs-framework">
                  <li>
                    Agents <strong>{plan.agents.length}</strong>
                  </li>
                  <li>
                    Tasks <strong>{plan.tasks.length}</strong>
                  </li>
                  <li>
                    Teams <strong>{plan.teams.length}</strong>
                  </li>
                  <li>
                    已跑 <strong>{rec?.run_count ?? 0}</strong> 次
                  </li>
                </ul>

                <p className="eyebrow" style={{ marginTop: '0.75rem' }}>
                  Inputs
                </p>
                {plan.inputs.length === 0 ? (
                  <p className="muted small">无输入变量</p>
                ) : (
                  plan.inputs.map((spec) => (
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
                {!running ? (
                  <button
                    type="button"
                    className="primary wide"
                    onClick={() => void handleRun()}
                  >
                    手动跑服务
                  </button>
                ) : (
                  <button type="button" className="secondary wide" onClick={handleCancel}>
                    取消（已等待 {formatElapsed(elapsed)}）
                  </button>
                )}
                {error && <p className="schedule-msg err">{error}</p>}

                <p className="eyebrow" style={{ marginTop: '0.85rem' }}>
                  Event timeline
                </p>
                <ul className="sandbox-events execution-timeline">
                  {events.map((ev, i) => (
                    <li key={`${ev}-${i}`}>{ev}</li>
                  ))}
                </ul>
              </aside>

              <section className="execution-canvas">
                <p className="eyebrow">画布</p>
                <div className="execution-canvas-frame">
                  <CrewCanvas
                    plan={plan}
                    selectedId={null}
                    onSelect={() => {}}
                    onChange={() => {}}
                    interactive={false}
                    lastRun={liveResult}
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

                {logTab === 'details' && (
                  <div className="execution-log-pane">
                    {liveResult?.ok && liveResult.output_dir && (
                      <div className="output-folder-banner">
                        <strong>输出目录</strong>
                        <code>{liveResult.output_dir}</code>
                      </div>
                    )}
                    {!running && cards.length === 0 && !error && (
                      <div className="sandbox-empty">点「手动跑服务」后在此观看产出</div>
                    )}
                    {running && (
                      <div className="sandbox-loading">
                        Agents 执行中… {formatElapsed(elapsed)}
                        <br />
                        <span className="muted small">时间线随轮询更新，不会整页假死</span>
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
          )}
        </div>
      </div>
      <MarkdownReaderModal doc={activeDoc} onClose={() => setActiveDoc(null)} />
    </>
  )
}
