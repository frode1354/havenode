export type MdDocCard = {
  id: string
  title: string
  preview: string
  markdown: string
  kind: 'final' | 'task' | 'log'
  meta?: string
}

const TABLE_SEP_RE = /\|(?:\s*:?-+:?\s*\|)+/

function countTableCols(sep: string): number {
  const pipes = (sep.match(/\|/g) || []).length
  return Math.max(1, pipes - 1)
}

function chunkCellsToRows(segment: string, colCount: number): string[] {
  const parts = segment.split('|').map((p) => p.trim())
  if (parts[0] === '') parts.shift()
  if (parts.length && parts[parts.length - 1] === '') parts.pop()

  const rows: string[] = []
  let current: string[] = []
  for (const p of parts) {
    // Empty token between finished rows is glue from "| | next |"
    if (p === '' && current.length === 0) continue
    current.push(p)
    if (current.length === colCount) {
      rows.push(`| ${current.join(' | ')} |`)
      current = []
    }
  }
  if (current.length > 0 && !current.every((c) => c === '')) {
    while (current.length < colCount) current.push('')
    rows.push(`| ${current.join(' | ')} |`)
  }
  return rows
}

/** Split one glued table line into header / separator / data rows. */
function splitGluedTableLine(line: string): string[] {
  const trimmed = line.trim()
  const sepMatch = trimmed.match(TABLE_SEP_RE)
  if (!sepMatch || sepMatch.index === undefined) return [line]

  const sep = sepMatch[0].trim()
  const colCount = countTableCols(sep)
  const before = trimmed.slice(0, sepMatch.index).trim()
  let after = trimmed.slice(sepMatch.index + sepMatch[0].length).trim()
  if (after.startsWith('|')) {
    // ok
  } else if (after) {
    after = `| ${after}`
  }

  const rows: string[] = []
  if (before.includes('|')) rows.push(...chunkCellsToRows(before, colCount))
  rows.push(sep.endsWith('|') ? sep : `${sep}|`)
  if (after.includes('|')) rows.push(...chunkCellsToRows(after, colCount))
  return rows.length ? rows : [line]
}

/**
 * Fix GFM tables that lost newlines (common in LLM output), e.g.
 * `| a | b | |---|---| | c | d |` → proper multi-line table.
 */
export function normalizeMarkdownTables(markdown: string): string {
  if (!markdown.includes('|')) return markdown

  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []

  for (const line of lines) {
    const glued = line.includes('|') && TABLE_SEP_RE.test(line) && /\|\s*\|/.test(line)
    if (glued || (line.includes('|') && (line.match(/\|/g) || []).length > 8 && !line.includes('\n'))) {
      // Glued table (separator + rows on one line) or a very wide single-line table
      if (TABLE_SEP_RE.test(line) && (line.match(/\|/g) || []).length >= 6) {
        out.push(...splitGluedTableLine(line))
        continue
      }
    }
    out.push(line)
  }

  let text = out.join('\n')
  // Ensure blank line before a table block
  text = text.replace(/([^\n])\n(\|[^\n]+\|\n\|[\s:|-]+\|)/g, '$1\n\n$2')
  return text
}

/** Prepare markdown for display (table fixes, trim). */
export function prepareMarkdown(markdown: string): string {
  return normalizeMarkdownTables(markdown.trim())
}

function stripMd(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractTitle(markdown: string, fallback: string): string {
  const heading = markdown.match(/^#{1,3}\s+(.+)$/m)
  if (heading?.[1]) return heading[1].trim()
  const firstLine = markdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (firstLine) {
    const clean = stripMd(firstLine)
    if (clean) return clean.slice(0, 48)
  }
  return fallback
}

export function extractPreview(markdown: string, max = 120): string {
  const plain = stripMd(markdown)
  if (!plain) return '（空文档）'
  return plain.length > max ? `${plain.slice(0, max)}…` : plain
}

export function buildRunDocCards(result: {
  result?: string
  task_results?: { task_id: string; agent: string; output: string }[]
}): MdDocCard[] {
  const cards: MdDocCard[] = []
  if (result.result?.trim()) {
    cards.push({
      id: 'final',
      title: extractTitle(result.result, '最终结果'),
      preview: extractPreview(result.result),
      markdown: result.result,
      kind: 'final',
      meta: 'Final',
    })
  }
  for (const tr of result.task_results || []) {
    if (!tr.output?.trim()) continue
    cards.push({
      id: `task:${tr.task_id}`,
      title: extractTitle(tr.output, tr.task_id),
      preview: extractPreview(tr.output),
      markdown: tr.output,
      kind: 'task',
      meta: tr.agent ? `${tr.task_id} · ${tr.agent}` : tr.task_id,
    })
  }
  return cards
}
