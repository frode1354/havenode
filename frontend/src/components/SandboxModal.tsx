import { useEffect, useMemo, useRef, useState } from 'react'
import { RequestAbortedError, runCrew } from '../api'
import { buildRunDocCards, type MdDocCard } from '../mdUtils'
import type { CrewPlan, RunResponse } from '../types'
import { DeployPanel } from './DeployPanel'
import { MarkdownReaderModal } from './MarkdownReaderModal'

type Props = {
  open: boolean
  plan: CrewPlan
  initialRun?: RunResponse | null
  onClose: () => void
  onRunFinished?: (result: RunResponse) => void
}

export function SandboxModal({ open, plan, initialRun = null, onClose, onRunFinished }: Props) {
  const defaultInputs = useMemo(() => {
    const map: Record<string, string> = {}
    for (const i of plan.inputs) map[i.name] = i.example || ''
    return map
  }, [plan.inputs])
  const [inputs, setInputs] = useState(defaultInputs)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<RunResponse | null>(initialRun)
  const [runError, setRunError] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<MdDocCard | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!open) return
    setInputs(defaultInputs)
    setRunResult(initialRun)
    setRunError(initialRun && !initialRun.ok ? initialRun.error || '运行失败' : null)
  }, [open, defaultInputs, initialRun])

  useEffect(() => {
    if (!running) return
    setElapsed(0)
    const id = window.setInterval(() => setElapsed((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const cards = useMemo(
    () => (runResult?.ok ? buildRunDocCards(runResult) : []),
    [runResult],
  )

  if (!open) return null

  async function handleRun() {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setRunError(null)
    setRunResult(null)
    try {
      const res = await runCrew(plan, inputs, ac.signal)
      setRunResult(res)
      onRunFinished?.(res)
      if (!res.ok) setRunError(res.error || '运行失败')
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

  return (
    <>
      <div className="modal-backdrop sandbox-backdrop" role="dialog" aria-modal="true">
        <div className="sandbox-panel animate-in">
          <header className="sandbox-header">
            <div>
              <p className="eyebrow">Sandbox</p>
              <h2>{plan.title}</h2>
              <p className="muted">在沙箱中用 AI Agents 运行，结果以 Markdown 卡片展示</p>
            </div>
            <button type="button" className="ghost" onClick={onClose} disabled={running}>
              关闭
            </button>
          </header>

          <div className="sandbox-body">
            <aside className="sandbox-side">
              <p className="eyebrow">Inputs</p>
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
                      onChange={(e) =>
                        setInputs((prev) => ({ ...prev, [spec.name]: e.target.value }))
                      }
                      disabled={running}
                      placeholder={spec.example || spec.name}
                    />
                  </label>
                ))
              )}
              {!running ? (
                <button type="button" className="primary wide" onClick={() => void handleRun()}>
                  开始运行
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary wide"
                  onClick={() => {
                    abortRef.current?.abort()
                    setRunning(false)
                    setRunError('已取消运行')
                  }}
                >
                  取消（已等待 {elapsed}s）
                </button>
              )}
              {runResult?.ok && (
                <button
                  type="button"
                  className="secondary wide"
                  style={{ marginTop: '0.5rem' }}
                  disabled={running}
                  onClick={() => setDeployOpen(true)}
                >
                  结果满意 → 部署到平台
                </button>
              )}

              <p className="eyebrow" style={{ marginTop: '1rem' }}>
                Timeline
              </p>
              <ul className="sandbox-events">
                {(runResult?.events?.length
                  ? runResult.events
                  : running
                    ? ['沙箱启动中…']
                    : ['等待运行']
                ).map((ev, i) => (
                  <li key={`${ev}-${i}`}>{ev}</li>
                ))}
              </ul>
            </aside>

            <section className="sandbox-main">
              <p className="eyebrow">Markdown 文档卡片</p>
              {runResult?.ok && runResult.output_dir && (
                <div className="output-folder-banner">
                  <strong>已保存到专属文件夹</strong>
                  <code>{runResult.output_dir}</code>
                  {!!runResult.saved_files?.length && (
                    <ul>
                      {runResult.saved_files.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {runError && <div className="run-error-banner">{runError}</div>}
              {running && (
                <div className="sandbox-loading">
                  Agents 执行中… 已等待 {elapsed}s（多 Task 串行通常需数分钟）
                </div>
              )}
              {!running && cards.length === 0 && !runError && (
                <div className="sandbox-empty">
                  运行完成后，结果写入 backend/tmp/项目标题/，并在此显示 MD 卡片
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
                    <span className="md-card-badge">{card.kind === 'final' ? 'Final' : 'Task'}</span>
                    <span className="md-card-title">{card.title}</span>
                    <span className="md-card-preview">{card.preview}</span>
                    <span className="md-card-meta">{card.meta}</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      <MarkdownReaderModal doc={activeDoc} onClose={() => setActiveDoc(null)} />
      <DeployPanel open={deployOpen} plan={plan} onClose={() => setDeployOpen(false)} />
    </>
  )
}
