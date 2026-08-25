/**
 * 统一事件 Schema —— 处理层接口契约（规格 Sheet00 R16-R32 / Sheet09）
 */

// ========== 基础枚举 ==========

export type EventCategory = 'opensource' | 'paper' | 'enterprise';

export type EnterpriseSubType = 'investment' | 'product';

export type EventStatus =
  | 'raw'          // 原始
  | 'processed'    // 标准化完成
  | 'evaluated'    // 评估完成
  | 'reported'     // 已入报告
  | 'dropped'      // 被丢弃
  | 'low_quality'; // 低质量

export type ModuleName = 'opensource' | 'paper' | 'enterprise';

export type ModuleStatus = 'pending' | 'running' | 'done' | 'failed';

export type TriggerType = 'scheduled' | 'manual';

// ========== 来源证据 ==========

export interface SourceEvidence {
  url: string;
  source_type: string;        // github / arxiv / rss / media / websearch ...
  name: string;
  credibility_score?: number; // 信源等级换算分（S=5 A=4.5 B=4 C=3 D=1-2）
  published_at?: string;      // 该来源的发布时间（用于真实性日期校验，可选）
}

// ========== 采集层原始事件（RawEvent） ==========

/** OpenSource RawEvent（规格 Sheet09 R1-R14） */
export interface OpenSourceRawEvent {
  module: 'opensource';
  project_name: string;
  repo_url: string;              // 唯一键
  owner: string;
  stars: number;
  star_growth_week?: number;
  star_growth_day?: number;
  /** 社区活跃度：forks / open issues / contributors（社区热度，Sheet02 优化） */
  forks?: number;
  open_issues?: number;
  contributors?: number;
  primary_language?: string;
  updated_at?: string;
  commit_activity_7d?: number;
  tech_tags: string[];
  description: string;
  source_urls: SourceEvidence[];
}

/** Paper RawEvent（规格 Sheet09 R15-R24） */
export interface PaperRawEvent {
  module: 'paper';
  paper_id: string;              // arXiv ID / DOI 唯一键
  title: string;
  authors: string[];
  institution?: string;
  published_at: string;
  abstract: string;
  category: string;
  influence_hint?: string;
  source_urls: SourceEvidence[];
}

/** Enterprise RawEvent（规格 Sheet09 R25-R33） */
export interface EnterpriseRawEvent {
  module: 'enterprise';
  sub_type: EnterpriseSubType;
  company: string;
  title: string;
  published_at: string;
  content: string;
  fields: Record<string, unknown>; // 分支A: amount/round/investors；分支B: product/business_line/competitive_impact
  related_event_ids: string[];
  source_urls: SourceEvidence[];
}

export type RawEvent = OpenSourceRawEvent | PaperRawEvent | EnterpriseRawEvent;

// ========== 处理层标准化事件（StandardEvent，Sheet00 R17-R32 / Sheet09 R34-R50） ==========

export interface Insight {
  what: string;
  why: string;
  trend: string;
  impact: string;
  action: string;
}

export interface TraceEntry {
  stage: string;        // collect / standardize / extract / dedup / evaluate ...
  timestamp: string;    // ISO 8601
  tool: string;         // github_api / arxiv_api / llm / rule_engine / ...
  detail: string;       // 简短说明
}

export interface StandardEvent {
  event_id: string;            // evt_YYYYMMDD_xxx
  title: string;
  category: EventCategory;
  sub_type?: EnterpriseSubType;
  sub_tags: string[];
  company?: string;
  product?: string;
  source: SourceEvidence[];
  time: string;                // ISO 8601 YYYY-MM-DD（真实日期；未知日期为空串，绝不默认今天）
  /** 事件入库日期（YYYY-MM-DD，处理层写入；评估层用于校验 time 真实性/一致性） */
  added_at: string;
  description: string;
  entities: Record<string, unknown>;
  insight: Partial<Insight> | null;
  accuracy_score: number;      // 0-5
  importance_score: number;    // 0-5
  status: EventStatus;
  trace_log: TraceEntry[];
  raw_event?: RawEvent;        // 保留原始事件快照（便于溯源）
  /** 快评（日报"发生了什么+快评"结构；由报告层生成，评估层不写入） */
  quick_comment?: string;
  quick_comment_by?: 'llm' | 'rule';
}

// ========== 报告（DailyReport，Sheet09 R51-R59） ==========

export interface ReportSection {
  module: ModuleName;
  module_label: string;
  events: StandardEvent[];
  empty_note?: string; // 无数据时标注「今日无重大动态」
}

export interface WatchItem {
  title: string;
  reason: string;
}

export interface DailyReport {
  report_id: string;      // report_YYYYMMDD
  date: string;           // YYYY-MM-DD
  summary: string;        // 今日趋势总结
  sections: ReportSection[];
  future_watch: string;
  watchlist: WatchItem[];
  files: { markdown_path?: string; html_path?: string };
  push_status: { channel: string; status: string; sent_at?: string };
}

// ========== 任务 / 调度 ==========

export interface TaskContext {
  task_id: string;
  trigger_type: TriggerType;
  date_range: { start: string; end: string }; // ISO 日期（含小时）
  report_date?: string; // 报告日期 YYYY-MM-DD（严格当天过滤用，缺省回退 date_range.end）
  time_window_hours: number;
  top_n: number;
  modules: ModuleName[];
  started_at: string;
  deadline: string;
}

export interface ModuleResult {
  module: ModuleName;
  status: ModuleStatus;
  raw_count: number;
  events_count?: number;
  error?: string;
  degraded?: boolean;
  start_time: string;
  end_time?: string;
}

// ========== 反馈 ==========

export interface FeedbackRecord {
  id: string;
  event_id: string;
  report_id: string;
  agent_score: number;
  human_score: number | null;
  problem_tags: string[];
  suggestion: string;
  created_at: string;
}

// ========== 质量统计 ==========

export interface QualityMetrics {
  period: string;
  total_feedback: number;
  avg_agent_score: number;
  avg_human_score: number;
  consistency_rate: number; // 人工与 Agent 评分一致率（±0.5 内）
  satisfaction_rate: number; // 人工满意度（评分≥4 占比）
  low_score_reasons: Record<string, number>;
}
