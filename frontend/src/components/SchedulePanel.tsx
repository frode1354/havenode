import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteSchedule,
  listSchedules,
  runScheduleNow,
  toggleSchedule,
  upsertSchedule,
  type ScheduleJob,
} from '../api'
import {
  buildUserSchedule,
  defaultDatetimeLocal,
  defaultLocalTime,
  type ScheduleRepeat,
} from '../scheduleTime'
import type { CrewPlan } from '../types'
import { ensurePlanTeams } from '../types'

type Props = {
  open: boolean
  plan: CrewPlan
  onClose: () => void
  onPlanNeedSchedule?: (plan: CrewPlan) => void
}

function formatWhen(iso?: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}

function cadence(job: ScheduleJob): string {
  if (job.label && /每天|工作日|每周|仅一次|每 \d+/.test(job.label)) {
    return job.label.replace(/^.*·\s*/, '') || job.label
  }
  if (job.mode === 'once' && job.run_at) return `仅一次 ${formatWhen(job.run_at)}`
  if (job.mode === 'cron' && job.cron) return `cron ${job.cron}`
  return `每 ${job.interval_minutes ?? 60} 分钟`
}

export function SchedulePanel({ open, plan, onClose, onPlanNeedSchedule }: Props) {
  const [jobs, setJobs] = useState<ScheduleJob[]>([])
  const [schedulerOn, setSchedulerOn] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [repeat, setRepeat] = useState<ScheduleRepeat>('daily')
  const [time, setTime] = useState(defaultLocalTime)
  const [weekday, setWeekday] = useState(1)
  const [runAtLocal, setRunAtLocal] = useState(defaultDatetimeLocal)
  const [intervalMinutes, setIntervalMinutes] = useState(60)

  const normalized = useMemo(() => ensurePlanTeams(plan), [plan])
  const enabledOnPlan = normalized.tasks.filter((t) => t.schedule?.enabled).length
  const myJobs = jobs.filter(
    (j) => j.plan_name === normalized.name || j.title === normalized.title,
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await listSchedules()
      setJobs(res.jobs || [])
      setSchedulerOn(!!res.scheduler?.running)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const id = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(id)
  }, [open, refresh])

  if (!open) return null

  async function ensureTaskSchedule(
    built: ReturnType<typeof buildUserSchedule>,
  ): Promise<CrewPlan> {
    const schedule = {
      enabled: true,
      mode: built.mode,
      interval_minutes: built.interval_minutes,
      cron: built.cron,
      run_at: built.run_at,
      label: built.label,
    }
    const tasks =
      enabledOnPlan > 0
        ? normalized.tasks.map((t) =>
            t.schedule?.enabled ? { ...t, schedule: { ...t.schedule, ...schedule } } : t,
          )
        : normalized.tasks.map((t, i) =>
            i === normalized.tasks.length - 1 ? { ...t, schedule } : t,
          )
    const next = { ...normalized, tasks }
    onPlanNeedSchedule?.(next)
    return next
  }

  async function handleEnable() {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      const built = buildUserSchedule({
        repeat,
        time,
        weekday,
        runAtLocal,
        intervalMinutes,
        label: '定时运行整包 Crew',
      })
      const ready = await ensureTaskSchedule(built)
      const inputs: Record<string, string> = {}
      for (const i of ready.inputs) inputs[i.name] = i.example || ''
      const res = await upsertSchedule(ready, inputs, {
        enabled: true,
        mode: built.mode,
        interval_minutes: built.interval_minutes,
        cron: built.cron,
        run_at: built.run_at,
        label: built.label,
      })
      setMessage(`已启用：${res.job.label || res.job.title} · 下次 ${formatWhen(res.job.next_run_at)}`)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="定时运行">
      <div className="modal-panel schedule-panel animate-in">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Schedule</p>
            <h2>设定运行时间</h2>
            <p className="muted">
              由你选择具体时间，到期后整包重跑当前 Crew。调度器
              {schedulerOn ? '已在后台运行' : '未启动（请重启后端）'}。
            </p>
          </div>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>

        <div className="schedule-body">
          <section className="schedule-card">
            <h3>为本工作流设定</h3>
            <p className="muted small">
              画布上已启用定时的 Task：{enabledOnPlan}。时间以本机时区为准。
            </p>

            <label className="field">
              <span>重复</span>
              <select
                value={repeat}
                disabled={busy}
                onChange={(e) => setRepeat(e.target.value as ScheduleRepeat)}
              >
                <option value="daily">每天</option>
                <option value="weekdays">工作日（周一至周五）</option>
                <option value="weekly">每周</option>
                <option value="once">仅一次</option>
                <option value="interval">每隔 N 分钟</option>
              </select>
            </label>

            {(repeat === 'daily' || repeat === 'weekdays' || repeat === 'weekly') && (
              <label className="field">
                <span>时间</span>
                <input
                  type="time"
                  value={time}
                  disabled={busy}
                  onChange={(e) => setTime(e.target.value || '09:00')}
                />
              </label>
            )}

            {repeat === 'weekly' && (
              <label className="field">
                <span>星期</span>
                <select
                  value={weekday}
                  disabled={busy}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                >
                  <option value={0}>周日</option>
                  <option value={1}>周一</option>
                  <option value={2}>周二</option>
                  <option value={3}>周三</option>
                  <option value={4}>周四</option>
                  <option value={5}>周五</option>
                  <option value={6}>周六</option>
                </select>
              </label>
            )}

            {repeat === 'once' && (
              <label className="field">
                <span>日期与时间</span>
                <input
                  type="datetime-local"
                  value={runAtLocal}
                  disabled={busy}
                  onChange={(e) => setRunAtLocal(e.target.value)}
                />
              </label>
            )}

            {repeat === 'interval' && (
              <label className="field">
                <span>间隔（分钟）</span>
                <input
                  type="number"
                  min={1}
                  max={10080}
                  value={intervalMinutes}
                  disabled={busy}
                  onChange={(e) =>
                    setIntervalMinutes(Math.max(1, Number(e.target.value) || 60))
                  }
                />
              </label>
            )}

            <button
              type="button"
              className="primary wide"
              disabled={busy || normalized.tasks.length === 0}
              onClick={() => void handleEnable()}
            >
              {busy ? '处理中…' : '按设定启用'}
            </button>
          </section>

          <section className="schedule-card">
            <div className="schedule-card-head">
              <h3>本项目任务</h3>
              <button type="button" className="ghost compact" onClick={() => void refresh()} disabled={loading}>
                刷新
              </button>
            </div>
            {myJobs.length === 0 ? (
              <p className="muted small">尚未注册定时任务。</p>
            ) : (
              <ul className="schedule-job-list">
                {myJobs.map((job) => (
                  <li key={job.id} className="schedule-job">
                    <div>
                      <strong>{job.label || job.title}</strong>
                      <p className="muted small">
                        {cadence(job)} · 下次 {formatWhen(job.next_run_at)}
                        {!job.enabled ? ' · 已暂停' : ''}
                      </p>
                      <p className="muted small">
                        上次 {formatWhen(job.last_run_at)} ·{' '}
                        {job.last_status || '未跑'} · 共 {job.run_count ?? 0} 次
                        {job.last_error ? ` · ${job.last_error}` : ''}
                      </p>
                    </div>
                    <div className="schedule-job-actions">
                      <button
                        type="button"
                        className="ghost compact"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            setBusy(true)
                            try {
                              await toggleSchedule(job.id, !job.enabled)
                              await refresh()
                            } catch (e) {
                              setError(e instanceof Error ? e.message : String(e))
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }
                      >
                        {job.enabled ? '暂停' : '恢复'}
                      </button>
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            setBusy(true)
                            try {
                              await runScheduleNow(job.id)
                              setMessage('已触发立即运行，稍后刷新查看结果')
                              await refresh()
                            } catch (e) {
                              setError(e instanceof Error ? e.message : String(e))
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }
                      >
                        立即跑
                      </button>
                      <button
                        type="button"
                        className="ghost compact danger-btn"
                        disabled={busy}
                        onClick={() =>
                          void (async () => {
                            setBusy(true)
                            try {
                              await deleteSchedule(job.id)
                              await refresh()
                            } catch (e) {
                              setError(e instanceof Error ? e.message : String(e))
                            } finally {
                              setBusy(false)
                            }
                          })()
                        }
                      >
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {message && <p className="schedule-msg ok">{message}</p>}
          {error && <p className="schedule-msg err">{error}</p>}
        </div>
      </div>
    </div>
  )
}
