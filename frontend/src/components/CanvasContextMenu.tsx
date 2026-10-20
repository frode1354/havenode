export type ContextTarget =
  | { kind: 'pane' }
  | { kind: 'team'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'edge'; id: string }

export type ContextAction =
  | 'add-agent'
  | 'add-task'
  | 'add-team'
  | 'add-schedule'
  | 'edit'
  | 'delete'
  | 'duplicate'
  | 'duplicate-team'
  | 'toggle-collapse'
  | 'add-member'
  | 'history'
  | 'exclusive-task'
  | 'edge-uni'
  | 'edge-bi'
  | 'edge-reverse'

type Props = {
  x: number
  y: number
  target: ContextTarget
  onAction: (action: ContextAction) => void
  onClose: () => void
}

export function CanvasContextMenu({ x, y, target, onAction, onClose }: Props) {
  const items: { action: ContextAction; label: string; danger?: boolean }[] = []

  if (target.kind === 'pane') {
    items.push(
      { action: 'add-team', label: '新增 Team' },
      { action: 'add-agent', label: '新增 Agent' },
      { action: 'add-task', label: '新增 Task' },
      { action: 'add-schedule', label: '新增定时任务' },
    )
  } else if (target.kind === 'team') {
    items.push(
      { action: 'edit', label: '编辑 Team' },
      { action: 'toggle-collapse', label: '折叠进子画布' },
      { action: 'add-member', label: '新增成员 Agent' },
      { action: 'duplicate-team', label: '复用 Team（复制）' },
      { action: 'delete', label: '删除 Team', danger: true },
    )
  } else if (target.kind === 'agent') {
    items.push(
      { action: 'edit', label: '编辑 Agent' },
      { action: 'exclusive-task', label: '新增专属 Task' },
      { action: 'add-schedule', label: '新增定时任务' },
      { action: 'duplicate', label: '复制 Agent' },
      { action: 'history', label: '查看输出历史' },
      { action: 'delete', label: '删除 Agent', danger: true },
    )
  } else if (target.kind === 'edge') {
    items.push(
      { action: 'edit', label: '编辑连线' },
      { action: 'edge-uni', label: '改为单向传信 →' },
      { action: 'edge-bi', label: '改为双向通讯 ↔' },
      { action: 'edge-reverse', label: '反转单向方向' },
    )
  } else {
    items.push(
      { action: 'edit', label: '编辑 Task' },
      { action: 'add-schedule', label: '设为 / 编辑定时' },
      { action: 'delete', label: '删除 Task', danger: true },
    )
  }

  return (
    <div
      className="canvas-context-menu"
      style={{ left: x, top: y }}
      role="menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          className={item.danger ? 'danger' : undefined}
          role="menuitem"
          onClick={() => {
            onAction(item.action)
            onClose()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
