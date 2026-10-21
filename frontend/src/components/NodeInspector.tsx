import { useState } from 'react'
import type { CrewPlan, GrantSpec, SelectKind, StartTrigger } from '../types'
import { defaultRunPolicy, defaultSchedule, emptyGrants, ensureWorkflowPlan } from '../types'
import {
  duplicateTeam,
  effectiveGrants,
  getEdgeOverride,
  isClineAgent,
  removeTeam,
  setEdgeDirection,
  syncTeamMembership,
  toggleEdgeReversed,
  toggleGrantList,
  updateAgent,
  updateStart,
  updateTask,
  updateTeam,
  updateTeamGrants,
} from '../planUtils'
import {
  buildUserSchedule,
  defaultDatetimeLocal,
  inferRepeatFromJob,
  timeFromCron,
  weekdayFromCron,
  type ScheduleRepeat,
} from '../scheduleTime'
import { loadSettings } from '../settings'
import { ScheduleDial } from './ScheduleDial'

type Props = {
  plan: CrewPlan
  selectedId: string | null
  selectedKind: SelectKind
  onChange: (plan: CrewPlan) => void
}

function GrantEditor({
  title,
  grants,
  onChange,
  hint,
  sections = ['tools', 'skills', 'knowledge'],
}: {
  title: string
  grants: GrantSpec
  onChange: (next: GrantSpec) => void
  hint?: string
  sections?: Array<'tools' | 'skills' | 'knowledge'>
}) {
  const settings = loadSettings()
  const tools = settings.tools.filter((t) => t.enabled)
  const skills = settings.skills.filter((s) => s.enabled)
  const knowledge = settings.knowledge.filter((k) => k.enabled)

  return (
    <div className="grant-block">
      <p className="grant-title">{title}</p>
      {hint && <p className="settings-tip compact">{hint}</p>}

      {sections.includes('tools') && (
        <fieldset>
          <legend>工具</legend>
          {tools.length === 0 && <p className="muted small">设置中暂无启用工具</p>}
          {tools.map((tool) => {
            const checked = grants.tools.includes(tool.id)
            return (
              <label key={tool.id} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...grants,
                      tools: toggleGrantList(grants.tools, tool.id, !checked),
                    })
                  }
                />
                {tool.name}
              </label>
            )
          })}
        </fieldset>
      )}

      {sections.includes('skills') && (
        <fieldset>
          <legend>Skills</legend>
          {skills.length === 0 && <p className="muted small">设置中暂无启用 Skill</p>}
          {skills.map((skill) => {
            const checked = grants.skills.includes(skill.id)
            return (
              <label key={skill.id} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...grants,
                      skills: toggleGrantList(grants.skills, skill.id, !checked),
                    })
                  }
                />
                {skill.name}
              </label>
            )
          })}
        </fieldset>
      )}

      {sections.includes('knowledge') && (
        <fieldset>
          <legend>知识库</legend>
          {knowledge.length === 0 && <p className="muted small">设置中暂无知识库</p>}
          {knowledge.map((kb) => {
            const checked = grants.knowledge.includes(kb.id)
            return (
              <label key={kb.id} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({
                      ...grants,
                      knowledge: toggleGrantList(grants.knowledge, kb.id, !checked),
                    })
                  }
                />
                {kb.name}
              </label>
            )
          })}
        </fieldset>
      )}
    </div>
  )
}

