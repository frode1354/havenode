/** Helpers retained; questioning UX is composer one-by-one in ChatPanel. */

export type ClarifyAnswer = {
  id: string
  prompt: string
  selected: string[]
  custom: string
}

export function formatClarifyAnswers(answers: ClarifyAnswer[]): string {
  const lines = answers.map((a, i) => {
    const parts: string[] = []
    if (a.selected.length) parts.push(`选择：${a.selected.join('、')}`)
    if (a.custom) parts.push(`补充：${a.custom}`)
    return `${i + 1}. ${a.prompt}\n${parts.join('\n') || '（未作答）'}`
  })
  return `澄清回答：\n${lines.join('\n\n')}`
}
