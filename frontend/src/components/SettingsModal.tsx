import { useEffect, useState } from 'react'
import { fetchSettings, pushSettings } from '../api'
import {
  PROVIDER_PRESETS,
  activeApi,
  applyTheme,
  defaultApiProfile,
  makeId,
  type ApiProfile,
  type KnowledgeItem,
  type ModelProvider,
  type SkillItem,
  type StudioSettings,
  type ThemeMode,
} from '../settings'

type Props = {
  open: boolean
  settings: StudioSettings
  onClose: () => void
  onSave: (next: StudioSettings) => void
}

type Tab = 'appearance' | 'model' | 'skills' | 'tools' | 'knowledge' | 'about'

export function SettingsModal({ open, settings, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(settings)
  const [tab, setTab] = useState<Tab>('appearance')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [keyEdits, setKeyEdits] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    setDraft(settings)
    setKeyEdits({})
    setMessage(null)
    setTab('appearance')
  }, [open, settings])

  if (!open) return null

  const current = activeApi(draft)

  function setTheme(theme: ThemeMode) {
    setDraft((d) => ({ ...d, theme }))
    applyTheme(theme)
  }

  function updateApi(id: string, patch: Partial<ApiProfile>) {
    setDraft((d) => ({
      ...d,
      apis: d.apis.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }))
  }

  function setProvider(id: string, provider: ModelProvider) {
    const preset = PROVIDER_PRESETS[provider]
    updateApi(id, {
      provider,
      model: preset.model,
      baseUrl: preset.baseUrl,
    })
  }

  function addApi() {
    const profile = defaultApiProfile()
    profile.label = `API ${draft.apis.length + 1}`
    setDraft((d) => ({
      ...d,
      apis: [...d.apis, profile],
      activeApiId: profile.id,
    }))
  }

  function removeApi(id: string) {
    if (draft.apis.length <= 1) {
      setMessage('至少保留一条 API 配置')
      return
    }
    const apis = draft.apis.filter((a) => a.id !== id)
    setDraft((d) => ({
      ...d,
      apis,
      activeApiId: d.activeApiId === id ? apis[0].id : d.activeApiId,
    }))
  }

  async function handleSave() {
    setSaving(true)
    setMessage(null)
    const apis = draft.apis.map((a) => ({
      ...a,
      apiKey: (keyEdits[a.id] || '').trim() || a.apiKey,
    }))
    const next: StudioSettings = { ...draft, apis }
    try {
      await pushSettings(next)
      onSave(next)
      setMessage('设置已保存并同步后端')
    } catch (e) {
      onSave(next)
      setMessage(
        e instanceof Error
          ? `已保存到本地；同步后端失败：${e.message}`
          : '已保存到本地',
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleReloadFromServer() {
    try {
      const remote = await fetchSettings()
      setDraft(remote)
      setMessage('已从后端加载配置')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '加载失败')
    }
  }

  return (
    <div className="modal-backdrop settings-backdrop" role="dialog" aria-modal="true">
      <div className="settings-panel animate-in">
        <header className="settings-header">
          <div>
            <p className="eyebrow">Settings</p>
            <h2>设置</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav">
            {(
              [
                ['appearance', '外观'],
                ['model', '模型 / API'],
                ['skills', '本地 Skills'],
                ['tools', '工具'],
                ['knowledge', '知识库'],
                ['about', '说明'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={tab === id ? 'settings-nav-item active' : 'settings-nav-item'}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <section className="settings-content">
            {tab === 'appearance' && (
              <div className="settings-section">
                <h3>明暗色调</h3>
                <p className="settings-tip">
                  <strong>浅色</strong>：Coze 白底；<strong>暗金</strong>：炭黑 + 金色；
                  <strong>高级黑</strong>：纯黑 + 冷银高光。保存后全局生效。
                </p>
                <div className="theme-switch three">
                  <button
                    type="button"
                    className={draft.theme === 'light' ? 'theme-card active' : 'theme-card'}
                    onClick={() => setTheme('light')}
                  >
                    <span className="theme-preview light" />
                    浅色
                  </button>
                  <button
                    type="button"
                    className={draft.theme === 'dark' ? 'theme-card active' : 'theme-card'}
                    onClick={() => setTheme('dark')}
                  >
                    <span className="theme-preview dark" />
                    暗金
                  </button>
                  <button
                    type="button"
                    className={draft.theme === 'black' ? 'theme-card active' : 'theme-card'}
                    onClick={() => setTheme('black')}
                  >
                    <span className="theme-preview black" />
                    高级黑
                  </button>
                </div>
                <h3>可选：本机编辑器 CLI</h3>
                <p className="settings-tip">
                  画布上的 <strong>Cline</strong> 是编码个体（沙箱内跑工具）。若需额外用本机 IDE 打开产物目录，可配置 CLI（默认{' '}
                  <code>cursor</code>）。
                </p>
                <label>
                  编辑器命令
                  <input
                    value={draft.editorCommand || 'cursor'}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, editorCommand: e.target.value.trim() || 'cursor' }))
                    }
                    placeholder="cursor / code / 可执行文件路径"
                  />
                </label>
              </div>
            )}

            {tab === 'model' && (
              <div className="settings-section">
                <div className="section-head">
                  <div>
                    <h3>模型来源（可添加多个 API）</h3>
                    <p className="settings-tip">
                      可配置多组 Key / 模型，切换「当前使用」后保存。沙箱与对话均使用当前 API。
                      产物目录：<code>backend/tmp/&lt;项目标题&gt;/</code>
                    </p>
                  </div>
                  <button type="button" className="secondary compact" onClick={addApi}>
                    添加 API
                  </button>
                </div>

                <div className="api-list">
                  {draft.apis.map((api) => (
                    <div
                      key={api.id}
                      className={
                        api.id === draft.activeApiId ? 'settings-card api-card active' : 'settings-card api-card'
                      }
                    >
                      <div className="api-card-head">
                        <label className="check-row">
                          <input
                            type="radio"
                            name="activeApi"
                            checked={api.id === draft.activeApiId}
                            onChange={() => setDraft((d) => ({ ...d, activeApiId: api.id }))}
                          />
                          当前使用
                        </label>
                        <button type="button" className="ghost compact" onClick={() => removeApi(api.id)}>
                          删除
                        </button>
                      </div>
                      <label className="field">
                        <span>名称</span>
                        <input
                          value={api.label}
                          onChange={(e) => updateApi(api.id, { label: e.target.value })}
                          placeholder="例如：DeepSeek 工作号"
                        />
                      </label>
                      <label className="field">
                        <span>提供商</span>
                        <select
                          value={api.provider}
                          onChange={(e) => setProvider(api.id, e.target.value as ModelProvider)}
                        >
                          {Object.entries(PROVIDER_PRESETS).map(([id, p]) => (
                            <option key={id} value={id}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="settings-tip">{PROVIDER_PRESETS[api.provider].tip}</p>
                      <label className="field">
                        <span>模型 ID</span>
                        <input
                          value={api.model}
                          onChange={(e) => updateApi(api.id, { model: e.target.value })}
                          placeholder="deepseek/deepseek-chat"
                        />
                      </label>
                      <label className="field">
                        <span>Base URL</span>
                        <input
                          value={api.baseUrl}
                          onChange={(e) => updateApi(api.id, { baseUrl: e.target.value })}
                          placeholder="https://api.deepseek.com/v1"
                        />
                      </label>
                      <label className="field">
                        <span>API Key（留空保留原值）</span>
                        <input
                          type="password"
                          value={keyEdits[api.id] ?? ''}
                          onChange={(e) =>
                            setKeyEdits((prev) => ({ ...prev, [api.id]: e.target.value }))
                          }
                          placeholder={api.apiKey ? '已配置（输入新值可覆盖）' : 'sk-...'}
                        />
                      </label>
                    </div>
                  ))}
                </div>

                <p className="settings-tip">
                  当前生效：<strong>{current.label}</strong> · {current.provider} · {current.model}
                </p>
                <button type="button" className="ghost" onClick={handleReloadFromServer}>
                  从后端重新加载
                </button>
              </div>
            )}

            {tab === 'skills' && (
              <div className="settings-section">
                <div className="section-head">
                  <div>
                    <h3>本地 Skills</h3>
                    <p className="settings-tip">
                      Skill 是本地可复用的能力说明/目录。启用后会注入计划生成上下文，便于 Agent 按规范执行。
                      路径可为相对仓库的文件夹，例如 <code>./skills/research-brief</code>。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary compact"
                    onClick={() => {
                      const item: SkillItem = {
                        id: makeId('skill'),
                        name: 'new-skill',
                        description: '',
                        path: './skills/new-skill',
                        enabled: true,
                      }
                      setDraft((d) => ({ ...d, skills: [...d.skills, item] }))
                    }}
                  >
                    添加
                  </button>
                </div>
                <div className="settings-list">
                  {draft.skills.map((skill, idx) => (
                    <div key={skill.id} className="settings-card">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={skill.enabled}
                          onChange={(e) => {
                            const skills = [...draft.skills]
                            skills[idx] = { ...skill, enabled: e.target.checked }
                            setDraft((d) => ({ ...d, skills }))
                          }}
                        />
                        启用
                      </label>
                      <input
                        value={skill.name}
                        onChange={(e) => {
                          const skills = [...draft.skills]
                          skills[idx] = { ...skill, name: e.target.value }
                          setDraft((d) => ({ ...d, skills }))
                        }}
                        placeholder="名称"
                      />
                      <input
                        value={skill.path}
                        onChange={(e) => {
                          const skills = [...draft.skills]
                          skills[idx] = { ...skill, path: e.target.value }
                          setDraft((d) => ({ ...d, skills }))
                        }}
                        placeholder="本地路径"
                      />
                      <textarea
                        rows={2}
                        value={skill.description}
                        onChange={(e) => {
                          const skills = [...draft.skills]
                          skills[idx] = { ...skill, description: e.target.value }
                          setDraft((d) => ({ ...d, skills }))
                        }}
                        placeholder="说明"
                      />
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            skills: d.skills.filter((s) => s.id !== skill.id),
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'tools' && (
              <div className="settings-section">
                <h3>工具</h3>
                <p className="settings-tip">
                  控制计划生成与沙箱可用工具。已禁用 WebsiteSearchTool（依赖 OpenAI 嵌入）。
                  搜索类请用 ScrapeWebsiteTool；文件写入会落到 <code>backend/tmp/</code>。
                </p>
                <div className="settings-list">
                  {draft.tools.map((tool, idx) => (
                    <label key={tool.id} className="tool-row">
                      <input
                        type="checkbox"
                        checked={tool.enabled}
                        onChange={(e) => {
                          const tools = [...draft.tools]
                          tools[idx] = { ...tool, enabled: e.target.checked }
                          setDraft((d) => ({ ...d, tools }))
                        }}
                      />
                      <span>
                        <strong>{tool.name}</strong>
                        <em>{tool.description}</em>
                        {tool.note ? <i className="tool-note">{tool.note}</i> : null}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {tab === 'knowledge' && (
              <div className="settings-section">
                <div className="section-head">
                  <div>
                    <h3>知识库</h3>
                    <p className="settings-tip">
                      添加本地文件、文件夹、URL 或文本片段。启用后会作为上下文提供给计划生成（非向量库检索）。
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary compact"
                    onClick={() => {
                      const item: KnowledgeItem = {
                        id: makeId('kb'),
                        name: '新知识源',
                        kind: 'text',
                        source: '',
                        enabled: true,
                      }
                      setDraft((d) => ({ ...d, knowledge: [...d.knowledge, item] }))
                    }}
                  >
                    添加
                  </button>
                </div>
                <div className="settings-list">
                  {draft.knowledge.length === 0 && (
                    <p className="muted small">暂无知识库条目。</p>
                  )}
                  {draft.knowledge.map((kb, idx) => (
                    <div key={kb.id} className="settings-card">
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={kb.enabled}
                          onChange={(e) => {
                            const knowledge = [...draft.knowledge]
                            knowledge[idx] = { ...kb, enabled: e.target.checked }
                            setDraft((d) => ({ ...d, knowledge }))
                          }}
                        />
                        启用
                      </label>
                      <input
                        value={kb.name}
                        onChange={(e) => {
                          const knowledge = [...draft.knowledge]
                          knowledge[idx] = { ...kb, name: e.target.value }
                          setDraft((d) => ({ ...d, knowledge }))
                        }}
                        placeholder="名称"
                      />
                      <select
                        value={kb.kind}
                        onChange={(e) => {
                          const knowledge = [...draft.knowledge]
                          knowledge[idx] = {
                            ...kb,
                            kind: e.target.value as KnowledgeItem['kind'],
                          }
                          setDraft((d) => ({ ...d, knowledge }))
                        }}
                      >
                        <option value="file">文件</option>
                        <option value="folder">文件夹</option>
                        <option value="url">URL</option>
                        <option value="text">文本</option>
                      </select>
                      <textarea
                        rows={3}
                        value={kb.source}
                        onChange={(e) => {
                          const knowledge = [...draft.knowledge]
                          knowledge[idx] = { ...kb, source: e.target.value }
                          setDraft((d) => ({ ...d, knowledge }))
                        }}
                        placeholder={
                          kb.kind === 'text'
                            ? '粘贴知识文本…'
                            : kb.kind === 'url'
                              ? 'https://...'
                              : '本地路径…'
                        }
                      />
                      <button
                        type="button"
                        className="ghost compact"
                        onClick={() =>
                          setDraft((d) => ({
                            ...d,
                            knowledge: d.knowledge.filter((k) => k.id !== kb.id),
                          }))
                        }
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === 'about' && (
              <div className="settings-section">
                <h3>必要设置说明</h3>
                <ul className="about-list">
                  <li>
                    <strong>模型 / API</strong>：至少配置一条可用 API（推荐 DeepSeek）。Key 仅存本机
                    localStorage 与 <code>backend/data/settings.json</code>，勿提交 git。
                  </li>
                  <li>
                    <strong>产物目录</strong>：沙箱运行结果写入{' '}
                    <code>backend/tmp/&lt;项目标题&gt;/</code>，不会散落到 backend 根目录。
                  </li>
                  <li>
                    <strong>Cline</strong>：画布资源栏的编码个体；编码 Task 指派给它。勿再使用已退役的编码 Agent Team。
                  </li>
                  <li>
                    <strong>工具</strong>：网页内容用 ScrapeWebsiteTool；不要启用 WebsiteSearchTool。
                  </li>
                  <li>
                    <strong>Skills / 知识库</strong>：用于增强计划生成上下文；不会自动上传云端。
                  </li>
                  <li>
                    <strong>主题</strong>：浅色 / 暗金 / 高级黑，在设置 → 外观中切换。
                  </li>
                  <li>
                    <strong>后端端口</strong>：默认 <code>8777</code>；前端通过 Vite 代理访问{' '}
                    <code>/api</code>。
                  </li>
                </ul>
              </div>
            )}
          </section>
        </div>

        <footer className="settings-footer">
          {message && <span className="settings-msg">{message}</span>}
          <div className="actions">
            <button type="button" className="ghost" onClick={onClose}>
              取消
            </button>
            <button type="button" className="primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
