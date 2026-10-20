import { useEffect, useState } from 'react'
import { formatDurationMs, type PipelineStage } from '../types'

type Props = {
  stages: PipelineStage[]
  /** When true, running stages tick elapsed time live */
  live?: boolean
}

export function StageProgress({ stages, live = true }: Props) {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!live || !stages.some((s) => s.status === 'running')) return
    const id = window.setInterval(() => setTick((n) => n + 1), 200)
    return () => window.clearInterval(id)
  }, [live, stages])

  if (stages.length === 0) return null

  const now = Date.now()

  return (
    <div className="stage-progress" role="status" aria-live="polite">
      <p className="stage-progress-title">过程</p>
      <ol className="stage-list">
        {stages.map((s) => {
          const skipClock = s.userWait || s.status === 'waiting'
          let elapsed: number | undefined
          if (!skipClock) {
            if (s.status === 'running' && s.startedAt) {
              elapsed = now - s.startedAt
            } else if (s.startedAt != null && s.endedAt != null) {
              elapsed = Math.max(0, s.endedAt - s.startedAt)
            } else {
              elapsed = s.durationMs
            }
          }
          let timeLabel = '—'
          if (s.status === 'pending') timeLabel = '等待'
          else if (s.status === 'waiting' || s.userWait) timeLabel = '等待你'
          else if (s.status === 'error') timeLabel = '失败'
          else if (elapsed != null) timeLabel = formatDurationMs(elapsed)
          return (
            <li key={s.id} className={`stage-item ${s.status}`}>
              <span className="stage-dot" aria-hidden />
              <div className="stage-body">
                <div className="stage-row">
                  <span className="stage-label">{s.label}</span>
                  <span className="stage-time">{timeLabel}</span>
                </div>
                {s.detail && <p className="stage-detail">{s.detail}</p>}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
