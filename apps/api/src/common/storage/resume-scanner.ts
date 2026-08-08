import { Injectable, Logger } from '@nestjs/common';

export interface ScanResult {
  clean: boolean;
  /** Name of whatever was matched. Present only when `clean` is false. */
  signature?: string;
}

/**
 * Antivirus boundary for uploaded files (PRD §20 stage 1).
 *
 * An abstract class rather than an interface so it can serve as its own
 * injection token — a TypeScript interface does not survive to runtime.
 *
 * The requirement this type exists to enforce is ORDERING: §20 stage 1 scans
 * "before persistence", and Phase 1 CA-02 lists AV-scan failure as a distinct
 * candidate-facing error. Retrofitting that order later would mean unpicking
 * the call sequence, so the seam is placed now even though Phase 2 ships no
 * real engine.
 */
@Injectable()
export abstract class ResumeScanner {
  abstract scan(buffer: Buffer, filename: string): Promise<ScanResult>;
}

/**
 * The EICAR standard antivirus test string.
 *
 * Not a virus, and this class is not an antivirus. Recognising the industry
 * test file is what makes the rejection path demonstrable end-to-end in
 * development instead of reachable only through a mock.
 */
const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Development scanner: passes everything except the EICAR test file.
 *
 * APPROVED as decision B1 (8 Aug 2026) — the boundary ships in Phase 2, a
 * real ClamAV sidecar replaces this implementation later. It is registered by
 * class name so that swapping in ClamavScanner is a one-line provider change
 * with no caller affected.
 */
@Injectable()
export class PassThroughScanner extends ResumeScanner {
  private readonly logger = new Logger(PassThroughScanner.name);

  constructor() {
    super();
    this.logger.warn(
      'resume scanning is PASS-THROUGH — no antivirus engine is attached (PRD §20 stage 1 pending)',
    );
  }

  scan(buffer: Buffer, filename: string): Promise<ScanResult> {
    if (buffer.includes(EICAR_SIGNATURE)) {
      this.logger.warn(`EICAR test file rejected: ${filename}`);
      return Promise.resolve({ clean: false, signature: 'EICAR-Test-File' });
    }

    return Promise.resolve({ clean: true });
  }
}
