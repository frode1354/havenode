import { useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { MdDocCard } from '../mdUtils'
import { prepareMarkdown } from '../mdUtils'

type Props = {
  doc: MdDocCard | null
  onClose: () => void
}

export function MarkdownReaderModal({ doc, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  if (!doc) return null

  const source = prepareMarkdown(doc.markdown)

  async function handleCopy() {
    if (!doc) return
    try {
      await navigator.clipboard.writeText(source)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  function handleDownload() {
    if (!doc) return
    const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sanitizeFilename(doc.title)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Portal to body so nested modals (observatory z=80, workflow) cannot cover the reader
  return createPortal(
    <div className="modal-backdrop reader-backdrop" role="dialog" aria-modal="true">
      <div className="reader-panel animate-in">
        <header className="reader-header">
          <div>
            <p className="eyebrow">{doc.meta || 'Markdown'}</p>
            <h2>{doc.title}</h2>
          </div>
          <div className="reader-actions">
            <button type="button" className="ghost" onClick={handleCopy}>
              {copied ? '已复制' : '复制'}
            </button>
            <button type="button" className="secondary" onClick={handleDownload}>
              下载 .md
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>
        <article className="md-prose">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <div className="md-table-wrap">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {source}
          </ReactMarkdown>
        </article>
      </div>
    </div>,
    document.body,
  )
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'document'
}
