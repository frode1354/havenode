# Contributing

感谢关注 Crew Studio。提交改动前请先阅读 [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) 与 [GLOSSARY.md](GLOSSARY.md)，保持术语一致。

## 开发

1. Fork / clone 本仓库  
2. 按 [README.md](README.md) 配置 `backend/.env` 并启动前后端  
3. 后端改动放在 `backend/app/`；前端在 `frontend/src/`  
4. 涉及工作流形状变更时：更新 `workflow_enrich.py` / `studio_llm.py` 提示词，并跑一次 `force_plan` 或 enrich 自测  

## 提交建议

- 不要提交 `.env`、`backend/tmp/`、`backend/data/`、`node_modules/`、`.venv/`  
- Commit message 说明**为什么**改，而不是只列文件名  
- 架构级取舍请补一条 ADR（`docs/adr/`）或更新现有 ADR  
- 新术语写入 `GLOSSARY.md`  

## Issue / 本地议题

正式 GitHub Issues 可用；本地 agent 工作流仍可用 `.scratch/<feature>/`（见 `docs/agents/issue-tracker.md`）。
