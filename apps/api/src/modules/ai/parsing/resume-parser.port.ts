/**
 * The resume-parsing seam (FR3.1–FR3.3).
 *
 * WHY A PORT. PRD §20 puts extraction behind a boundary so the implementation
 * can be replaced without the worker changing. Today the only implementation is
 * `RuleBasedResumeParser`, which is deterministic and local; a trained model or
 * the Python service can be bound here later by swapping one provider in
 * `ai.module.ts`.
 *
 * An abstract class rather than an interface: Nest needs a runtime value as an
 * injection token, and a TypeScript interface has none.
 */

/** What the parser managed to read. Absent fields stay null — never invented. */
export interface ParsedContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
}

/**
 * Per-field extraction strength.
 *
 * NOT A MODEL PROBABILITY. Nothing here is learned and nothing is calibrated.
 * Each value is the strength of the DETERMINISTIC RULE that produced the field:
 * an RFC-shaped email found in the header scores higher than one found in body
 * text, and a name inferred from the filename scores lower than one on the
 * first line. Calling these "confidence" matches the schema's existing column
 * name (`field_confidence`) and FR3.2's wording; the UI must label them as
 * rule-based so nobody reads them as a classifier's output.
 *
 * The scale is shared with `ParseReviewService`, which flags anything below
 * `CONFIDENCE_THRESHOLD` (0.75) for human review.
 */
export type FieldConfidence = Record<string, number>;

export interface ResumeParseResult {
  contact: ParsedContact;
  skills: string[];
  /**
   * NOT EXTRACTED IN THIS BUILD and returned empty, not fabricated.
   *
   * Section detection across arbitrary resume layouts is where deterministic
   * parsers fail, so these three are deliberately out of scope for the local
   * parser rather than guessed at. They keep their schema columns and their
   * place in this contract so a later implementation fills them without a
   * migration or a signature change.
   */
  workHistory: unknown[];
  education: unknown[];
  certifications: unknown[];

  fieldConfidence: FieldConfidence;
  /** Mean of the per-field values actually produced; null when none were. */
  overallConfidence: number | null;

  /** Provenance, persisted so a profile can be re-derived and attributed. */
  parserName: string;
  parserVersion: string;

  /**
   * Why a document yielded little or nothing — surfaced to the recruiter
   * verbatim rather than left as an empty profile with no explanation.
   * Empty when extraction was unremarkable.
   */
  limitations: string[];
}

/** The document kinds the local parser accepts (FR3.3). */
export type ResumeMimeType =
  'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export abstract class ResumeParserPort {
  /**
   * Parse a resume's bytes.
   *
   * Receives BYTES, not a string: PDF and DOCX are binary containers, and
   * decoding them as UTF-8 before parsing destroys the document. Implementations
   * must throw on an unreadable document so the worker can record
   * `parse_status = FAILED` — returning an empty profile would be
   * indistinguishable from a resume that genuinely had no content.
   */
  abstract parse(bytes: Buffer, mimeType: string): Promise<ResumeParseResult>;
}
