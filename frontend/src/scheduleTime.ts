/** Build schedule fields from user-picked local time (not LLM defaults). */

export type ScheduleRepeat = 'daily' | 'weekdays' | 'weekly' | 'once' | 'interval'

export type UserScheduleInput = {
  repeat: ScheduleRepeat
  /** HH:MM local, for daily / weekdays / weekly */
  time?: string
  /** 0=Sun … 6=Sat, for weekly */
  weekday?: number
  /** datetime-local value YYYY-MM-DDTHH:mm, for once */
  runAtLocal?: string
  intervalMinutes?: number
  label?: string
}

export type BuiltSchedule = {
  mode: 'interval' | 'cron' | 'once'
  interval_minutes?: number
  cron?: string
  run_at?: string
  label: string
}

function parseHm(time: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return { hour: 9, minute: 0 }
  return {
    hour: Math.min(23, Math.max(0, Number(m[1]))),
    minute: Math.min(59, Math.max(0, Number(m[2]))),
  }
}

/** datetime-local → ISO with local offset preserved via Date. */
export function localInputToIso(localValue: string): string {
  const d = new Date(localValue)
  if (Number.isNaN(d.getTime())) {
    throw new Error('请选择有效的运行时间')
  }
  return d.toISOString()
}

export function defaultLocalTime(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 30, 0, 0)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function defaultDatetimeLocal(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() + 30, 0, 0)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${mo}-${day}T${h}:${mi}`
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayLabel(n: number): string {
  return WEEKDAY_LABELS[((n % 7) + 7) % 7] ?? '周日'
}

export function buildUserSchedule(input: UserScheduleInput): BuiltSchedule {
  const labelBase = input.label?.trim() || '定时运行'

  if (input.repeat === 'interval') {
    const mins = Math.max(1, input.intervalMinutes ?? 60)
    return {
      mode: 'interval',
      interval_minutes: mins,
      label: `${labelBase} · 每 ${mins} 分钟`,
    }
  }

  if (input.repeat === 'once') {
    if (!input.runAtLocal) throw new Error('请选择运行日期和时间')
    const iso = localInputToIso(input.runAtLocal)
    if (new Date(iso).getTime() <= Date.now()) {
      throw new Error('运行时间必须晚于现在')
    }
    const when = new Date(iso).toLocaleString()
    return {
      mode: 'once',
      run_at: iso,
      label: `${labelBase} · 仅一次 ${when}`,
    }
  }

  const { hour, minute } = parseHm(input.time || '09:00')
  const hm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

  if (input.repeat === 'daily') {
    return {
      mode: 'cron',
      cron: `${minute} ${hour} * * *`,
      label: `${labelBase} · 每天 ${hm}`,
    }
  }

  if (input.repeat === 'weekdays') {
    return {
      mode: 'cron',
      cron: `${minute} ${hour} * * 1-5`,
      label: `${labelBase} · 工作日 ${hm}`,
    }
  }

  // weekly
  const dow = Math.min(6, Math.max(0, input.weekday ?? 1))
  return {
    mode: 'cron',
    cron: `${minute} ${hour} * * ${dow}`,
    label: `${labelBase} · 每${weekdayLabel(dow)} ${hm}`,
  }
}

/** Infer panel controls from an existing job / task schedule. */
export function inferRepeatFromJob(opts: {
  mode?: string | null
  cron?: string | null
  interval_minutes?: number | null
}): ScheduleRepeat {
  if (opts.mode === 'once') return 'once'
  if (opts.mode === 'interval') return 'interval'
  const cron = (opts.cron || '').trim()
  const parts = cron.split(/\s+/)
  if (parts.length === 5) {
    const dow = parts[4]
    if (dow === '*') return 'daily'
    if (dow === '1-5') return 'weekdays'
    if (/^\d$/.test(dow)) return 'weekly'
  }
  return 'daily'
}

export function timeFromCron(cron?: string | null): string {
  const parts = (cron || '').trim().split(/\s+/)
  if (parts.length < 2) return '09:00'
  const minute = Number(parts[0])
  const hour = Number(parts[1])
  if (Number.isNaN(minute) || Number.isNaN(hour)) return '09:00'
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function weekdayFromCron(cron?: string | null): number {
  const parts = (cron || '').trim().split(/\s+/)
  if (parts.length !== 5) return 1
  const n = Number(parts[4])
  return Number.isNaN(n) ? 1 : Math.min(6, Math.max(0, n))
}
