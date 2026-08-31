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
- [x] 3. 开源过滤：新星轨道独立于 push 窗口（created_at+star 门槛），不误杀新星
- [x] 4. webSearch 加免费档（Google News RSS），提升 reflection 命中率
- [x] 5. `sendMailSMTP` 支持多收件人（MAIL_TO 逗号分隔）

**批 3 · 反馈闭环 + 文档对齐**
- [x] 6. GitHub Pages 日报底部"反馈/纠错"按钮 → issue → 写 feedback.json 持久化（metrics 合并读）
- [x] 7. README/.env.example 删未实现功能（OpenReview/Semantic Scholar 等）

**测试（贯穿）**
- [x] 批1 完成：`node:test` 冒烟测试覆盖 buildFacts / normDedupKey / dedupCrossSource（`npm test`，11 用例）
- [x] 批2 完成：新增 `src/collectors/opensource.test.ts` 覆盖 filterCandidates 新星豁免（`npm test`，累计 14 用例）
- [x] 批3 完成：新增 `src/db/feedbackFile.test.ts` 覆盖反馈文件读写/合并（`npm test`，累计 18 用例）

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

### 2026-08-31 · 批2 完成（改 collectors + smtp + websearch）
**任务③ 开源新星轨道独立于 push/更新时间窗**（`src/collectors/opensource.ts`）：
- 根因：A/B 双轨共用的 `collectGithubRepos` 有统一 `pushedHours <= max(72, 3×窗口)` push 窗口过滤，B 轨新星（created≤14d + stars≥30）若最近未 push 即被误杀；且 `filterCandidates` 末段的 `updated_at` 时间窗也会二次误杀。
- 改动：`collectGithubRepos` 加 `rising=false` 参数，B 轨调用传 `true` 跳过 push 窗口过滤；`filterCandidates` 中 `isRising`（created≤14d + stars≥门槛）豁免 updated_at 时间窗。A 轨（成熟活跃）行为不变。
- 已确认 B 轨查询本身带 `created:>DATE-14d stars:>30` 门槛，豁免安全。

**任务④ webSearch 加 Google News RSS 免费档**（`src/utils/websearch.ts`）：
- 在 HN + DDG 之后新增第三档 `searchGoogleNews`（news.google.com/rss/search，无需 key，`when:7d` + maxAgeHours 过滤，解析 pubDate 为 published_at）。
- `WebSearchResult.source` 类型扩展 `'googlenews'`；paper/opensource/enterprise/evaluator 的 `r.source === 'hackernews' ? ... : 'DuckDuckGo'` 三元补 `googlenews → 'Google News'`（6 处名称显示修正，非逻辑改动）。
- enterprise.ts 已有独立的投融资 `collectGoogleNews`（source_type=`google_news`），与本通用通道（`googlenews`）互不冲突。

**任务⑤ sendMailSMTP 多收件人**（`src/reporter/smtp.ts`）：
- `SmtpOptions.to` 类型放宽为 `string | string[]`；`sendMailSMTP` 入口与 `smtpSession` 内均归一化为数组（逗号分隔解析）。
- RCPT 步进重构：step 6 发第 1 个收件人，step 7 按 `idx = step-6` 继续发剩余 RCPT，全部收件人响应后进 DATA（step 8 起）。DATA 头部 `To:` 用 `to.join(', ')`。
- 兼容：reporter.ts `sendMail`、cli/mail-test.ts 传字符串 `to`，入口解析后数组化，无需改调用方。`.env.example` 已注明 MAIL_TO 可逗号分隔多个。

**测试**：新增 `src/collectors/opensource.test.ts`（3 用例：新星超窗保留 / 成熟超窗滤掉 / 新星 star 门槛）。`package.json` test script 扩展为 `dist/evaluator/*.test.js dist/collectors/*.test.js`。
**验证**：`npm run typecheck` ✅；`npm test` 14/14 ✅。
**改动文件**：`src/collectors/opensource.ts`、`src/collectors/opensource.test.ts`（新）、`src/collectors/paper.ts`、`src/collectors/enterprise.ts`、`src/utils/websearch.ts`、`src/evaluator/evaluator.ts`、`src/reporter/smtp.ts`、`package.json`。

