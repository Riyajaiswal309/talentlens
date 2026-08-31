import { Module } from '@nestjs/common';
import { AiScoringPort } from './ai-scoring.port';
import { AiServiceClient } from './ai-service.client';
import { ResumeParserPort } from './parsing/resume-parser.port';
import { RuleBasedResumeParser } from './parsing/rule-based-resume.parser';
import { MatchScorerPort } from './scoring/match-scorer.port';
import { BaselineRulesScorer } from './scoring/baseline-rules.scorer';
import { ParseReviewController, ParsedProfilesController } from './parse-review.controller';
import { ParseReviewService } from './parse-review.service';
import { PersistedAiProvider } from './persisted-ai.provider';
import { RankingWeightsController } from './ranking-weights.controller';
import { RankingWeightsService } from './ranking-weights.service';
import { ResumeParseWorker } from './resume-parse.worker';
import { ScoreOverrideController } from './score-override.controller';
import { ScoreOverrideService } from './score-override.service';

/**
 * PRD §15.3 `AiModule` — the whole AI surface of the core API.
 *
 * The port is bound to its implementation in ONE place. Phase 2 bound it to
 * NullAiProvider; Phase 3 binds it to PersistedAiProvider, and no consumer
 * changed — which is what the seam was for.
 *
 * NullAiProvider is retained, unbound, as the documented fallback for a
 * deployment with no AI service.
 *
 * WHAT IS AND IS NOT HERE: this module integrates a model; it does not
 * contain one. Extraction, ranking and explanation live behind
 * AiServiceClient in the Python service (§15.1 principle 1). That service is
 * a deterministic reference implementation — no model has been trained, and
 * nothing it returns is validated under §19.6.
 */
@Module({
  controllers: [
    ScoreOverrideController,
    RankingWeightsController,
    ParseReviewController,
    ParsedProfilesController,
  ],
  providers: [
    { provide: AiScoringPort, useClass: PersistedAiProvider },
    AiServiceClient,
    /*
     * FR3 — the resume parser binding, and the ONE line to change when a
     * trained model or the Python service takes over extraction. Everything
     * downstream depends on `ResumeParserPort`, never on this class.
     */
    { provide: ResumeParserPort, useClass: RuleBasedResumeParser },
    /* FR4.1 — the scorer binding. One line to replace with a trained ranker. */
    { provide: MatchScorerPort, useClass: BaselineRulesScorer },
    ScoreOverrideService,
    RankingWeightsService,
    ParseReviewService,
    ResumeParseWorker,
  ],
  exports: [AiScoringPort],
})
export class AiModule {}
