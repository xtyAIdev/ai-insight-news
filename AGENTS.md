# 项目记忆

本文件是 AI 助手在该项目中的长期记忆。每次开始任务前先完整读取本文件；每次完成任务时，把值得留存的结论追加到本文件。

## 项目定位
AI 行业市场洞察日报系统（Market Intelligence Agent）。
单体 Agent + 模块化内部流程，生成 AI 行业每日市场洞察报告。

## 技术栈
- Node.js >= 22.13.0，原生 `node:sqlite`（`--experimental-sqlite`）
- TypeScript（`tsc` 编译到 `dist/`）
- 无第三方运行时依赖

## 常用命令
- 构建：`npm run build`
- 运行（编译后）：`npm run start`
- 运行（ts 直跑）：`npm run dev`
- 类型检查：`npm run typecheck`
- 本地服务：`npm run serve` / `npm run serve:built`

## 关键结构
- `src/cli/` — 入口（`index.ts` run 调度、`server.ts` 本地服务、`site.ts` 站点）
- `src/orchestrator/` — 流程编排（`pipeline.ts` 主流水线、`scheduler.ts` 定时、`errors.ts`）
- `src/collectors/` — 信息采集（`enterprise` / `opensource` / `paper`）
- `src/evaluator/` — 价值评估
- `src/llm/` — LLM 接入（`provider` / `rules`）
- `src/processor/` — 数据加工
- `src/reporter/` — 报告生成（`reporter` / `restate` / `smtp`）
- `src/db/` — 原生 SQLite 持久化（`schema` / `eventRepo` / `repo`）
- `src/config/`、`src/types/`、`src/utils/` — 配置、类型、工具

## 决策记录（追加式）

### 2026-08-31 · 质量优化评审结论（用户拍板）
背景：已完成全代码探源 + 运行数据实测。DB：132 raw / 364 standard / 70 HQ / 1 report / 0 feedback / 10 task_runs。
实测发现：报告表仅 1 行（genReportId=report_YYYYMMDD + INSERT OR REPLACE 互覆，且 CI 只 commit 文件不写 DB）；企业模块同新闻多版本重复进日报（8/30 Cursor 占 3/5 席）；开源模块全是高星老仓库、新星轨道被 push 窗口误杀；官方源评分通胀（公关稿进 TopN）；"AI 企业"占位符入日报；webSearch 仅 HN+DDG 覆盖极窄；反馈闭环 0 条。

用户采纳方案（明确改动范围，其余**暂不改**）：
1. **质量核心**：① 真实性判断注入 facts（`judgeAccuracy` 拼 `buildFacts(evt)`）；② 评估层二次跨源去重（归一化标题+公司+时间窗，合并重复多版本）。
2. **采集与可回溯**：③ 修开源过滤逻辑——不误杀新星（新星轨道独立于 push 窗口，按 created_at+star 门槛），不只看高星活跃；④ webSearch 加免费档提升 reflection 命中率；⑤ `sendMailSMTP` 支持多收件人（`MAIL_TO` 逗号分隔）。
3. **反馈闭环**：GitHub Pages 日报底部加"反馈/纠错"按钮 → 提交到 issue/Serverless → 写入 feedback 表。
4. **文档对齐**：README/.env.example 删掉未实现功能（如 OpenReview/Semantic Scholar）。

用户明确表态：
- 同意引入 `node:test`（Node 内置、零新依赖）给核心函数补冒烟测试。
- 值得引入 GitHub Issues API 等（可破坏"零依赖"哲学换真闭环）。
- 工作方式：**逐批实现，每批一个 PR，用户 review 后再继续**，不一口气做完。
- **硬性规则（必须遵守）**：严禁大改/重塑已正确的代码与核心模块；代码可回溯；仅允许基于问题做最小调整；**不动核心逻辑与功能**。所有改动需条件/决策描述清晰。

### 暂缓（用户明确不做的项，留档备查，勿主动实现）
- 评分去通胀（importanceByRule 去 accuracy 线性加权）、官方源降权 —— 暂不做。
- event_id 内容哈希 / genReportId 加时间戳 —— 暂不做。
- 企业主体归属升级（KNOWN_AI_ORGS 复用 / company_unknown 降权）—— 暂不做。
- 开源新星之外的其他过滤调整、scheduler cron 化、server/site/build-site 渲染统一 —— 暂不做。

## 进行中 / 下一步

### 待办任务清单（逐批，每批一个 PR）

