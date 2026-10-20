export type ThemeMode = 'light' | 'dark' | 'black'

export type ModelProvider = 'deepseek' | 'openai' | 'ollama' | 'custom'

export type ApiProfile = {
  id: string
  label: string
  provider: ModelProvider
  model: string
  apiKey: string
  baseUrl: string
}

/** @deprecated kept for migration */
export type ModelConfig = Omit<ApiProfile, 'id' | 'label'>

export type SkillItem = {
  id: string
  name: string
  description: string
  path: string
  enabled: boolean
}

export type ToolItem = {
  id: string
  name: string
  description: string
  enabled: boolean
  note?: string
}

export type KnowledgeItem = {
  id: string
  name: string
  kind: 'file' | 'folder' | 'url' | 'text'
  source: string
  enabled: boolean
}

export type StudioSettings = {
  theme: ThemeMode
  /** currently selected API profile id */
  activeApiId: string
  apis: ApiProfile[]
  /** legacy single model — migrated into apis */
  model?: ModelConfig
  skills: SkillItem[]
  tools: ToolItem[]
  knowledge: KnowledgeItem[]
  /** CLI to open workspace for Cline: cursor / code / full path */
  editorCommand: string
}

const STORAGE_KEY = 'crew-studio.settings.v2'

export const DEFAULT_TOOLS: ToolItem[] = [
  {
    id: 'ScrapeWebsiteTool',
    name: 'ScrapeWebsiteTool',
    description: '抓取网页正文（不依赖 OpenAI 嵌入）',
    enabled: true,
  },
  {
    id: 'SerperDevTool',
    name: 'SerperDevTool',
    description: 'Google 搜索（需 SERPER_API_KEY）',
    enabled: false,
    note: '需额外配置 SERPER_API_KEY',
  },
  {
    id: 'FileReadTool',
    name: 'FileReadTool',
    description: '读取本地文件',
    enabled: true,
  },
  {
    id: 'FileWriterTool',
    name: 'FileWriterTool',
    description: '写入本地文件（沙箱会写到 tmp 专属目录）',
    enabled: true,
  },
  {
    id: 'DirectoryReadTool',
    name: 'DirectoryReadTool',
    description: '列出目录内容',
    enabled: true,
  },
  {
    id: 'CodeInterpreterTool',
    name: 'CodeInterpreterTool',
    description: '代码解释执行',
    enabled: false,
  },
]

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function defaultApiProfile(): ApiProfile {
  return {
    id: makeId('api'),
    label: 'DeepSeek 主账号',
    provider: 'deepseek',
    model: 'deepseek/deepseek-chat',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
  }
}

const firstApi = defaultApiProfile()

export const DEFAULT_SETTINGS: StudioSettings = {
  theme: 'light',
  activeApiId: firstApi.id,
  apis: [firstApi],
  skills: [
    {
      id: 'skill_research',
      name: 'research-brief',
      description: '研究简报撰写 skill（本地）',
      path: './skills/research-brief',
      enabled: true,
    },
  ],
  tools: DEFAULT_TOOLS,
  knowledge: [],
  editorCommand: 'cursor',
}

export const PROVIDER_PRESETS: Record<
  ModelProvider,
  { label: string; model: string; baseUrl: string; tip: string }
> = {
  deepseek: {
    label: 'DeepSeek',
    model: 'deepseek/deepseek-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    tip: '在 platform.deepseek.com 创建 API Key；模型格式 deepseek/deepseek-chat',
  },
  openai: {
    label: 'OpenAI',
    model: 'openai/gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1',
    tip: '需 OPENAI 兼容 Key；模型格式 openai/gpt-4o-mini',
  },
  ollama: {
    label: 'Ollama（本地）',
    model: 'ollama/llama3.2',
    baseUrl: 'http://127.0.0.1:11434',
    tip: '本机需先启动 ollama serve；一般无需填写 API Key',
  },
  custom: {
    label: '自定义 OpenAI 兼容',
    model: 'openai/gpt-4o-mini',
    baseUrl: '',
    tip: '任意 OpenAI Compatible 网关；请填写完整 Base URL',
  },
}

export function activeApi(settings: StudioSettings): ApiProfile {
  return (
    settings.apis.find((a) => a.id === settings.activeApiId) ||
    settings.apis[0] ||
    defaultApiProfile()
  )
}

function migrate(parsed: Record<string, unknown>): StudioSettings {
  const base = structuredClone(DEFAULT_SETTINGS)
  const theme = (parsed.theme as ThemeMode) || 'light'

  let apis: ApiProfile[] = []
  if (Array.isArray(parsed.apis) && parsed.apis.length > 0) {
    apis = parsed.apis as ApiProfile[]
  } else if (parsed.model && typeof parsed.model === 'object') {
    const m = parsed.model as ModelConfig
    const id = makeId('api')
    apis = [
      {
        id,
        label: `${PROVIDER_PRESETS[m.provider]?.label || m.provider} 默认`,
        provider: m.provider || 'deepseek',
        model: m.model || 'deepseek/deepseek-chat',
        apiKey: m.apiKey || '',
        baseUrl: m.baseUrl || '',
      },
    ]
    return {
      ...base,
      theme,
      activeApiId: id,
      apis,
      tools: mergeTools(parsed.tools as ToolItem[] | undefined),
      skills: Array.isArray(parsed.skills) ? (parsed.skills as SkillItem[]) : base.skills,
      knowledge: Array.isArray(parsed.knowledge)
        ? (parsed.knowledge as KnowledgeItem[])
        : [],
      editorCommand: String(parsed.editorCommand || parsed.editor_command || 'cursor'),
    }
  } else {
    apis = base.apis
  }

  const activeApiId =
    (parsed.activeApiId as string) ||
    apis[0]?.id ||
    base.activeApiId

  return {
    ...base,
    theme,
    activeApiId,
    apis,
    tools: mergeTools(parsed.tools as ToolItem[] | undefined),
    skills: Array.isArray(parsed.skills) ? (parsed.skills as SkillItem[]) : base.skills,
    knowledge: Array.isArray(parsed.knowledge)
      ? (parsed.knowledge as KnowledgeItem[])
      : [],
    editorCommand: String(parsed.editorCommand || parsed.editor_command || 'cursor'),
  }
}

export function loadSettings(): StudioSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('crew-studio.settings.v1')
    if (!raw) return structuredClone(DEFAULT_SETTINGS)
    return migrate(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

function mergeTools(saved?: ToolItem[]): ToolItem[] {
  const map = new Map((saved || []).map((t) => [t.id, t]))
  return DEFAULT_TOOLS.map((t) => {
    const prev = map.get(t.id)
    return prev ? { ...t, enabled: prev.enabled } : { ...t }
  })
}

export function saveSettings(settings: StudioSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function applyTheme(theme: ThemeMode) {
  document.documentElement.setAttribute('data-theme', theme)
}

export function enabledToolIds(settings: StudioSettings): string[] {
  return settings.tools.filter((t) => t.enabled).map((t) => t.id)
}