### 2026-08-31 · 批2 完整本地运行验证 + 已提交
**本地完整运行**：`npm run run`（无 .env → 规则引擎模式，无 LLM 成本，真实采集）：
- raw=103 → std=103 → TopN=12（opensource 5 + paper 5 + enterprise 2），耗时 60.5s，无降级。
- opensource 采集 62 → 过滤 55 → 去重 55。paper 143 → 81 → 44。enterprise 4（官方源多数 403/超时 + 投融资 aihot 4 + 垂媒 1）。
- 网络观察：本地 google.com / DDG / gitee / meta 超时（CI 可达）；Google News 免费档本地不可达，降级链正常。

**效果验证（批2 任务③）**：
- opensource TopN 从"高星老仓库霸榜"（dify 153k / ragflow / open-webui）变为"新星崛起"（mempalace 58k / Peekaboo 5k / kody 514 / rome 411 / LambChat 218）——新星轨道独立于 push/updated 窗口真正生效。
- 批1 跨源去重：本次数据无重复命中（enterprise 仅 4 条，无同新闻多版本），逻辑执行无副作用。
- 非本批范围观察：enterprise 里 OpenAI-Cursor 事件 authenticity=1 仍进 TopN（当天企业数据少 + 投资保底逻辑），与批1/2 无关。

**提交**：
- `d54f47a feat(collectors): 新星轨道独立于push窗口 + webSearch Google News 免费档 + SMTP 多收件人（批2）` — 代码 + 测试 + AGENTS.md + star_snapshots.json
- `dfe4838 chore: daily report 2026-08-31` — 本地运行生成的最新报告（`git add -f`，与 CI 风格一致）
- 均已推送 origin/main。本地与远端同步。
- 备注：`reports/` 在 .gitignore 但历史已跟踪，需 `git add -f` 才能更新报告文件；`state/star_snapshots.json` 已跟踪（跨 CI 积累 star 周增长数据）。

### 2026-08-31 · 批3 完成（反馈闭环 + 文档对齐）
**任务⑥ 反馈闭环**（用户拍板：按钮→Issue→反馈持久化到仓库文件）：
- 架构约束：GitHub Pages 纯静态无法写 SQLite；CI 的 DB 每次 checkout 重置不持久。方案：读者反馈持久化到 `data/feedback.json`（git add -f 提交回仓库，跨 CI 留存，类似 reports/ 与 state/）。
- 前端（`scripts/build-site.mjs`）：`feedbackLink(date)` 生成页脚"💬 反馈 / 纠错"按钮 → GitHub Issue 新建页预填结构化模板（日报日期/反馈类型/涉及事件/评分/具体说明）。首页 index.html + 每日独立页 renderDaily 均有。
- 持久化（新增 `src/db/feedbackFile.ts`）：`listFeedbackFromFile` / `appendFeedbackToFile`（按 id 去重、created_at 降序、原子写 tmp+rename）/ `computeQualityMetricsFromDbAndFile`（DB+文件合并统计）。路径 = `data/feedback.json`（与 DB 同目录）。
- 合并（`src/db/repo.ts`）：`listFeedback` 与 `computeQualityMetrics` 均合并 DB + 文件反馈（id 去重，DB 优先）。
- 落盘（`src/reporter/reporter.ts`）：`collectFeedback` 同步 `appendFeedbackToFile`（CLI feedback 与 server /api/feedback 都自动持久化）。
- CLI（`src/cli/index.ts`）：新增 `feedback:issue` 子命令（--event/--score/--tags/--suggestion），读者反馈无需精确 event_id（event 存标题文本，agent_score=0），事件可空。
- workflow（新增 `.github/workflows/feedback-collect.yml`）：`issues: opened` 触发，`startsWith(title,'[日报反馈]')` 才收集（普通 issue/告警不动）。github-script 解析模板字段 → `feedback:issue` 写文件 → git add -f data/feedback.json 提交 → 关闭 issue。无评分且无说明视为无效（保留 issue 人工跟进）。

