import type { ProjectRecord } from '../history'
import { formatUpdatedAt } from '../history'

type Props = {
  projects: ProjectRecord[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

export function ProjectHistory({ projects, activeId, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="history-rail" aria-label="项目记录">
      <div className="history-head">
        <p className="eyebrow">项目记录</p>
        <button type="button" className="secondary compact" onClick={onNew}>
          新建
        </button>
      </div>

      <div className="history-list">
        {projects.length === 0 ? (
          <p className="history-empty">还没有项目。对话生成计划后会自动记入这里。</p>
        ) : (
          projects.map((p) => (
            <article
              key={p.id}
              className={`history-item ${p.id === activeId ? 'active' : ''}`}
            >
              <button type="button" className="history-main" onClick={() => onSelect(p.id)}>
                <span className="history-title">{p.title}</span>
                <span className="history-meta">
                  {phaseLabel(p.phase)} ·{' '}
                  {formatUpdatedAt(p.conversationAt || p.updatedAt)}
                </span>
                {p.summary ? <span className="history-summary">{p.summary}</span> : null}
              </button>
              <button
                type="button"
                className="history-delete"
                title="删除记录"
                aria-label={`删除 ${p.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(p.id)
                }}
              >
                ×
              </button>
            </article>
          ))
        )}
      </div>
    </aside>
  )
}

function phaseLabel(phase: ProjectRecord['phase']): string {
  switch (phase) {
    case 'editor':
      return '已批准'
    case 'review':
      return '待审阅'
    default:
      return '对话中'
  }
}
