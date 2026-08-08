import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

/**
 * The resume parsing queue (PRD §15.2 Figure, §16 Table 16.1).
 *
 * Production is "Amazon SQS + BullMQ workers"; locally and in Phase 2 the
 * BullMQ/Redis half is what exists, which is why the queue is named after the
 * thing it carries rather than after a broker.
 */
export const RESUME_QUEUE = 'resume-parsing';

/** The one event Phase 2 publishes (PRD §23.1 sequence, Phase 1 Flow 3.4). */
export const RESUME_UPLOADED = 'resume.uploaded';

/**
 * Payload of `resume.uploaded`.
 *
 * The PRD does not specify the fields, so this carries only what a consumer
 * provably needs:
 *
 *   - `resumeId`  — Handoff §G fixes the Phase 3 entry point as
 *                   `requestParse(resumeId)`, and Flow 4 keys everything the
 *                   worker writes off the resume.
 *   - `correlationId` — PRD §25 requires a correlation id to propagate "from
 *                   the originating HTTP request through SQS into
 *                   asynchronous worker and AI processing" (NFR11). This one
 *                   is not optional.
 *
 * Nothing else is included. The file location, MIME type and application id
 * are all reachable from `resumes` by primary key, and duplicating candidate
 * data into a queue would spread personal information across systems that
 * BR-05 erasure would then have to chase.
 */
export interface ResumeUploadedEvent {
  resumeId: string;
  correlationId: string;
}

@Injectable()
export class ResumeQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(ResumeQueueService.name);
  private readonly queue: Queue;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';

    this.queue = new Queue(RESUME_QUEUE, {
      connection: { url },
      defaultJobOptions: {
        // Parsing is idempotent per resume, so a transient worker or AI
        // failure is worth retrying rather than dropping (PRD §15.4).
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        // Keep failures for inspection; successes only briefly. Without this
        // Redis accumulates every job the system has ever run.
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }

  /**
   * The underlying BullMQ queue, for inspection.
   *
   * Exposed so that depth and failure counts can be read without a second
   * connection (PRD §25 alerts on queue depth), and so tests can assert that
   * a job really landed in Redis rather than trusting a spy.
   */
  getQueue(): Queue {
    return this.queue;
  }

  /**
   * Publish `resume.uploaded`.
   *
   * Must be called only after the file is stored AND the rows are committed:
   * a consumer that reads `resumes` by id would otherwise race the
   * transaction and find nothing. In Phase 2 no consumer exists at all — the
   * parser is Phase 3 — so this fills a queue that is deliberately not yet
   * drained.
   *
   * The job id is the resume id, which makes redelivery of the same upload a
   * no-op rather than a duplicate parse.
   */
  async publishResumeUploaded(event: ResumeUploadedEvent): Promise<void> {
    await this.queue.add(RESUME_UPLOADED, event, { jobId: event.resumeId });

    this.logger.log(`${RESUME_UPLOADED} resume=${event.resumeId} [${event.correlationId}]`);
  }
}
