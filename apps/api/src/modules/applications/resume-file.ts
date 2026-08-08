import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

/**
 * Server-side resume file rules (FR2.1, FR3.3, Phase 1 CA-02).
 *
 * These run on the server because the browser cannot be trusted to have run
 * them: the dropzone in CA-02 states the same constraints, but a direct HTTP
 * caller never sees that UI.
 */

/** APPROVED decision C (8 Aug 2026) — matches the CA-02 dropzone copy. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** FR2.1/FR3.3 accept PDF and DOCX only. */
const ACCEPTED: Record<string, { extension: string; magic: Buffer }> = {
  [PDF_MIME]: { extension: 'pdf', magic: Buffer.from('%PDF') },
  // DOCX is an OOXML zip container, so its magic bytes are the ZIP local file
  // header. Checked together with the declared type below.
  [DOCX_MIME]: { extension: 'docx', magic: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
};

export interface ValidatedResume {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  extension: string;
}

/**
 * Phase 1 §10.5 requires error text to name the problem AND the fix, so each
 * rejection says what was wrong and what to send instead.
 */
export function validateResumeFile(file: Express.Multer.File | undefined): ValidatedResume {
  if (!file) {
    throw new BadRequestException('Attach your resume as a PDF or DOCX file to apply');
  }

  if (file.size === 0) {
    throw new BadRequestException('That file is empty. Attach a PDF or DOCX resume');
  }

  // Multer's own limit normally catches this first; the check is repeated here
  // so the rule holds even if this function is called from another path.
  if (file.size > MAX_RESUME_BYTES) {
    throw new PayloadTooLargeException('Your resume must be 10 MB or smaller');
  }

  const accepted = ACCEPTED[file.mimetype];
  if (!accepted) {
    throw new BadRequestException('Resumes must be a PDF or DOCX file');
  }

  /*
   * The declared Content-Type comes from the client and can say anything, so
   * the file's leading bytes must agree with it. Without this, an executable
   * announced as application/pdf would be stored and handed to the Phase 3
   * parser.
   */
  if (!file.buffer.subarray(0, accepted.magic.length).equals(accepted.magic)) {
    throw new BadRequestException(
      'That file is not a valid PDF or DOCX. Re-export it and try again',
    );
  }

  return {
    buffer: file.buffer,
    filename: file.originalname,
    mimeType: file.mimetype,
    extension: accepted.extension,
  };
}
