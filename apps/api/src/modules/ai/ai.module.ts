import { Module } from '@nestjs/common';
import { AiScoringPort } from './ai-scoring.port';
import { ScoreOverrideController } from './score-override.controller';
import { ScoreOverrideService } from './score-override.service';
import { NullAiProvider } from './null-ai.provider';

/**
 * PRD §15.3 `AiModule` — Handoff module table row 10: "Interface + null
 * provider only".
 *
 * The port is bound to its implementation in ONE place. Phase 3 replaces
 * NullAiProvider with an HTTP client for the FastAPI service by editing this
 * line and nothing else; no consumer names the concrete class.
 *
 * The module exports only the port, never the implementation, so a consumer
 * cannot accidentally depend on null-provider behaviour.
 *
 * ScoreOverrideController (FR4.3) lives here too: the resource it acts on is
 * an AI score, so the whole AI surface stays in one directory. It is not
 * exported — nothing outside this module drives an override.
 */
@Module({
  controllers: [ScoreOverrideController],
  providers: [{ provide: AiScoringPort, useClass: NullAiProvider }, ScoreOverrideService],
  exports: [AiScoringPort],
})
export class AiModule {}
