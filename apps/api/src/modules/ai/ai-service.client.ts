import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScoreRationale } from './ai-scoring.port';

/** POST /internal/ai/parse response. */
export interface ParseResult {
  skills: unknown[];
  workHistory: unknown[];
  education: unknown[];
  certifications: unknown[];
  /** FR3.2 — per-field confidence, keyed by field path. */
  fieldConfidence: Record<string, number>;
  overallConfidence: number;
}

/** POST /internal/ai/rank + /explain, combined. */
export interface ScoreResultPayload {
  composite: number;
  featureVector: Record<string, number>;
  rationale: ScoreRationale;
  modelName: string;
  versionTag: string;
}

/**
 * HTTP client for the Python AI service (PRD §15.1 principle 1, §19.1).
 *
 * "The core API never imports model code. Communication is HTTP to the AI
 * service plus SQS events." This class is the entire surface through which
 * the core API can reach a model, which is what keeps that rule structural.
 *
 * NOT A MODEL, AND NOT VALIDATED. The service behind this client is a
 * deterministic reference implementation used to exercise the integration.
 * No model has been trained: no corpus, no labelled hiring outcomes, no
 * golden NER dataset, and no fairness dataset exist (PRD §19.2). Nothing it
 * returns is evidence of parsing, ranking or fairness performance, and
 * nothing it produces is promotable under §19.6.
 */
@Injectable()
export class AiServiceClient {
  private readonly logger = new Logger(AiServiceClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('AI_SERVICE_URL') ?? 'http://localhost:8000';
    this.timeoutMs = Number(config.get('AI_SERVICE_TIMEOUT_MS') ?? 10_000);
  }

  async parse(resumeId: string, text: string): Promise<ParseResult> {
    return this.post<ParseResult>('/internal/ai/parse', { resumeId, text });
  }

  async score(input: {
    applicationId: string;
    profile: ParseResult;
    weights: Record<string, number>;
  }): Promise<ScoreResultPayload> {
    return this.post<ScoreResultPayload>('/internal/ai/rank', input);
  }

  /**
   * A bounded call. PRD §15.1: "a degraded or absent AI service must not
   * degrade the recruiter workflow", so a hung service must fail the job
   * rather than hold a worker open indefinitely.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`AI service ${path} responded ${response.status}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.error(
        `AI service call failed: ${path}`,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
