# Glossary

Shared language for Crew Studio. Prefer these terms in issues, code names, and agent output.

## Product

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Crew Studio** | This local app for designing and running CrewAI crews via chat + canvas | “platform”, generic “agent IDE” |
| **Plan / CrewPlan** | Structured JSON of teams, agents, tasks, inputs, layout, edge overrides; may include LangGraph outer fields (`modules`, `graph_edges`, `run_policy`) | “workflow JSON” alone |
| **LangGraph 外层** | 顶层编排引擎：全局 State、条件跳转、循环、断点、HITL、可选 LangSmith；外层画布只放模块 | 把几百条 Task 连线全摊在总览画布 |
| **Crew 子 DAG** | 一组相关 Agent/Task 打包为可双击进入的子画布模块；可单独保存/版本/回放/导出 | 编码 Agent Team；把整图当唯一可运行单位 |
| **Token 熔断** | `run_policy.token_budget_max`：静态预估上界 + 运行累计超限自动停止 | 仅事后看账单 |
| **Sandbox** | In-process DeepSeek kickoff of the approved plan; outputs under `backend/tmp/<title>/` | “run locally” without the tmp folder |
| **Approve / Modify** | Modal review step before the editor; revise via LLM or canvas edits | “confirm dialog” |

## Canvas

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Team** | Collapsible group of agents for one class of work; can open a **sub-canvas layer** | “group box” only |
| **Team 起点 / 末端** | 子画布边界门：外侧进入/离开连线继承到 Team 前后节点，子画布内接入口/出口 Task | 跨层连线断掉或只画在内部 |
| **Canvas layer** | Independent viewport (L0 overview vs L1+ team layers); tabs coexist | “zoom level” |
| **Exclusive edge** | Dashed link agent→task (no arrow); agent’s dedicated task | “dotted dependency” |
| **Uni edge** | Single arrow; one-way information flow | “one-way wire” without “传信” |
| **Bi edge** | Double arrow; two-way communication | “bidirectional wire” without “通讯” |
| **Grant** | Tools / skills / knowledge authorized on a team or agent (union when both set) | “permission” for Studio resources |

## Runtime resources

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Studio Skill** | Local skill path configured in Settings (distinct from Cursor agent skills in `.agents/skills/`) | Mixing with mattpocock skills |
| **Tool** | CrewAI tool class (e.g. `ScrapeWebsiteTool`); never `WebsiteSearchTool` here | OpenAI embedding tools |
| **Knowledge** | User-configured KB entries injected into agent context when granted | “RAG store” unless implemented |

## Process

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Sequential process** | CrewAI `Process.sequential` default for plans | Assuming hierarchical |
| **Hierarchical process** | Manager delegates (optional); **not** used for Cursor-style coding agents | Forcing hierarchical on coding teams |
| **Export ZIP** | 默认 **LangGraph+CrewAI** 可独立运行包（`graph.py`/`state.py`/`crews/`/`requirements.txt`/可选 Dockerfile）；亦可 `mode=crew` 出 AMP 兼容包 | 平台锁定、只能在 Studio 里跑 |
| **工作流文档** | 画布一键生成 Mermaid + 自然语言说明（`/api/workflow/docs`） | 手写架构图才算文档 |
| **部署到平台 / AMP** | 沙箱通过后生成 CrewAI AMP 包；云端推送需 `crewai login` | 未登录却指望 AMP 控制台出现服务 |
| **本地观测台** | 部署包的本地控制台：手动跑服务、看框架列表与画布、看产出；不依赖 AMP | 与沙箱混淆；以为必须上云才能观测 |
| **开始节点 / Start** | 画布入口：触发器（手动 / 定时 / webhook / 格式输入）、定时配置、kickoff 特定格式说明；连到下游入口 Task | 把触发信息只写在某个 Task 上 |
| **用户输入结点** | 外层 `kind=input`：按 `payload_format` / `inputs` 收集规定字段后再进入 Crew | 只有 Start 文案、没有外层 input 模块 |
| **输出结点 / sink** | 外层 `kind=output`：`sink_kind` 为 file / website / wechat_mp / webhook | 把「写文件」只塞进某个 Task 描述 |
| **条件路由** | 外层 `kind=router`：按 `branch` 走 `ok` / `retry` 等边 | 仅靠 Task 文案描述「如果」 |
| **循环边** | `graph_edges.is_loop` + `max_loops`：退回较早模块的有限次重试 | 无上限 while |
| **澄清门控** | 缺输入格式 / 输出方式 / 站外凭据时 `ready_for_plan=false` | 一句话就出完整计划 |
| **定时运行** | 用户在面板自选时间（每天/工作日/每周/仅一次/间隔），优先读 Start.schedule，否则读 Task.schedule；注册到 `backend/data/schedules.json` | 仅画布开开关、或指望计划 LLM 代设时刻 |
| **批准并运行** | 批准计划后直接打开工作流沙箱 | 只批准不跑 |

## Cline coding individual

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Cline** | 画布上的专职**编码个体**（`id`/`role_template_id`=`cline`）：读/搜/写/`ProjectShellTool`，承接编码 Task | `coding_general` 编码 Team、多编码工人编制、「用 Cline 打开编辑器」当主交互 |
| **编码 Task** | `agent_id` 指向 Cline 的任务 | 把编码塞给普通调研 Agent |
| **Team module** | 仅 `generic`；旧 `coding_general` 读入归一为 `generic` | 再生成编码 Team |
