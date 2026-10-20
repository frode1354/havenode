import type { AgentSpec, GrantSpec } from './types'

/** Stable role template id for the Cline coding individual. */
export const CLINE_ROLE_ID = 'cline'

export const CLINE_TOOLS = [
  'DirectoryReadTool',
  'FileReadTool',
  'FileWriterTool',
  'CodebaseGrepTool',
  'ProjectShellTool',
] as const

export const CLINE_BACKSTORY = [
  '你是 Cline：Crew 中的专职编码个体，负责实现、修改与验证代码。',
  '工作循环：探索仓库 → 精读相关文件 → 写入改动 → Shell 验证 → 失败再修。',
  '交付时说明改了哪些文件、如何验证；不要编造未执行的命令结果。',
].join('\n')

export function clineAgentGrants(): GrantSpec {
  return {
    tools: [...CLINE_TOOLS],
    skills: [],
    knowledge: [],
  }
}

export function isClineAgent(agent: Pick<AgentSpec, 'id' | 'role_template_id'> | null | undefined): boolean {
  if (!agent) return false
  return agent.role_template_id === CLINE_ROLE_ID || agent.id === CLINE_ROLE_ID || agent.id.startsWith('cline_')
}

export function makeClineAgent(existingIds: string[]): AgentSpec {
  let id = CLINE_ROLE_ID
  if (existingIds.includes(id)) {
    let n = 2
    while (existingIds.includes(`cline_${n}`)) n += 1
    id = `cline_${n}`
  }
  return {
    id,
    role: 'Cline',
    goal: '完成分配的编码任务：实现功能、修复缺陷、补测试并验证可运行。',
    backstory: CLINE_BACKSTORY,
    tools: [...CLINE_TOOLS],
    skills: [],
    knowledge: [],
    team_id: null,
    is_manager: false,
    role_template_id: CLINE_ROLE_ID,
  }
}
