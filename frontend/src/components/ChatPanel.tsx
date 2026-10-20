import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatMessage, ClarifyingQuestion, PipelineStage } from '../types'
import { StageProgress } from './StageProgress'

const PROMPTS = [
  '我需要一个能研究最新 AI 进展并生成摘要报告的 crew',
  '分析财经新闻并给出投资建议',
  '抓取竞品官网并对比功能差异',
]

type Props = {
  messages: ChatMessage[]
  thoughts: string[]
  loading: boolean
  onSend: (text: string) => void
  brandHero?: boolean
  workflowTitle?: string | null
  onOpenWorkflow?: () => void
  /** Current interview question — options fused into the composer */
  presetQuestion?: ClarifyingQuestion | null
  presetIndex?: number
  presetTotal?: number
  onPickPreset?: (option: string) => void
  onSkipPreset?: () => void
  stages?: PipelineStage[]
}

export function ChatPanel({
  messages,
  thoughts,
  loading,
  onSend,
  brandHero,
  workflowTitle,
  onOpenWorkflow,
  presetQuestion,
  presetIndex = 0,
  presetTotal = 0,
  onPickPreset,
  onSkipPreset,
  stages = [],
}: Props) {
  const [text, setText] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const FALLBACK_OPTS = ['按推荐方案继续', '我再补充细节', '先生成草稿计划']
  const presetOptions =
    (presetQuestion?.options?.length ?? 0) >= 2
      ? presetQuestion!.options
      : FALLBACK_OPTS
  // Always show interview chrome when a question is queued (never gate on options)
  const showPreset = !loading && !!presetQuestion
  const showStages = stages.length > 0 && (loading || stages.some((s) => s.status !== 'pending'))

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, workflowTitle, showPreset, presetIndex, stages])

  function submit(e: FormEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value || loading) return
    onSend(value)
    setText('')
  }

  return (
    <section className={`chat-panel ${brandHero ? 'hero' : ''}`}>
      {brandHero && messages.length === 0 && (
        <div className="chat-hero">
          <p className="brand">Crew Studio</p>
          <h1>用对话搭建多智能体工作流</h1>
          <p className="lede">
            描述目标后，助手会整理问题并逐题确认（可跳过），再生成计划。
          </p>
          <div className="prompt-row">
            {PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                className="chip"
                onClick={() => onSend(p)}
                disabled={loading}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="messages">
        {messages.map((m, i) => (
          <div key={`${m.role}-${i}`} className={`bubble ${m.role}`}>
            <span className="who">{m.role === 'user' ? '你' : '助手'}</span>
            <p>{m.content}</p>
          </div>
        ))}

        {showStages && (
          <div className="bubble assistant stage-bubble">
            <span className="who">过程</span>
            <StageProgress
              stages={stages}
              live={loading && stages.some((s) => s.status === 'running')}
            />
            {thoughts[0] && loading && <p className="stage-thought">{thoughts[0]}</p>}
          </div>
        )}

        {loading && !showStages && (
          <div className="bubble assistant pending">
            <span className="who">助手</span>
            <p className="typing">处理中…</p>
          </div>
        )}

        {workflowTitle && onOpenWorkflow && (
          <div className="bubble assistant workflow-entry">
            <span className="who">工作流</span>
            <p>
              计划「{workflowTitle}」已就绪，可打开工作流继续编辑与沙箱运行。
            </p>
            <button type="button" className="primary" onClick={onOpenWorkflow}>
              打开工作流
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className={`composer-shell${showPreset ? ' has-interview' : ''}`}>
        {showPreset && (
          <div className="composer-interview" role="group" aria-label="澄清问题">
            <div className="composer-interview-head">
              <span className="preset-step">
                问题 {presetIndex + 1}/{presetTotal}
              </span>
              <button
                type="button"
                className="ghost compact"
                disabled={loading}
                onClick={() => onSkipPreset?.()}
              >
                跳过
              </button>
            </div>
            <p className="composer-interview-q">{presetQuestion!.prompt}</p>
            <div className="composer-options">
              {presetOptions.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className="composer-option"
                  disabled={loading}
                  onClick={() => onPickPreset?.(opt)}
                >
                  {opt}
                </button>
              ))}
            </div>
          </div>
        )}

        <form className="composer" onSubmit={submit}>
          <textarea
            rows={2}
            placeholder={
              showPreset
                ? '点选上方选项，或在此输入后发送…'
                : '描述你想解决的问题…'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit(e)
              }
            }}
          />
          <button
            type="submit"
            className="primary"
            disabled={loading || !text.trim()}
          >
            {loading ? '处理中…' : '发送'}
          </button>
        </form>
      </div>
    </section>
  )
}
