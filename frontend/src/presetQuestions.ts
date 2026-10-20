import type { ClarifyingQuestion } from './types'

export type InterviewAnswer = { id: string; prompt: string; value: string }

/** Merge goal + interview answers for the force_plan request. */
export function formatInterviewContext(
  goalMessages: string,
  answers: InterviewAnswer[],
): string {
  if (answers.length === 0) return goalMessages
  const lines = answers.map((a) => `- ${a.prompt} → ${a.value}`)
  return `${goalMessages}\n\n【澄清回答】\n${lines.join('\n')}`
}

export function ensureQuestionOptions(q: ClarifyingQuestion): ClarifyingQuestion {
  const options =
    q.options?.length >= 2
      ? q.options
      : ['按推荐方案继续', '我再补充细节', '先生成草稿计划']
  return { ...q, options, allow_custom: q.allow_custom !== false }
}