**批 1 · 质量核心（改 evaluator）**
- [x] 1. `judgeAccuracy` 注入 `buildFacts(evt)`（真实性判断有据可依）
- [x] 2. 评估层二次跨源去重：按"归一化标题 + 公司 + 时间窗"合并跨源重复（Cursor 三条合并成一条，多源证据合并）

**批 2 · 采集与可回溯（改 collectors + smtp + websearch）**
- [ ] 3. 开源过滤：新星轨道独立于 push 窗口（created_at+star 门槛），不误杀新星
- [ ] 4. webSearch 加免费档（如 Google News RSS / Brave 免费档），提升 reflection 命中率
- [ ] 5. `sendMailSMTP` 支持多收件人（MAIL_TO 逗号分隔）

**批 3 · 反馈闭环 + 文档对齐**
- [ ] 6. GitHub Pages 日报底部"反馈/纠错"按钮 → issue/Serverless → 写 feedback 表
- [ ] 7. README/.env.example 删未实现功能（OpenReview/Semantic Scholar 等）

**测试（贯穿）**
- [x] 批1 完成：`node:test` 冒烟测试覆盖 buildFacts / normDedupKey / dedupCrossSource（`npm test`，11 用例）
- [ ] 后续批：给被改动函数（评分/日期解析等）继续补冒烟测试

### 每条改动的执行纪律（新会话务必遵守）
1. 只改与上述清单相关的最小代码；不重构、不格式化无关代码、不改已正确行为。
2. 每处改动先 `Read` 目标文件与调用方，确认改动不破坏核心逻辑。
3. 改完跑 `npm run typecheck` + 相关 `node:test`。
4. 改动可回溯：保持 `INSERT OR REPLACE`、状态机、降级链、trace_log 语义不变。
5. 一个 PR 完成一批；PR 描述写明"问题 → 最小改动 → 验证"。

## 任务日志（追加式）

### 2026-08-31
- 完成全代码探源与实测（见决策记录）。
- 更新本文件：记录用户拍板的改动范围、硬性规则、分批任务。
- 工作区状态：本地仅 `package.json`（agent.instructions）+ `AGENTS.md` 未提交；已 `git pull --ff-only` 与 origin/main 同步（远端 15 commit：SMTP 重写/mail:test/CI DNS 修复）。typecheck 通过。

### 2026-08-31 · 批1 完成（改 evaluator）
**任务① judgeAccuracy 注入 buildFacts**：`src/evaluator/evaluator.ts` judgeAccuracy 的 prompt 增加 `${facts ? \`量化数据：${facts}\` : ''}`（复用已存在的 buildFacts；与 scoreImportance/rankReason 一致）。最小改动。

**任务② 评估层二次跨源去重**：`evaluateEvents` 前置 Phase 0，新增导出纯函数：
- `normDedupKey(title)`：归一化标题 → 去重键（英文去动作词/介词、保留实义词；中文保留连续片段；中英文并存都进 key；**不做词序归一/相似度阈值**——保守，词序打乱标题不合并）
- `timeBucketOf(time, reportDate, category)`：时间窗桶（以 reportDate 正午为基准分 0-7 天；未来进 0 桶；无日期进 no-date 桶；opensource 恒 ''）
- `dedupCrossSource(events, reportDate)`：键 = `category|company|titleKey|bucket`；opensource 走 product(repo 名) 强键通道；paper 同标题近窗合并。命中后：保留信息更全者（长 description）、合并 source 去重、补全缺失 entities/insight/company/product、trace_log 记 dedup。**不写 DB、不改被吞事件状态**（保持 processed，可回溯）。
- 导入 `normalizeCompany`（evaluator 原未 import）。
- 已知边界：中英不同措辞标题**不**互并（规则不跨语言翻译，保守；采集层同 URL 已由 processor 合并）。评估层主要捕"同语言措辞差异 + 官方/媒体不同英文标题 + opensource 同名仓库跨源"。

**测试**：新增 `src/evaluator/evaluator.test.ts`（node:test，11 用例，覆盖 buildFacts/normDedupKey/dedupCrossSource 的合并、隔离、强键、保守边界）。`package.json` 加 `test` script：`npm run build && node --experimental-sqlite --test dist/evaluator/*.test.js`（测试文件随 src 编译进 dist，tsconfig 未改）。

**验证**：`npm run typecheck` ✅；`npm test` 11/11 ✅。
**改动文件**：`src/evaluator/evaluator.ts`、`src/evaluator/evaluator.test.ts`（新）、`package.json`（test script）。
**未提交**：本批代码未 commit，待用户 review 后由用户/后续决定 PR。
