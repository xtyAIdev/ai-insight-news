/**
 * LLM Provider —— OpenAI 兼容 API + 规则引擎降级
 *
 * 规格约束（Sheet00 R12）：
 *  - 评分类调用 temperature=0.1
 *  - 内容生成类 temperature=0.3
 *  - 真实性判断类 temperature=0.1
 * 异常处理（Sheet08 R6/R9）：
 *  - LLM 输出格式错误：重试 1 次 → 规则降级
 *  - 评分输出非 JSON：重试 1 次 → 默认 3 分
 */

import { config, hasLLM } from '../config/index.js';
import { httpGetJson } from '../utils/http.js';
import { logger } from '../utils/logger.js';

export type LLMUsage = 'score' | 'generate' | 'judge';

export interface LLMCallOptions {
  temperature?: number;
  jsonMode?: boolean;
  maxTokens?: number;
  retries?: number;
}

export interface LLMProvider {
  available(): boolean;
  /** 普通文本生成 */
  complete(prompt: string, usage?: LLMUsage, opts?: LLMCallOptions): Promise<string>;
  /** JSON 模式结构化输出；失败返回 null（调用方走降级） */
  completeJson<T>(prompt: string, usage?: LLMUsage, opts?: LLMCallOptions): Promise<T | null>;
  name(): string;
}

// ========== OpenAI 兼容实现 ==========

class OpenAICompatibleProvider implements LLMProvider {
  private baseUrl = config.llm.baseUrl;
  private model = config.llm.model;
  private apiKey = config.llm.apiKey;

  available(): boolean {
    return hasLLM();
  }

  name(): string {
    return `openai-compatible(${this.model})`;
  }

  private tempFor(usage: LLMUsage): number {
    switch (usage) {
      case 'score': return config.llm.tempScore;   // 0.1
      case 'judge': return config.llm.tempJudge;   // 0.1
      case 'generate': return config.llm.tempGenerate; // 0.3
    }
  }

  async complete(prompt: string, usage: LLMUsage = 'generate', opts: LLMCallOptions = {}): Promise<string> {
    const res = await httpGetJson<{
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    }>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      timeoutMs: 60_000,
      retries: opts.retries ?? config.retry.llmRetries,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: opts.temperature ?? this.tempFor(usage),
        max_tokens: opts.maxTokens ?? 2000,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok || !res.data) {
      const msg = res.data?.error?.message ?? res.error ?? 'LLM 调用失败';
      throw new Error(`LLM: ${msg}`);
    }
    const content = res.data.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM: 返回内容为空');
    return content;
  }

  async completeJson<T>(prompt: string, usage: LLMUsage = 'generate', opts: LLMCallOptions = {}): Promise<T | null> {
    const raw = await this.complete(prompt, usage, { ...opts, jsonMode: true });
    try {
      // 兼容 markdown 代码块包裹
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      return JSON.parse(cleaned) as T;
    } catch {
      // 尝试提取第一个 { ... } 块
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { return JSON.parse(m[0]) as T; } catch { return null; }
      }
      return null;
    }
  }
}

// ========== 规则引擎降级实现 ==========

/**
 * 规则引擎（无 LLM Key / LLM 失败时的兜底）
 * 能力：
 *  - 实体抽取：正则提取
 *  - 五维洞察：基于事实的规则模板（保证不编造）
 *  - 真实性判断：信源等级换算
 *  - 质量评分：信源等级 + 特征加权
 *  - 事件分类：关键词规则
 *  - 报告生成：结构化模板
 */
class RuleEngineProvider implements LLMProvider {
  available(): boolean {
    // 规则引擎不是"可用的 LLM"——getLLM().available() 应表示"是否有真实 LLM"
    return false;
  }

  name(): string {
    return 'rule-engine(降级)';
  }

  async complete(_prompt: string): Promise<string> {
    // 规则引擎不做自由文本生成，由上层逻辑直接调用规则函数
    throw new Error('rule-engine 不提供自由文本生成，请使用专用规则函数');
  }

  async completeJson<T>(): Promise<T | null> {
    return null;
  }
}

// ========== 门面：自动选择 ==========

let cachedProvider: LLMProvider | null = null;

export function getLLM(): LLMProvider {
  if (cachedProvider) return cachedProvider;
  if (hasLLM()) {
    cachedProvider = new OpenAICompatibleProvider();
    logger.info(`LLM Provider: ${cachedProvider.name()}`);
  } else {
    cachedProvider = new RuleEngineProvider();
    logger.warn('未配置 LLM_API_KEY，降级为规则引擎（离线可跑通全流程，质量评估为规则分）');
  }
  return cachedProvider;
}

/** 统一调用：LLM 失败自动降级到规则函数（fn 返回 null 表示不可用） */
export async function withLLMFallback<T>(
  llmCall: () => Promise<T | null>,
  fallback: () => Promise<T>,
  label = 'LLM 调用',
): Promise<T> {
  // 只有配置了真实 LLM Key 才尝试 LLM；否则直接走规则引擎（避免无效调用）
  if (!hasLLM()) {
    return fallback();
  }
  try {
    const result = await llmCall();
    if (result === null) {
      logger.warn(`${label}: LLM 输出无法解析，降级规则`);
      return fallback();
    }
    return result;
  } catch (err) {
    logger.warn(`${label}: LLM 异常 -> ${err instanceof Error ? err.message : err}，降级规则`);
    return fallback();
  }
}
