import { useEffect, useState } from 'react'
import { fetchWorkflowDocs, saveSubDag } from '../api'
import type { CrewPlan, RunResponse, SelectKind } from '../types'
import { ensureWorkflowPlan } from '../types'
import { addAgent, addClineAgent, addScheduledTask, addTask, addTeam, isClineAgent } from '../planUtils'
import { CrewCanvas } from './CrewCanvas'
import { DeployPanel } from './DeployPanel'
import { ExecutionView } from './ExecutionView'
import { MarkdownReaderModal } from './MarkdownReaderModal'
import { NodeInspector } from './NodeInspector'
import { SchedulePanel } from './SchedulePanel'
import type { MdDocCard } from '../mdUtils'

type StudioView = 'design' | 'execution'

type Props = {
  open: boolean
  plan: CrewPlan
  thoughts: string[]
  onChange: (plan: CrewPlan) => void
  onExport: () => void
  onReopenReview: () => void
  onClose: () => void
  exporting?: boolean
  initialRun?: RunResponse | null
  onRunFinished?: (result: RunResponse) => void
  /** Switch to Execution view when shell opens (e.g. 批准并运行) */
  autoOpenSandbox?: boolean
}

export function StudioShell({
  open,
  plan,
  thoughts,
  onChange,
  onExport,
  onReopenReview,
  onClose,
  exporting,
  initialRun = null,
  onRunFinished,
  autoOpenSandbox = false,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<SelectKind>(null)
  const [view, setView] = useState<StudioView>('design')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [deployOpen, setDeployOpen] = useState(false)
  const [lastRun, setLastRun] = useState<RunResponse | null>(initialRun)
  const [docsBusy, setDocsBusy] = useState(false)
  const [subdagBusy, setSubdagBusy] = useState(false)
  const [activeDoc, setActiveDoc] = useState<MdDocCard | null>(null)
  const [shellMsg, setShellMsg] = useState<string | null>(null)
  const normalized = ensureWorkflowPlan(plan)

  useEffect(() => {
    setLastRun(initialRun ?? null)
  }, [initialRun, plan.name])

  useEffect(() => {
    if (open && autoOpenSandbox) setView('execution')
  }, [open, autoOpenSandbox, plan.name])

  useEffect(() => {
    if (!open) setView('design')
  }, [open])

  if (!open) return null

  const scheduledCount = normalized.tasks.filter((t) => t.schedule?.enabled).length
  const hasCline = normalized.agents.some((a) => isClineAgent(a))
  const moduleCount = (normalized.modules || []).filter((m) => m.kind === 'crew').length
  const selectedTeamId =
    selectedKind === 'team' && selectedId?.startsWith('team:')
      ? selectedId.slice('team:'.length)
      : null

  async function handleDocs() {
    setDocsBusy(true)
    setShellMsg(null)
    try {
      const docs = await fetchWorkflowDocs(normalized)
      setActiveDoc({
        id: 'workflow-docs',
        title: docs.title || '工作流文档',
        kind: 'final',
        preview: docs.markdown.slice(0, 120),
        markdown: docs.markdown,
      })
    } catch (e) {
      setShellMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setDocsBusy(false)
    }
  }

  async function handleSaveSubDag() {
    if (!selectedTeamId) {
      setShellMsg('请先在画布选中一个 Crew 子 DAG（Team）')
      return
    }
    setSubdagBusy(true)
    setShellMsg(null)
    try {
      const res = await saveSubDag(normalized, selectedTeamId)
      setShellMsg(`已保存子 DAG · ${res.subdag.title} v${res.subdag.version}`)
    } catch (e) {
      setShellMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSubdagBusy(false)
    }
  }

  return (
    <>
      <div className="modal-backdrop workflow-backdrop" role="dialog" aria-modal="true" aria-label="工作流">
        <div className="workflow-panel animate-in">
          <header className="studio-topbar">
            <div>
              <p className="eyebrow">LangGraph · Workflow</p>
              <h2>{normalized.title}</h2>
              <p className="muted small">{normalized.summary}</p>
              <div className="studio-view-tabs" role="tablist" aria-label="视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'design'}
                  className={view === 'design' ? 'active' : ''}
                  onClick={() => setView('design')}
                >
                  设计
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'execution'}
                  className={view === 'execution' ? 'active' : ''}
                  onClick={() => setView('execution')}
                >
                  执行
                </button>
              </div>
            </div>
            <div className="top-actions">
              <button type="button" className="ghost" onClick={onReopenReview}>
                批准/修改
              </button>
              {view === 'design' ? (
                <button type="button" className="primary" onClick={() => setView('execution')}>
                  执行
                </button>
              ) : (
                <button type="button" className="secondary" onClick={() => setView('design')}>
                  返回设计
                </button>
              )}
              <button type="button" className="secondary" onClick={() => setScheduleOpen(true)}>
                定时运行
              </button>
              <button type="button" className="secondary" onClick={() => setDeployOpen(true)}>
                部署到平台
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void handleDocs()}
                disabled={docsBusy}
              >
                {docsBusy ? '生成中…' : '工作流文档'}
              </button>
              <button type="button" className="secondary" onClick={onExport} disabled={exporting}>
                {exporting ? '导出中…' : '导出 LangGraph ZIP'}
              </button>
              <button type="button" className="ghost" onClick={onClose}>
                关闭
              </button>
            </div>
          </header>
          {shellMsg ? <p className="muted small studio-shell-msg">{shellMsg}</p> : null}

          {view === 'design' ? (
            <div className="studio-grid">
              <aside className="thoughts-pane">
                <p className="eyebrow">提示</p>
                <ul>
                  {thoughts.length === 0 ? (
                    <>
                      <li>外层是 LangGraph 模块图；双击 Crew 子 DAG 进入内层 Agent/Task。</li>
                      <li>执行可整图跑或单独回放某个子 DAG；运行前会静态预估 token。</li>
                      <li>「导出 LangGraph ZIP」可脱离本平台本地运行（无锁定）。</li>
                    </>
                  ) : (
                    thoughts.map((t) => <li key={t}>{t}</li>)
                  )}
                </ul>
                {lastRun?.ok && (
                  <button type="button" className="ghost wide" onClick={() => setView('execution')}>
                    查看上次执行结果
                  </button>
                )}
                {lastRun?.ok && (
                  <button type="button" className="ghost wide" onClick={() => setDeployOpen(true)}>
                    执行通过 → 部署到平台
                  </button>
                )}
                <button type="button" className="ghost wide" onClick={() => setScheduleOpen(true)}>
                  管理定时（已配置 Task 定时：{scheduledCount}）
                </button>
                <button
                  type="button"
                  className="ghost wide"
                  disabled={subdagBusy || !selectedTeamId}
                  onClick={() => void handleSaveSubDag()}
                >
                  {subdagBusy
                    ? '保存中…'
                    : selectedTeamId
                      ? `保存子 DAG（${selectedTeamId}）`
                      : '保存子 DAG（先选 Team）'}
                </button>
              </aside>

              <div className="canvas-pane">
                <CrewCanvas
                  plan={normalized}
                  selectedId={selectedId}
                  onSelect={(id, kind) => {
                    setSelectedId(id)
                    setSelectedKind(kind)
                  }}
                  onChange={onChange}
                  lastRun={lastRun}
                />
                {selectedKind ? (
                  <div className="canvas-inspector-dock" aria-label="节点编辑">
                    <div className="canvas-inspector-dock-head">
                      <p className="eyebrow">属性</p>
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() => {
                          setSelectedId(null)
                          setSelectedKind(null)
                        }}
                      >
                        关闭
                      </button>
                    </div>
                    <NodeInspector
                      plan={normalized}
                      selectedId={selectedId}
                      selectedKind={selectedKind}
                      onChange={onChange}
                    />
                  </div>
                ) : null}
              </div>

              <aside className="resources-pane">
                <p className="eyebrow">Resources</p>
                <button
                  type="button"
                  className="resource"
                  onClick={() => {
                    setSelectedId('start:start')
                    setSelectedKind('start')
                  }}
                >
                  开始节点
                </button>
                <button type="button" className="resource" onClick={() => onChange(addTeam(normalized))}>
                  + Team
                </button>
                <button
                  type="button"
                  className="resource"
                  onClick={() => onChange(addClineAgent(normalized))}
                  disabled={hasCline}
                  title={hasCline ? '已有 Cline 编码个体' : '添加专职编码个体 Cline'}
                >
                  + Cline（编码）
                </button>
                <button type="button" className="resource" onClick={() => onChange(addAgent(normalized))}>
                  + Agent
                </button>
                <button type="button" className="resource" onClick={() => onChange(addTask(normalized))}>
                  + Task
                </button>
                <button
                  type="button"
                  className="resource"
                  onClick={() => onChange(addScheduledTask(normalized))}
                >
                  + 定时任务
                </button>
                <div className="resource-meta">
                  <p>
                    Crew 子DAG: <strong>{moduleCount}</strong>
                  </p>
                  <p>
                    Teams: <strong>{normalized.teams.length}</strong>
                  </p>
                  <p>
                    Agents: <strong>{normalized.agents.length}</strong>
                  </p>
                  <p>
                    Tasks: <strong>{normalized.tasks.length}</strong>
                  </p>
                  <p>
                    定时: <strong>{scheduledCount}</strong>
                  </p>
                  <p>
                    熔断: <strong>{normalized.run_policy?.token_budget_max ?? '—'}</strong>
                  </p>
                  {hasCline && (
                    <p>
                      编码: <strong>Cline</strong>
                    </p>
                  )}
                </div>
              </aside>
            </div>
          ) : (
            <ExecutionView
              plan={normalized}
              initialRun={lastRun}
              onDeploy={() => setDeployOpen(true)}
              onRunFinished={(res) => {
                setLastRun(res)
                onRunFinished?.(res)
              }}
            />
          )}
        </div>
      </div>

      <SchedulePanel
        open={scheduleOpen}
        plan={normalized}
        onClose={() => setScheduleOpen(false)}
        onPlanNeedSchedule={(next) => onChange(next)}
      />

      <DeployPanel open={deployOpen} plan={normalized} onClose={() => setDeployOpen(false)} />
      <MarkdownReaderModal doc={activeDoc} onClose={() => setActiveDoc(null)} />
    </>
  )
}