function TaskScheduleEditor({
  schedule,
  onApply,
}: {
  schedule: NonNullable<CrewPlan['tasks'][0]['schedule']>
  onApply: (next: NonNullable<CrewPlan['tasks'][0]['schedule']>) => void
}) {
  const repeat = inferRepeatFromJob(schedule)
  const [kind, setKind] = useState<ScheduleRepeat>(repeat)
  const [time, setTime] = useState(timeFromCron(schedule.cron) || '09:00')
  const [weekday, setWeekday] = useState(weekdayFromCron(schedule.cron))
  const [runAtLocal, setRunAtLocal] = useState(defaultDatetimeLocal)
  const [intervalMinutes, setIntervalMinutes] = useState(schedule.interval_minutes ?? 60)

  function apply(nextRepeat: ScheduleRepeat, patch?: Partial<{
    time: string
    weekday: number
    runAtLocal: string
    intervalMinutes: number
  }>) {
    try {
      const built = buildUserSchedule({
        repeat: nextRepeat,
        time: patch?.time ?? time,
        weekday: patch?.weekday ?? weekday,
        runAtLocal: patch?.runAtLocal ?? runAtLocal,
        intervalMinutes: patch?.intervalMinutes ?? intervalMinutes,
        label: schedule.label || '定时任务',
      })
      onApply({
        enabled: true,
        mode: built.mode,
        interval_minutes: built.interval_minutes,
        cron: built.cron,
        run_at: built.run_at,
        label: built.label,
      })
    } catch {
      /* once without datetime — ignore until user picks */
    }
  }

  return (
    <>
      <div className="schedule-visual">
        <ScheduleDial
          schedule={schedule}
          size={132}
          interactive={schedule.mode === 'interval'}
          onIntervalChange={(minutes) => {
            setIntervalMinutes(minutes)
            setKind('interval')
            apply('interval', { intervalMinutes: minutes })
          }}
        />
      </div>
      <label>
        重复
        <select
          value={kind}
          onChange={(e) => {
            const v = e.target.value as ScheduleRepeat
            setKind(v)
            apply(v)
          }}
        >
          <option value="daily">每天</option>
          <option value="weekdays">工作日</option>
          <option value="weekly">每周</option>
          <option value="once">仅一次</option>
          <option value="interval">每隔 N 分钟</option>
        </select>
      </label>
      {(kind === 'daily' || kind === 'weekdays' || kind === 'weekly') && (
        <label>
          时间
          <input
            type="time"
            value={time}
            onChange={(e) => {
              const v = e.target.value || '09:00'
              setTime(v)
              apply(kind, { time: v })
            }}
          />
        </label>
      )}
      {kind === 'weekly' && (
        <label>
          星期
          <select
            value={weekday}
            onChange={(e) => {
              const v = Number(e.target.value)
              setWeekday(v)
              apply('weekly', { weekday: v })
            }}
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
      {kind === 'once' && (
        <label>
          日期与时间
          <input
            type="datetime-local"
            value={runAtLocal}
            onChange={(e) => {
              setRunAtLocal(e.target.value)
              apply('once', { runAtLocal: e.target.value })
            }}
          />
        </label>
      )}
      {kind === 'interval' && (
        <label>
          间隔分钟
          <input
            type="number"
            min={1}
            value={intervalMinutes}
            onChange={(e) => {
              const v = Number(e.target.value) || 60
              setIntervalMinutes(v)
              apply('interval', { intervalMinutes: v })
            }}
          />
        </label>
      )}
      <p className="settings-tip compact">
        时间由你设定（本机时区）。启用后台跑请打开工作流「定时运行」面板。
      </p>
    </>
  )
}

export function NodeInspector({ plan, selectedId, selectedKind, onChange }: Props) {
  const base = ensureWorkflowPlan(plan)

  if (!selectedId || !selectedKind) {
    return (
      <aside className="inspector empty">
        <p>在画布上选择 开始 / Team / Agent / Task / 连线 以编辑。</p>
      </aside>
    )
  }

  if (selectedKind === 'start') {
    const start = base.start!
    return (
      <aside className="inspector">
        <header>
          <span className="badge start">Start</span>
          <h3>{start.label || '开始'}</h3>
        </header>
        <p className="settings-tip compact">
          工作流入口：配置触发器、定时，或约定用户 kickoff 的特定格式。
        </p>
        <label>
          名称
          <input
            value={start.label}
            onChange={(e) => onChange(updateStart(base, { label: e.target.value }))}
          />
        </label>
        <label>
          触发方式
          <select
            value={start.trigger}
            onChange={(e) =>
              onChange(
                updateStart(base, { trigger: e.target.value as StartTrigger }),
              )
            }
          >
            <option value="manual">手动运行（UI / API）</option>
            <option value="schedule">定时器</option>
            <option value="webhook">Webhook（路径提示）</option>
            <option value="payload">特定格式输入</option>
          </select>
        </label>

        {(start.trigger === 'schedule' || start.schedule?.enabled) && (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={!!start.schedule?.enabled}
                onChange={(e) => {
                  const enabled = e.target.checked
                  onChange(
                    updateStart(base, {
                      trigger: enabled ? 'schedule' : start.trigger,
                      schedule: enabled
                        ? { ...(start.schedule ?? defaultSchedule()), enabled: true }
                        : start.schedule
                          ? { ...start.schedule, enabled: false }
                          : null,
                    }),
                  )
                }}
              />
              启用定时
            </label>
            {start.schedule?.enabled && (
              <TaskScheduleEditor
                schedule={start.schedule}
                onApply={(next) => onChange(updateStart(base, { schedule: next, trigger: 'schedule' }))}
              />
            )}
          </>
        )}

        {start.trigger === 'webhook' && (
          <label>
            Webhook 路径提示
            <input
              value={start.webhook_path || ''}
              placeholder="/hooks/crew-kickoff"
              onChange={(e) => onChange(updateStart(base, { webhook_path: e.target.value }))}
            />
          </label>
        )}

        <label>
          输入格式说明
          <textarea
            rows={4}
            value={start.payload_format || ''}
            placeholder={'例如：\n- invoice_urls：每行一个 Drive 共享链接\n- po_and_contract_data：CSV 或结构化文本'}
            onChange={(e) => onChange(updateStart(base, { payload_format: e.target.value }))}
          />
        </label>
        <label>
          格式示例
          <textarea
            rows={3}
            value={start.payload_example || ''}
            placeholder="粘贴一份样例 kickoff 文本"
            onChange={(e) => onChange(updateStart(base, { payload_example: e.target.value }))}
          />
        </label>

        <fieldset>
          <legend>下游 Task（启动连线）</legend>
          <p className="muted small">不勾选则自动连到无 context 依赖的入口 Task</p>
          {base.tasks.length === 0 ? (
            <p className="muted small">暂无 Task</p>
          ) : (
            base.tasks.map((t) => {
              const checked = (start.next_task_ids || []).includes(t.id)
              return (
                <label key={t.id} className="check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      const cur = start.next_task_ids || []
                      const next = checked
                        ? cur.filter((id) => id !== t.id)
                        : [...cur, t.id]
                      onChange(updateStart(base, { next_task_ids: next }))
                    }}
                  />
                  {t.id}
                </label>
              )
            })
          )}
        </fieldset>

        <label>
          备注
          <textarea
            rows={2}
            value={start.notes || ''}
            onChange={(e) => onChange(updateStart(base, { notes: e.target.value }))}
          />
        </label>

        <fieldset>
          <legend>LangGraph · 运行策略</legend>
          <label>
            Token 熔断上限
            <input
              type="number"
              min={0}
              value={base.run_policy?.token_budget_max ?? 200000}
              onChange={(e) => {
                const n = Number(e.target.value)
                onChange({
                  ...base,
                  run_policy: {
                    ...defaultRunPolicy(),
                    ...(base.run_policy ?? {}),
                    token_budget_max: Number.isFinite(n) ? n : 200000,
                  },
                })
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={base.run_policy?.circuit_breaker !== false}
              onChange={(e) =>
                onChange({
                  ...base,
                  run_policy: {
                    ...defaultRunPolicy(),
                    ...(base.run_policy ?? {}),
                    circuit_breaker: e.target.checked,
                  },
                })
              }
            />
            启用熔断（超限自动停止）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!base.run_policy?.enable_langsmith}
              onChange={(e) =>
                onChange({
                  ...base,
                  run_policy: {
                    ...defaultRunPolicy(),
                    ...(base.run_policy ?? {}),
                    enable_langsmith: e.target.checked,
                  },
                })
              }
            />
            LangSmith 链路追踪（需环境变量 Key）
          </label>
        </fieldset>
      </aside>
    )
  }

  if (selectedKind === 'edge') {
    if (selectedId.startsWith('exclusive-') || selectedId.startsWith('start-')) {
      return (
        <aside className="inspector empty">
          <p>
            {selectedId.startsWith('start-')
              ? '开始 → Task 启动连线。可在「开始」节点里改下游 Task。'
              : '专属 Task 连线为虚线（无箭头），不可改为通讯方向。'}
          </p>
        </aside>
      )
    }
    const ov = getEdgeOverride(base, selectedId)
    const kindLabel = selectedId.startsWith('collab-')
      ? 'Agent 协作连线'
      : selectedId.startsWith('ctx-')
        ? 'Task 依赖连线'
        : '连线'
    return (
      <aside className="inspector">
        <header>
          <span className="badge">Edge</span>
          <h3>{kindLabel}</h3>
        </header>
        <p className="muted small edge-id">{selectedId}</p>
        <p className="settings-tip compact">
          <strong>单向</strong>：单方向传递信息；<strong>双向</strong>：两端可通讯。
        </p>
        <div className="edge-dir-switch">
          <button
            type="button"
            className={ov.direction === 'uni' ? 'dir-card active' : 'dir-card'}
            onClick={() => onChange(setEdgeDirection(base, selectedId, 'uni'))}
          >
            <span className="dir-glyph">→</span>
            <strong>单向传信</strong>
            <span>信息只沿箭头方向流动</span>
          </button>
          <button
            type="button"
            className={ov.direction === 'bi' ? 'dir-card active' : 'dir-card'}
            onClick={() => onChange(setEdgeDirection(base, selectedId, 'bi'))}
          >
            <span className="dir-glyph">↔</span>
            <strong>双向通讯</strong>
            <span>两端可相互传递信息</span>
          </button>
        </div>
        {ov.direction === 'uni' && (
          <button
            type="button"
            className="ghost wide"
            onClick={() => onChange(toggleEdgeReversed(base, selectedId))}
          >
            反转单向方向 {ov.reversed ? '（已反转）' : ''}
          </button>
        )}
      </aside>
    )
  }

  if (selectedKind === 'team') {
    const id = selectedId.replace(/^team:/, '')
    const team = base.teams.find((t) => t.id === id)
    if (!team) {
      return (
        <aside className="inspector empty">
          <p>未找到该 Team，请点选画布上的节点。</p>
        </aside>
      )
    }
    const grants = team.grants ?? emptyGrants()
    return (
      <aside className="inspector">
        <header>
          <span className="badge team">Team</span>
          <h3>{team.name}</h3>
        </header>
        <label>
          名称
          <input
            value={team.name}
            onChange={(e) => onChange(updateTeam(base, id, { name: e.target.value }))}
          />
        </label>
        <label>
          说明
          <textarea
            rows={2}
            value={team.description}
            onChange={(e) => onChange(updateTeam(base, id, { description: e.target.value }))}
          />
        </label>
        <fieldset>
          <legend>成员 Agents</legend>
          {base.agents.length === 0 && <p className="muted small">暂无 Agent</p>}
          {base.agents.map((agent) => {
            const checked = agent.team_id === id || team.agent_ids.includes(agent.id)
            return (
              <label key={agent.id} className="check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(syncTeamMembership(base, agent.id, checked ? null : id))
                  }
                />
                {agent.is_manager ? '👑 ' : ''}
                {isClineAgent(agent) ? '⌘ ' : ''}
                {agent.id} — {agent.role}
                {agent.role_template_id ? ` [${agent.role_template_id}]` : ''}
              </label>
            )
          })}
        </fieldset>
        <div className="team-actions">
          <button
            type="button"
            className="ghost"
            onClick={() =>
              onChange(updateTeam(base, id, { collapsed: !team.collapsed }))
            }
          >
            {team.collapsed ? '标记为未折叠' : '标记折叠（内容在子画布）'}
          </button>
          <button type="button" className="ghost" onClick={() => onChange(duplicateTeam(base, id))}>
            复用 Team
          </button>
        </div>
        <GrantEditor
          title="Team 授权"
          hint="勾选后，该 Team 内所有 Agent 继承这些 Skill / 知识库 / 工具。折叠后画布只显示 Team 缩略卡，便于复用。"
          grants={grants}
          onChange={(next) => onChange(updateTeamGrants(base, id, next))}
        />
        <button type="button" className="ghost danger-btn" onClick={() => onChange(removeTeam(base, id))}>
          解散 Team
        </button>
      </aside>
    )
  }

  if (selectedKind === 'agent') {
    const id = selectedId.replace(/^agent:/, '')
    const agent = base.agents.find((a) => a.id === id)
    if (!agent) {
      return (
        <aside className="inspector empty">
          <p>未找到该 Agent，请点选画布上的节点。</p>
        </aside>
      )
    }
    const inherited = effectiveGrants(base, id)
    const cline = isClineAgent(agent)
    return (
      <aside className="inspector">
        <header>
          <span className={cline ? 'badge cline' : 'badge'}>{cline ? 'Cline' : 'Agent'}</span>
          <h3>{agent.id}</h3>
        </header>
        {cline && (
          <p className="settings-tip compact">
            专职编码个体：探索 → 编辑 → Shell 验证。编码类 Task 应指派给本 Agent。
          </p>
        )}
        <label>
          所属 Team
          <select
            value={agent.team_id ?? ''}
            onChange={(e) =>
              onChange(syncTeamMembership(base, id, e.target.value || null))
            }
          >
            <option value="">（未编组）</option>
            {base.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <input
            value={agent.role}
            onChange={(e) => onChange(updateAgent(base, id, { role: e.target.value }))}
          />
        </label>
        <label>
          Goal
          <textarea
            rows={3}
            value={agent.goal}
            onChange={(e) => onChange(updateAgent(base, id, { goal: e.target.value }))}
          />
        </label>
        <label>
          Backstory
          <textarea
            rows={4}
            value={agent.backstory}
            onChange={(e) => onChange(updateAgent(base, id, { backstory: e.target.value }))}
          />
        </label>
        <GrantEditor
          title="Agent 专属授权"
          hint="与 Team 授权合并生效（并集）。下方列出当前有效授权。"
          grants={{
            tools: agent.tools ?? [],
            skills: agent.skills ?? [],
            knowledge: agent.knowledge ?? [],
          }}
          onChange={(next) =>
            onChange(
              updateAgent(base, id, {
                tools: next.tools,
                skills: next.skills,
                knowledge: next.knowledge,
              }),
            )
          }
        />
        <div className="grant-effective">
          <p className="grant-title">当前有效授权</p>
          <p className="muted small">
            工具：{inherited.tools.length ? inherited.tools.join(', ') : '无'}
          </p>
          <p className="muted small">
            Skills：{inherited.skills.length ? inherited.skills.join(', ') : '无'}
          </p>
          <p className="muted small">
            知识库：{inherited.knowledge.length ? inherited.knowledge.join(', ') : '无'}
          </p>
        </div>
      </aside>
    )
  }

  if (selectedKind !== 'task') {
    return (
      <aside className="inspector empty">
        <p>在画布上选择 开始 / Team / Agent / Task / 连线 以编辑。</p>
      </aside>
    )
  }

  const id = selectedId.replace(/^task:/, '')
  const task = base.tasks.find((t) => t.id === id)
  if (!task) {
    return (
      <aside className="inspector empty">
        <p>未找到该 Task，请点选画布上的节点。</p>
      </aside>
    )
  }

  return (
    <aside className="inspector">
      <header>
        <span className="badge task">Task</span>
        <h3>{task.id}</h3>
      </header>
      <label>
        负责 Agent
        <select
          value={task.agent_id}
          onChange={(e) => onChange(updateTask(base, id, { agent_id: e.target.value }))}
        >
          {base.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id} — {a.role}
              {a.team_id ? ` [${a.team_id}]` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Description
        <textarea
          rows={4}
          value={task.description}
          onChange={(e) => onChange(updateTask(base, id, { description: e.target.value }))}
        />
      </label>
      <label>
        Expected Output
        <textarea
          rows={3}
          value={task.expected_output}
          onChange={(e) => onChange(updateTask(base, id, { expected_output: e.target.value }))}
        />
      </label>
      <fieldset className="schedule-fields">
        <legend>定时器</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={!!task.schedule?.enabled}
            onChange={(e) => {
              if (e.target.checked) {
                onChange(
                  updateTask(base, id, {
                    schedule: task.schedule ?? defaultSchedule(),
                  }),
                )
              } else {
                onChange(
                  updateTask(base, id, {
                    schedule: task.schedule
                      ? { ...task.schedule, enabled: false }
                      : null,
                  }),
                )
              }
            }}
          />
          启用定时任务
        </label>
        {task.schedule?.enabled && (
          <TaskScheduleEditor
            schedule={task.schedule}
            onApply={(next) =>
              onChange(updateTask(base, id, { schedule: next }))
            }
          />
        )}
      </fieldset>
      <GrantEditor
        title="Task 工具"
        hint="任务级工具会叠加在执行该任务时。虚线（无箭头）表示该 Task 为 Agent 专属。"
        sections={['tools']}
        grants={{ tools: task.tools ?? [], skills: [], knowledge: [] }}
        onChange={(next) => onChange(updateTask(base, id, { tools: next.tools }))}
      />
    </aside>
  )
}
