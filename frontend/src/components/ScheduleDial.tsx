import type { PointerEvent } from 'react'
import type { TaskSchedule } from '../types'

/** Map interval minutes → dial progress 0..1 (log-ish scale, capped at 24h). */
function intervalProgress(minutes: number): number {
  const m = Math.max(1, minutes)
  return Math.min(1, Math.log10(m + 1) / Math.log10(24 * 60 + 1))
}

/** Rough next-fire angle for cron (hour hand estimate from "H * * * *"). */
function cronHourAngle(cron: string | undefined): number {
  if (!cron) return 0
  const parts = cron.trim().split(/\s+/)
  const hour = Number(parts[1])
  if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
    return (hour / 24) * 360
  }
  return 45
}

type Props = {
  schedule: TaskSchedule
  size?: number
  interactive?: boolean
  onIntervalChange?: (minutes: number) => void
}

export function ScheduleDial({ schedule, size = 120, interactive, onIntervalChange }: Props) {
  const r = size / 2
  const stroke = Math.max(6, size * 0.08)
  const trackR = r - stroke
  const progress =
    schedule.mode === 'interval'
      ? intervalProgress(schedule.interval_minutes ?? 60)
      : 0.35
  const circ = 2 * Math.PI * trackR
  const dash = circ * progress
  const handAngle =
    schedule.mode === 'cron' || schedule.mode === 'once'
      ? cronHourAngle(
          schedule.mode === 'once' && schedule.run_at
            ? `${new Date(schedule.run_at).getMinutes()} ${new Date(schedule.run_at).getHours()} * * *`
            : schedule.cron,
        )
      : progress * 360 - 90

  const label =
    schedule.mode === 'once'
      ? 'once'
      : schedule.mode === 'cron'
        ? schedule.label?.replace(/^.*·\s*/, '') || schedule.cron || 'cron'
        : `${schedule.interval_minutes ?? 60}m`

  function onPointer(e: PointerEvent<SVGSVGElement>) {
    if (!interactive || schedule.mode !== 'interval' || !onIntervalChange) return
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    if (deg < 0) deg += 360
    const p = deg / 360
    // inverse of log scale roughly
    const minutes = Math.round(Math.pow(10, p * Math.log10(24 * 60 + 1)) - 1)
    onIntervalChange(Math.max(1, Math.min(24 * 60, minutes)))
  }

  return (
    <div className="schedule-dial" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={interactive ? 'interactive' : undefined}
        onPointerDown={onPointer}
        onPointerMove={(e) => {
          if (e.buttons === 1) onPointer(e)
        }}
      >
        <circle
          cx={r}
          cy={r}
          r={trackR}
          fill="none"
          stroke="var(--stroke)"
          strokeWidth={stroke}
        />
        <circle
          cx={r}
          cy={r}
          r={trackR}
          fill="none"
          stroke="#10b981"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circ - dash}`}
          transform={`rotate(-90 ${r} ${r})`}
          className="schedule-dial-arc"
        />
        {/* ticks */}
        {Array.from({ length: 12 }).map((_, i) => {
          const a = ((i / 12) * 360 - 90) * (Math.PI / 180)
          const x1 = r + Math.cos(a) * (trackR - stroke * 0.9)
          const y1 = r + Math.sin(a) * (trackR - stroke * 0.9)
          const x2 = r + Math.cos(a) * (trackR - stroke * 0.35)
          const y2 = r + Math.sin(a) * (trackR - stroke * 0.35)
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--muted)"
              strokeWidth={i % 3 === 0 ? 2 : 1}
              opacity={0.55}
            />
          )
        })}
        <line
          x1={r}
          y1={r}
          x2={r + Math.cos((handAngle * Math.PI) / 180) * (trackR * 0.62)}
          y2={r + Math.sin((handAngle * Math.PI) / 180) * (trackR * 0.62)}
          stroke="#059669"
          strokeWidth={2.5}
          strokeLinecap="round"
          className="schedule-dial-hand"
        />
        <circle cx={r} cy={r} r={3.5} fill="#059669" />
        <text
          x={r}
          y={r + size * 0.28}
          textAnchor="middle"
          className="schedule-dial-label"
          fontSize={Math.max(9, size * 0.11)}
          fill="var(--text)"
        >
          {label.length > 10 ? `${label.slice(0, 9)}…` : label}
        </text>
      </svg>
      <p className="schedule-dial-caption">
        {schedule.mode === 'interval'
          ? '间隔转盘'
          : schedule.mode === 'once'
            ? '指定时间'
            : '设定时针'}
        {schedule.label ? ` · ${schedule.label}` : ''}
      </p>
    </div>
  )
}

/** Compact clock face for canvas task nodes. */
export function ScheduleBadge({
  minutes,
  cron,
  mode,
}: {
  minutes?: number
  cron?: string
  mode: 'interval' | 'cron' | 'once'
}) {
  const size = 44
  const r = size / 2
  const progress = mode === 'interval' ? intervalProgress(minutes ?? 60) : 0.4
  const circ = 2 * Math.PI * (r - 4)
  const dash = circ * progress
  const hand =
    mode === 'cron' || mode === 'once' ? cronHourAngle(cron) : progress * 360 - 90

  return (
    <svg className="schedule-badge" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={r} cy={r} r={r - 2} fill="#ecfdf5" stroke="#10b981" strokeWidth={1.5} />
      <circle
        cx={r}
        cy={r}
        r={r - 6}
        fill="none"
        stroke="#10b981"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ - dash}`}
        transform={`rotate(-90 ${r} ${r})`}
      />
      <line
        x1={r}
        y1={r}
        x2={r + Math.cos((hand * Math.PI) / 180) * (r * 0.45)}
        y2={r + Math.sin((hand * Math.PI) / 180) * (r * 0.45)}
        stroke="#047857"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={r} cy={r} r={2} fill="#047857" />
    </svg>
  )
}
