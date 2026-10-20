# Crew Studio — 需求文档

本文档描述本地 Crew Studio 的产品目标、核心工作流能力与验收标准，供实现、评审与开源仓库对齐使用。

相关决策见 [ADR-0001](./adr/0001-langgraph-outer-crew-inner.md)；术语见根目录 [GLOSSARY.md](../GLOSSARY.md)。

---

## 1. 产品目标

用**对话 + 画布**搭建可运行的多智能体工作流：

1. 用户用自然语言描述目标  
2. 助手**先澄清缺口**（输入格式、输出方式、账号/网址、是否条件/循环等）  
3. 生成完整 **WorkflowPlan**（LangGraph 外层 + CrewAI 内层）  
4. 用户在画布上批准 / 修改  
5. 沙箱运行、导出 ZIP，或部署到 CrewAI AMP  

**非目标**

- 不做「只有一个 Team 的扁平计划」作为默认产出  
- 不以 CSS 仿 Langflow 为成功标准；成功标准是**功能完整的工作流图**  
- 编码任务用画布上的 **Cline** 个体，不另建编码 Agent Team  

---

## 2. 架构要求

| 层 | 技术 | 职责 |
| --- | --- | --- |
| 前端 | Vite + React + TypeScript + React Flow | 对话、澄清、总览画布、Team 子画布、检查器、沙箱/部署 UI |
| 后端 | FastAPI | 聊天/计划、归一化 enrich、运行任务、导出、设置、调度 |
| 外层编排 | LangGraph 风格 `modules` + `graph_edges` | 用户输入、条件路由、循环、HITL、输出结点、结束 |
| 内层执行 | CrewAI Crew / Team | 每个 Crew 模块是可双击进入的子 DAG |
| LLM | DeepSeek（及多 API 配置） | 澄清与计划生成 |

默认外层拓扑（可因用户意图裁剪）：

```text
Start → 用户输入(规定格式) → Crew₁ → … → [条件路由]
                                      ├─ ok → Crewₙ → [HITL] → 输出 → End
                                      └─ retry(有限循环) → 较早 Crew
```

---

## 3. 功能需求

### 3.1 澄清（Clarify）

在 `ready_for_plan=true` 之前，必须覆盖（信息不足则继续提问）：

| ID | 需求 | 说明 |
| --- | --- | --- |
| C1 | 用户输入字段与规定格式 | 字段名、示例；对应 `start.trigger=payload` + `payload_format` / `inputs` |
| C2 | 生成 / 发布方式 | 本地文件路径、更新网站、微信公众号、Webhook 等 |
| C3 | 条件分支与循环 | 是否质量不达标退回某结点；默认推荐有限循环 |
| C4 | 站外凭据 | 只要输出不是纯本地文件，必须先问网址 / 账号 / AppID·Secret / API Key；未提供则不得贸然 `ready_for_plan` |
| C5 | 阶段拆分 | 默认调研 → 分析 → 写作（多 Team）；用户明确「只要一个 Team」时可例外 |

### 3.2 计划生成（Plan）

| ID | 需求 | 验收 |
| --- | --- | --- |
| P1 | 禁止默认单 Team 流水线 | 多阶段任务生成 **≥2（通常 3）个 Team**，每人/阶段独立 `team_*` |
| P2 | 用户输入结点 | 外层存在 `kind=input` 模块；`start.trigger=payload` 且有格式说明 |
| P3 | 输出结点 | 外层存在 `kind=output`，`sink_kind ∈ {file, website, wechat_mp, webhook}` |
| P4 | 条件路由 | 多 Crew 时存在 `kind=router`，边带 `condition=ok|retry` |
| P5 | 循环 | `is_loop=true` 且 `max_loops`（默认 3）；超限走非循环边 |
| P6 | HITL | 站外发布或关键交付前可有 `kind=hitl` / breakpoint |
| P7 | 工具策略 | 调研：`ScrapeWebsiteTool` / `URLReadTool`；终稿：`FileWriterTool`；禁止 `WebsiteSearchTool` |
| P8 | 后处理 enrich | LLM 产出再经 `workflow_enrich.enrich_full_workflow` 补全图，不能只靠提示词 |

### 3.3 画布与编辑

| ID | 需求 |
| --- | --- |
| U1 | L0 总览显示 Team 折叠节点 + 外层 input/router/hitl/output/end，并按 `graph_edges` 连线（循环边可视化区分） |
| U2 | 双击 / 「进入子画布」编辑 Team 内 Agent / Task |
| U3 | 检查器可编辑 Start（触发器/定时/payload）、Team、Agent、Task、边 |
| U4 | 批准 / 修改弹窗：画布编辑或自然语言「保存修改并重新生成」 |

### 3.4 运行与治理

| ID | 需求 |
| --- | --- |
| R1 | 外层按图执行；Crew 结点调用现有沙箱 |
| R2 | 缺规定输入字段或站外凭据时，可 `waiting_human` 暂停 |
| R3 | Token 静态预估 + `run_policy.token_budget_max` 熔断 |
| R4 | 子 DAG 可单独回放；可选 LangSmith |
| R5 | 定时：Start / Task schedule → 本地调度（后端进程需存活） |

### 3.5 导出与部署

| ID | 需求 |
| --- | --- |
| E1 | 默认导出 **LangGraph + CrewAI** 可独立运行 ZIP（`graph.py` / `state.py` / `crews/` / `requirements.txt` / 可选 Dockerfile） |
| E2 | 可选 `mode=crew` 导出 AMP 兼容包 |
| E3 | 一键生成 Mermaid + 自然语言工作流说明 |
| E4 | 本地观测台可跑导出包；AMP 推送需用户已 `crewai login` |

---

## 4. 非功能需求

- **密钥**：`.env` 永不入库；仓库只提供 `.env.example`  
- **热重载**：后端只监视 `app/`，避免 `tmp/deploys` 下 `.venv` 触发重载打断运行中的 Agent  
- **端口**：默认后端 `8777`，前端 `5173`（Vite 代理 `/api`）  
- **兼容**：旧 Plan（仅 teams）可 normalize 为 `Start → Crew → End`；完整图由 enrich 生成  

---

## 5. 仓库与目录约定

```text
studio/
  README.md                 # 快速开始（面向 GitHub）
  docs/REQUIREMENTS.md      # 本需求文档
  docs/adr/                 # 架构决策
  GLOSSARY.md               # 术语
  AGENTS.md                 # 给编码 Agent 的笔记
  frontend/                 # Vite React 应用
  backend/app/              # FastAPI + enrich + runtime + export
  backend/.env.example
  .agents/skills/           # 可选本地 agent skills
```

运行时产物（**不入仓**）：`backend/tmp/`、`backend/data/`、`.env`。

---

## 6. 验收清单（发布前自测）

- [ ] 新对话描述「调研→分析→写作 + 本地文件/公众号」→ 澄清会问格式与凭据  
- [ ] 生成计划后画布出现 **多个 Team** + **用户输入 / 路由 / 输出 / 结束**  
- [ ] API `/api/health` 含 `workflow_build: full-v2`（用于确认连到正确后端）  
- [ ] `force_plan` 返回的 JSON 含 `modules`、`graph_edges`、`start.trigger=payload`  
- [ ] 导出 LangGraph ZIP 可在干净环境按 README 安装运行  

---

## 7. 版本记录

| 日期 | 说明 |
| --- | --- |
| 2026-10 | 初版：澄清门控、多 Team enrich、input/router/loop/output、GitHub 发布对齐 |
