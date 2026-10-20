# Crew Studio

本地 **CrewAI Studio**：对话描述需求 → 澄清缺口 → 生成 **LangGraph 外层 + CrewAI 内层** 工作流 → 画布批准/修改 → 沙箱运行 / 导出 ZIP / 可选部署 CrewAI AMP。

> 需求与验收标准见 **[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)**。架构决策见 [docs/adr/0001-langgraph-outer-crew-inner.md](docs/adr/0001-langgraph-outer-crew-inner.md)。术语见 [GLOSSARY.md](GLOSSARY.md)。

## 功能亮点

- **完整工作流图**（不是单一 Team）：用户输入结点（规定格式）→ 多 Team Crew 子 DAG → 条件路由 / 有限循环 → HITL → 输出结点（本地文件 / 网站 / 微信公众号 / Webhook）→ 结束  
- **澄清优先**：缺输入格式、发布方式或站外账号/网址时，先提问再出计划  
- **双层画布**：L0 总览外层模块；双击 Team 进入子画布编辑 Agent/Task  
- **运行治理**：Token 预估与熔断、断点/HITL、子 DAG 回放  
- **可移植导出**：默认 LangGraph + CrewAI 独立 ZIP；亦可 AMP 兼容包  
- **编码**：画布添加 **Cline** 个体承接编码 Task（非编码 Agent Team）

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前端 | Vite、React 19、TypeScript、@xyflow/react |
| 后端 | FastAPI、Pydantic v2、CrewAI ≥1.15、可选 LangGraph |
| LLM | DeepSeek（Settings 可配多 API） |

## 准备

1. Python **3.11+**、Node **18+**  
2. 复制环境变量模板并填入密钥（**不要提交 `.env`**）：

```bash
cp backend/.env.example backend/.env
```

```env
DEEPSEEK_API_KEY=sk-...
MODEL=deepseek/deepseek-chat
HOST=0.0.0.0
PORT=8777
```

## 启动

**终端 1 — 后端**

```bash
cd backend
python -m pip install -e .
# 或: pip install fastapi "uvicorn[standard]" python-dotenv pydantic pyyaml "crewai>=1.15" langgraph
# 只监视 app/，避免 tmp/deploys 下 .venv 触发热重载
python -m uvicorn app.main:app --host 127.0.0.1 --port 8777 --reload --reload-dir app
# Windows: .\run_dev.ps1
```

**终端 2 — 前端**

```bash
cd frontend
npm install
npm run dev
```

打开 http://127.0.0.1:5173 。Vite 将 `/api` 代理到 `http://127.0.0.1:8777`。

健康检查应包含 `"workflow_build": "full-v2"`，确认连到本仓库后端：

```bash
curl http://127.0.0.1:8777/api/health
```

## 使用流程

1. 用中文描述目标（或点示例提示）  
2. 回答澄清问题（输入字段、输出方式、账号/网址、是否循环等；可跳过）  
3. 计划生成后打开**批准/修改画布**：应能看到多 Team + 用户输入 / 路由 / 输出等结点  
4. 「批准并运行」进沙箱，或「批准并进入编辑器」再微调；编码任务用 **Cline**  
5. 可选：定时任务、导出 LangGraph ZIP、生成 Mermaid 说明、部署 AMP  

## 仓库结构

```text
frontend/          # Web UI
backend/app/       # FastAPI、计划 enrich、LangGraph runtime、导出
docs/              # 需求、ADR、agent 协作说明
GLOSSARY.md        # 领域术语
AGENTS.md          # 给 Cursor / 编码 Agent 的布局提示
```

运行时产物（已在 `.gitignore`）：`backend/tmp/`、`backend/data/`、`.env`。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | 产品与工作流需求、验收清单 |
| [docs/adr/](docs/adr/) | 架构决策记录 |
| [GLOSSARY.md](GLOSSARY.md) | 术语表 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献说明 |
| [AGENTS.md](AGENTS.md) | Agent 协作约定 |

## 安全

- 切勿将 `.env`、API Key、公众号 Secret 提交到 Git  
- 若密钥曾出现在聊天或截图中，请在对应控制台**轮换**  
- 沙箱会执行 Agent 工具（含写文件 / Shell），仅在可信环境使用  

## License

MIT — 见 [LICENSE](LICENSE)。
