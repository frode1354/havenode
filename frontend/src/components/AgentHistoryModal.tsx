import type { AgentSpec, RunResponse } from '../types'

type Props = {
  open: boolean
  agent: AgentSpec | null
  lastRun: RunResponse | null
  onClose: () => void
}

export function AgentHistoryModal({ open, agent, lastRun, onClose }: Props) {
  if (!open || !agent) return null

  const rows =
    lastRun?.task_results?.filter((r) => {
      const a = (r.agent || '').toLowerCase()
      return (
        a.includes(agent.id.toLowerCase()) ||
        a.includes(agent.role.toLowerCase()) ||
        !r.agent
      )
    }) ?? []

  const matched = rows.filter(
    (r) =>
      (r.agent || '').toLowerCase().includes(agent.id.toLowerCase()) ||
      (r.agent || '').toLowerCase().includes(agent.role.toLowerCase()),
  )
  const list = matched.length > 0 ? matched : lastRun?.task_results?.length ? [] : []

  return (
    <div className="modal-backdrop history-backdrop" role="dialog" aria-modal="true">
      <div className="history-panel animate-in">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Output History</p>
            <h2>{agent.role}</h2>
            <p className="muted small">{agent.id}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="history-body">
          {!lastRun && <p className="muted">尚无沙箱运行记录。先打开沙箱执行一次。</p>}
          {lastRun && list.length === 0 && (
            <p className="muted">
              上次运行未匹配到该 Agent 的专属输出。
              {lastRun.task_results?.length
                ? '可在下方查看全部任务结果。'
                : '任务结果为空。'}
            </p>
          )}
          {(list.length > 0 ? list : lastRun?.task_results || []).map((r, i) => (
            <article key={`${r.task_id}-${i}`} className="history-card">
              <header>
                <strong>{r.task_id}</strong>
                <span className="muted small">{r.agent || agent.role}</span>
              </header>
              <pre>{r.output || '（无文本输出）'}</pre>
            </article>
          ))}
          {lastRun?.result && (
            <article className="history-card">
              <header>
                <strong>最终结果</strong>
              </header>
              <pre>{lastRun.result}</pre>
            </article>
          )}
        </div>
      </div>
    </div>
  )
}
