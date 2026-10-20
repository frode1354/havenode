import { useEffect, useState } from 'react'
import type { CrewPlan, SelectKind } from '../types'
import { ensurePlanTeams } from '../types'
import { CrewCanvas } from './CrewCanvas'
import { NodeInspector } from './NodeInspector'

type Props = {
  open: boolean
  plan: CrewPlan | null
  loading?: boolean
  onClose: () => void
  onApprove: (plan: CrewPlan) => void
  /** Approve and jump straight into sandbox run */
  onApproveAndRun?: (plan: CrewPlan) => void
  onRevise: (plan: CrewPlan, feedback: string) => void
}

export function ApproveModifyModal({
  open,
  plan,
  loading,
  onClose,
  onApprove,
  onApproveAndRun,
  onRevise,
}: Props) {
  const [draft, setDraft] = useState<CrewPlan | null>(plan ? ensurePlanTeams(plan) : null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedKind, setSelectedKind] = useState<SelectKind>(null)
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    if (plan) {
      setDraft(ensurePlanTeams(plan))
      setSelectedId(null)
      setSelectedKind(null)
    }
  }, [plan])

  if (!open || !draft) return null

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="批准或修改计划">
      <div className="modal-panel approve-modal animate-in">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Approve or Modify</p>
            <h2>{draft.title}</h2>
            <p className="muted">{draft.summary}</p>
          </div>
          <button type="button" className="ghost" onClick={onClose} disabled={loading}>
            关闭
          </button>
        </header>

        <div className="modal-body">
          <div className="modal-canvas">
            <CrewCanvas
              plan={draft}
              selectedId={selectedId}
              onSelect={(id, kind) => {
                setSelectedId(id)
                setSelectedKind(kind)
              }}
              onChange={setDraft}
            />
          </div>
          <NodeInspector
            plan={draft}
            selectedId={selectedId}
            selectedKind={selectedKind}
            onChange={setDraft}
          />
        </div>

        <footer className="modal-footer">
          <div className="feedback-row">
            <input
              placeholder="描述希望如何修改计划（可选，用于 AI 重新生成）"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              disabled={loading}
            />
            <button
              type="button"
              className="secondary"
              disabled={loading || !feedback.trim()}
              onClick={() => onRevise(draft, feedback.trim())}
            >
              {loading ? '生成中…' : '保存修改并重新生成'}
            </button>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={onClose} disabled={loading}>
              继续聊天
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading}
              onClick={() => onApprove(draft)}
            >
              批准并进入编辑器
            </button>
            {onApproveAndRun && (
              <button
                type="button"
                className="primary"
                disabled={loading}
                onClick={() => onApproveAndRun(draft)}
              >
                批准并运行
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}
