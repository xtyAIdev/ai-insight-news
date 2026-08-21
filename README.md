# AI Insight Agent — Market Intelligence Agent

一个单体 **Market Intelligence Agent**（内部模块化流程），每日自动采集 AI 行业情报（开源技术 / 学术研究 / 企业动态），经标准化 → 五维洞察（仅用于评估排序）→ 真实性核验 → 质量评分，产出**新闻简报模板化日报**（Markdown + HTML 网页版双归档），并支持邮件推送。

> 本实现完全对应《Market Intelligence Agent 系统需求规格说明书 V2.0》（Sheet 00–09）与《业务流程图 V1.0》。

## 架构总览

```
┌────────────────────────── 调度器（每日 08:00 / 手动触发）──────────────────────────┐
│                                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐              │
│  │ 开源技术采集  │  │ 学术研究采集  │  │ 企业动态采集（单模块双分支）     │              │
│  │ GitHub→Trend│  │ arXiv→S2    │  │  分支A投融资(WebSearch)      │              │
│  │ ModelScope→HF│  │ OpenReview→ │  │  分支B产品战略(aihot+RSS)    │              │
│  │ →Gitee→Web  │  │ OpenAlex    │  │  （企业池9家，按公司≤2条）     │              │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────────────┘              │
│         └──────────┬─────┘  RawEvent（原始事件池）                               │
│  ┌──────────────────▼──────────────────┐                                        │
│  │ 统一处理层：标准化→实体抽取→分类校验→  │                                        │
│  │ 去重→冲突合并→五维洞察 → StandardEvent │  （并行处理，8 并发）                   │
│  └──────────────────┬──────────────────┘                                        │
│  ┌──────────────────▼──────────────────┐                                        │
│  │ 评估层：规则粗评→TopN×2候选 LLM 精评  │                                        │
│  │ →真实性/Reflection→评分→按模块TopN   │                                        │
│  └──────────────────┬──────────────────┘                                        │
│  ┌──────────────────▼──────────────────┐                                        │
│  │ 报告层：新闻简报模板→LLM内容生成→QC  │                                        │
│  │ →Markdown+HTML归档→邮件推送(失败入库) │                                        │
│  └─────────────────────────────────────┘                                        │
│  数据层：SQLite（事件库/高质量库/报告库/企业池/反馈集）+ trace_log 全链路           │
│  缓存层：data/cache/<模块>/latest.json（实时源全失败时 stale 降级）                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

## 快速开始

要求：Node.js ≥ 22.13（内置 `node:sqlite`，无需安装任何数据库）

```bash
cd ai-insight-agent
npm install          # 仅安装 typescript（编译期依赖）
cp .env.example .env # 可选：填入 LLM_API_KEY 启用真实 LLM

npm run             # 一键：编译 + 运行一次完整日报流程
npm run serve       # 启动本地 Web 查看器 http://localhost:8787（网页版日报预览）
```

- **无 Key 也能跑**：LLM 未配置/失败时自动降级为内置规则引擎，全流程可离线跑通。
- **配置 Key 后**：实体抽取、五维洞察、真实性判断、质量评分、报告生成全部走真实 LLM（OpenAI 兼容协议）。
- **三层兜底**：实时源失败 → WebSearch（Hacker News / DuckDuckGo，免 Key）→ 本地缓存（stale 标注「缓存数据」）。
- **三层兜底**：实时源失败 → WebSearch（Hacker News / DuckDuckGo，免 Key）→ 本地缓存（stale 标注「缓存数据」）。

## 命令行

```bash
node --experimental-sqlite dist/cli/index.js run            # 运行一次完整流程（今日）
node --experimental-sqlite dist/cli/index.js run --date 2026-08-20
node --experimental-sqlite dist/cli/index.js run --modules opensource,paper   # 只跑部分模块
node --experimental-sqlite dist/cli/index.js serve          # 启动本地 Web 查看器（报告/事件/反馈）
node --experimental-sqlite dist/cli/index.js db:init        # 初始化数据库
```

## 配置项（.env）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 空 | OpenAI 兼容 Key（DeepSeek/OpenAI 等）；空则规则引擎降级 |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | API 端点 |
| `LLM_MODEL` | `deepseek-chat` | 模型名 |
| `SCHEDULE_TIME` | `08:00` | 每日自动触发时间 |
| `GLOBAL_TIMEOUT_MIN` | `30` | 全局硬超时（分钟），超时输出已完成部分 |
| `MODULE_TIMEOUT_MIN` | `20` | 采集模块超时（分钟） |
| `TIME_WINDOW_HOURS` | `24` | 默认采集窗口；无结果自动扩展 48/72h |
| `TOP_N` | `5` | 每模块默认 TopN |
| `MAIL_*` | 关 | 邮件推送（可选，演示环境默认入库） |

## 目录结构

```
src/
├── cli/            # CLI 入口（run/serve/db:init）
├── config/         # 配置中心（.env 加载 + 默认值）
├── types/          # 统一事件 Schema（RawEvent/StandardEvent/DailyReport）
├── db/             # SQLite 数据层（建表 + 仓储）
├── utils/          # trace_log / retry / fetch / 归一化 / 信源等级
├── llm/            # LLM Provider（OpenAI 兼容 + 规则引擎降级）
├── collectors/     # 三大采集模块（opensource/paper/enterprise）
├── processor/      # 统一处理层（标准化/实体抽取/去重/五维洞察）
├── evaluator/      # 评估层（规则过滤/真实性/评分/排序）
├── reporter/       # 报告层（生成/质量检查/推送/反馈）
└── orchestrator/   # 调度器 + 编排器 + 异常矩阵
```

## 规格覆盖矩阵

| 规格 Sheet | 实现位置 |
|---|---|
| 00 总览与全局约定 | `config/` `types/` |
| 01 端到端主流程 | `orchestrator/` |
| 02 开源技术采集 | `collectors/opensource.ts` |
| 03 学术研究采集 | `collectors/paper.ts` |
| 04 企业动态采集 | `collectors/enterprise.ts` |
| 05 标准化与事件融合 | `processor/` |
| 06 真实性与质量评估 | `evaluator/` |
| 07 报告生成与输出 | `reporter/` |
| 08 异常降级处理 | `utils/retry.ts` `orchestrator/errors.ts` |
| 09 数据模型 Schema | `db/schema.sql` `types/` |
