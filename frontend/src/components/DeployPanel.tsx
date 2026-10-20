import { useCallback, useEffect, useState } from 'react'
import {
  deployToAmp,
  downloadBlob,
  exportZip,
  listDeployments,
  type DeploymentRecord,
} from '../api'
import type { CrewPlan } from '../types'
import { DeployObservatory } from './DeployObservatory'

type Props = {
  open: boolean
  plan: CrewPlan
  onClose: () => void
}

function statusLabel(s: string): string {
  switch (s) {
    case 'online':
      return '已推送 AMP'
    case 'local':
      return '本地可用'
    case 'needs_login':
      return '需登录 AMP'
    case 'deploying':
      return '推送中'
    case 'failed':
      return '推送失败'
    case 'prepared':
      return '包已就绪'
    default:
      return s
  }
}

export function DeployPanel({ open, plan, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [latest, setLatest] = useState<DeploymentRecord | null>(null)
  const [history, setHistory] = useState<DeploymentRecord[]>([])
  const [consoleUrl, setConsoleUrl] = useState('https://app.crewai.com')
  const [obsOpen, setObsOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await listDeployments(plan.name)
      setHistory(res.deployments || [])
      setConsoleUrl(res.amp_console || 'https://app.crewai.com')
      if (res.deployments?.[0]) setLatest(res.deployments[0])
    } catch {
      /* ignore */
    }
  }, [plan.name])

  useEffect(() => {
    if (!open) return
    void refresh()
  }, [open, refresh])

  if (!open) return null

  async function handleDeploy(push: boolean) {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const res = await deployToAmp(plan, push)
      setLatest(res.deployment)
      setMessage(res.deployment.message)
      await refresh()
      // Auto-open local observatory so用户能立刻看画布/手动跑
      if (res.deployment.id) setObsOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleDownloadZip() {
    setBusy(true)
    setError(null)
    try {
      const blob = await exportZip(plan)
      downloadBlob(blob, `${plan.name}-amp.zip`)
      setMessage('已下载 AMP 兼容 ZIP')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const canObserve = !!latest?.id

  return (
    <>
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="部署到平台">
        <div className="modal-panel schedule-panel animate-in">
          <header className="modal-header">
            <div>
              <p className="eyebrow">Deploy</p>
              <h2>部署与观测</h2>
              <p className="muted">
                先生成本地可跑包（观测台：手动跑 + 画布）。AMP 云端需{' '}
                <code>crewai login</code> 后才能看到在线服务。
              </p>
            </div>
            <button type="button" className="ghost" onClick={onClose} disabled={busy}>
              关闭
            </button>
          </header>

          <div className="schedule-body">
            <section className="schedule-card">
              <h3>{plan.title}</h3>
              <div className="deploy-actions">
                <button
                  type="button"
                  className="primary wide"
                  disabled={busy}
                  onClick={() => void handleDeploy(false)}
                >
                  {busy ? '处理中…' : '生成包并打开本地观测台'}
                </button>
                <button
                  type="button"
                  className="secondary wide"
                  disabled={busy || !canObserve}
                  onClick={() => setObsOpen(true)}
                >
                  打开本地观测台（画布 / 手动跑）
                </button>
                <button
                  type="button"
                  className="secondary wide"
                  disabled={busy}
                  onClick={() => void handleDeploy(true)}
                >
                  一键推送到 AMP（需 login）
                </button>
                <button
                  type="button"
                  className="ghost wide"
                  disabled={busy}
                  onClick={() => void handleDownloadZip()}
                >
                  下载 AMP ZIP
                </button>
                <a
                  className="ghost wide deploy-link"
                  href={consoleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开 AMP 控制台
                </a>
              </div>
              {(latest?.status === 'needs_login' ||
                latest?.cli_log?.toLowerCase().includes('crewai login')) && (
                <p className="muted small" style={{ marginTop: '0.75rem' }}>
                  当前未登录 AMP。终端执行 <code>crewai login</code> 完成注册/登录后，再点「一键推送到
                  AMP」。在此之前请用「本地观测台」手动跑并观看框架/画布。
                </p>
              )}
            </section>

            {latest && (
              <section className="schedule-card">
                <h3>当前部署</h3>
                <p>
                  <strong>{statusLabel(latest.status)}</strong>
                  {typeof latest.run_count === 'number' ? ` · 本地已跑 ${latest.run_count} 次` : ''}
                </p>
                <p className="muted small">{latest.message}</p>
                {latest.package_dir && (
                  <p className="muted small">
                    本地包：<code>{latest.package_dir}</code>
                  </p>
                )}
                {latest.deployment_url && (
                  <p className="muted small">
                    AMP URL：{' '}
                    <a href={latest.deployment_url} target="_blank" rel="noreferrer">
                      {latest.deployment_url}
                    </a>
                  </p>
                )}
                {latest.cli_log && (
                  <pre className="deploy-log">{latest.cli_log.slice(-3500)}</pre>
                )}
              </section>
            )}

            {history.length > 1 && (
              <section className="schedule-card">
                <h3>历史</h3>
                <ul className="schedule-job-list">
                  {history.slice(0, 6).map((d) => (
                    <li key={d.id} className="schedule-job">
                      <div>
                        <strong>{statusLabel(d.status)}</strong>
                        <p className="muted small">{d.message}</p>
                      </div>
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() => {
                          setLatest(d)
                          setObsOpen(true)
                        }}
                      >
                        观测
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {message && <p className="schedule-msg ok">{message}</p>}
            {error && <p className="schedule-msg err">{error}</p>}
          </div>
        </div>
      </div>

      <DeployObservatory
        open={obsOpen}
        deploymentId={latest?.id ?? null}
        fallbackPlan={plan}
        onClose={() => setObsOpen(false)}
      />
    </>
  )
}