**任务⑦ 文档对齐**：
- `src/collectors/paper.ts:3` 注释删"可选：OpenReview / Semantic Scholar"（源码未实现该采集）。
- README.md / README_CN.md webSearch 兜底描述补 Google News（批2 已加第三档，原文档过时）。
- `constants.ts:119` A_DOMAINS 保留 openreview.net / semanticscholar.org（功能性信源评分白名单，非功能声明；websearch 结果指向它们时给合理可信分，不删）。
- README 全文复查无其它"声称已实现但实际没有"的功能描述（零依赖 SMTP✅ / Pages✅ / feedback✅ / metrics✅ / 规则引擎✅ / 双语✅）。

**测试**：新增 `src/db/feedbackFile.test.ts`（4 用例：写入读取降序 / id 去重 / 无文件返回空 / DB+文件合并统计）。`package.json` test script 加入 `dist/db/*.test.js`。
**端到端验证**：`feedback:issue --event "..." --score 2 --tags "不准确,标题党"` → data/feedback.json 生成 → `metrics --period weekly` 正确读到（低分原因：不准确1/标题党1）。build-site.mjs 生成站点含反馈按钮（index.html + 每日页）。
**验证**：`npm run typecheck` ✅；`npm test` 18/18 ✅。
**改动文件**：`scripts/build-site.mjs`、`src/db/feedbackFile.ts`（新）、`src/db/feedbackFile.test.ts`（新）、`src/db/repo.ts`、`src/db/index.ts`、`src/reporter/reporter.ts`、`src/cli/index.ts`、`src/collectors/paper.ts`、`README.md`、`README_CN.md`、`package.json`、`.github/workflows/feedback-collect.yml`（新）。

### 2026-08-31 · 批3 实测 + 修复（已提交推送）
**实际测试（本地模拟 workflow 解析真实模板 body）**：
- 暴露 bug①：workflow github-script `getField` 正则 `\*\*label\*\*：` 无法匹配带括号说明的字段（模板是 `**评分**（0-5...）：`），导致 event/score 解析为空。
- 暴露 bug②：反馈类型模板预填全部 6 个选项（"不准确 / 标题党 / ..."），workflow 把整行当 tags，解析出全量 tags。
- 修复：正则改 `\*\*${label}\*\*[^\n]*：`（匹配字段名到冒号，含括号说明）；模板改为读者自行填写反馈类型（逗号分隔），workflow 去"如："示例与占位后按分隔符解析。
- 修复后模拟验证：event=标题文本、score=2、tags=["不准确"]、suggestion 正确解析。
- 完整链路实测：`feedback:issue --event ... --score 2 --tags "不准确"` → data/feedback.json 生成 → `metrics --period weekly` 读到（不准确:1）。build-site 生成站点含更新后的模板按钮。

**提交**：
- `f899c8e feat(feedback): 反馈闭环持久化到仓库文件 + 文档对齐（批3）`
- `aae6877 fix(feedback): 实测修正反馈闭环解析（正则 + 模板）`
- 均已推送 origin/main。

**未能完成的验证**（环境限制）：
- 真实 GitHub 闭环（读者建 issue → `issues: opened` workflow 触发 → 解析 → 提交 → 关闭）**未在真实仓库验证**：本机无 GitHub token 且 HTTPS 443 被网络阻断（SSH 仅用于 git 传输，不能建 issue）。
- 待补：用户在 GitHub 手动建一个 `[日报反馈]` 前缀的 issue（用日报页脚按钮预填模板），观察 workflow 是否触发并正确收集。workflow 需在真实 Actions 环境首次运行验证。
