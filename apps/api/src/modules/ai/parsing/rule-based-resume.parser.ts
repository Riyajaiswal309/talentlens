import { Injectable, Logger } from '@nestjs/common';
import {
  ResumeParserPort,
  type FieldConfidence,
  type ParsedContact,
  type ResumeParseResult,
} from './resume-parser.port';
import { extractText } from './text-extraction';
import { SKILL_VOCABULARY } from './skill-vocabulary';

/**
 * A deterministic, local resume parser (FR3.1 contact + skills, FR3.2, FR3.3).
 *
 * THIS IS NOT MACHINE LEARNING, and the naming says so everywhere it surfaces:
 * `parserName` is the literal string `rule-based-local`. Nothing here is
 * trained, nothing is calibrated, and the numbers it emits are rule strengths
 * (see `FieldConfidence`), not probabilities. The UI labels them accordingly.
 *
 * WHAT IT EXTRACTS: name, email, phone, location, skills.
 * WHAT IT DOES NOT: work history, education, certifications — returned empty
 * rather than guessed. Those need section segmentation, which is exactly where
 * deterministic parsers produce confident nonsense on real-world layouts.
 *
 * THE GUIDING RULE: a field that cannot be read stays `null` and is scored low
 * so `ParseReviewService` flags it. Fabricating a plausible value would be
 * worse than an empty one, because a recruiter cannot tell the difference.
 */
@Injectable()
export class RuleBasedResumeParser extends ResumeParserPort {
  private readonly logger = new Logger(RuleBasedResumeParser.name);

  static readonly PARSER_NAME = 'rule-based-local';
  static readonly PARSER_VERSION = 'v1';

  async parse(bytes: Buffer, mimeType: string): Promise<ResumeParseResult> {
    const extracted = await extractText(bytes, mimeType);
    const lines = extracted.text.split('\n').filter((line) => line.length > 0);

    const confidence: FieldConfidence = {};
    const contact = this.readContact(extracted.text, lines, confidence);
    const skills = this.readSkills(extracted.text, confidence);

    const produced = Object.values(confidence);
    const overall = produced.length
      ? Number((produced.reduce((sum, v) => sum + v, 0) / produced.length).toFixed(4))
      : null;

    const limitations = [...extracted.limitations];
    if (!contact.email) {
      limitations.push('No email address could be found in this document.');
    }
    /*
     * Stated up front so an empty section is never read as "this candidate has
     * no experience". The columns exist; this parser does not fill them.
     */
    limitations.push(
      'Work history, education and certifications are not extracted by the rule-based parser and must be reviewed manually.',
    );

    this.logger.log(
      `parsed ${mimeType} pages=${extracted.pageCount} chars=${extracted.text.length} ` +
        `fields=${produced.length} overall=${overall ?? 'n/a'}`,
    );

    return {
      contact,
      skills,
      // Empty, never invented — see the class docblock.
      workHistory: [],
      education: [],
      certifications: [],
      fieldConfidence: confidence,
      overallConfidence: overall,
      parserName: RuleBasedResumeParser.PARSER_NAME,
      parserVersion: RuleBasedResumeParser.PARSER_VERSION,
      limitations,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Contact (FR3.1)                                                         */
  /* ---------------------------------------------------------------------- */

  private readContact(text: string, lines: string[], confidence: FieldConfidence): ParsedContact {
    const contact: ParsedContact = { name: null, email: null, phone: null, location: null };

    /*
     * EMAIL — the most reliable field in any resume, because the token is
     * self-identifying: an RFC-shaped address means the same thing wherever it
     * appears, so a multi-column layout cannot mislead it. Highest confidence.
     */
    const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (email) {
      contact.email = email[0];
      // Slightly higher when it sits in the header, where a CV's own address
      // lives — an address further down may belong to a referee.
      const inHeader = lines.slice(0, 6).some((line) => line.includes(email[0]));
      confidence['contact.email'] = inHeader ? 0.95 : 0.85;
    } else {
      confidence['contact.email'] = 0;
    }

    /*
     * PHONE — also pattern-identified, but far noisier: dates, postcodes and
     * identifiers all look phone-ish. Requires 9–15 digits with optional
     * separators, and scores below the 0.75 review threshold when it lacks an
     * international prefix, because national formats are the ambiguous ones.
     */
    const phone = text
      .match(/(\+\d{1,3}[\s.-]?)?(\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g)
      ?.map((candidate) => candidate.trim())
      .find((candidate) => {
        const digits = candidate.replace(/\D/g, '');
        return digits.length >= 9 && digits.length <= 15;
      });
    if (phone) {
      contact.phone = phone;
      confidence['contact.phone'] = phone.trim().startsWith('+') ? 0.85 : 0.6;
    } else {
      confidence['contact.phone'] = 0;
    }

    /*
     * NAME — the weakest rule here, and scored to say so.
     *
     * There is no pattern that identifies a person's name; the only signal is
     * POSITION (resumes put it first) and SHAPE (1–4 capitalised words, no
     * digits, not a section heading). Both break on a two-column layout where
     * line one may come from either column. It therefore never exceeds the
     * review threshold — a recruiter is always asked to confirm it.
     */
    const nameLine = lines.slice(0, 5).find((line) => this.looksLikeName(line, contact.email));
    if (nameLine) {
      contact.name = nameLine;
      // Deliberately capped below CONFIDENCE_THRESHOLD (0.75): positional
      // evidence alone is never strong enough to accept without a human.
      confidence['contact.name'] = lines.indexOf(nameLine) === 0 ? 0.7 : 0.5;
    } else {
      confidence['contact.name'] = 0;
    }

    /*
     * LOCATION — matched against an explicit label ("Location:", "Address:")
     * only. Free-text place recognition needs a gazetteer this build does not
     * have, and guessing a city from a capitalised word produces confident
     * errors. No label, no location.
     */
    const labelled = text.match(/^\s*(?:location|address|based in)\s*[:\-–]\s*(.+)$/im);
    if (labelled?.[1]) {
      contact.location = labelled[1].trim().slice(0, 200);
      confidence['contact.location'] = 0.8;
    } else {
      confidence['contact.location'] = 0;
    }

    return contact;
  }

  /** 1–4 capitalised words, no digits, not an email, not a section heading. */
  private looksLikeName(line: string, email: string | null): boolean {
    if (email && line.includes(email)) return false;
    if (/\d|@|https?:/.test(line)) return false;
    if (line.length > 60) return false;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 4) return false;
    if (/^(curriculum vitae|resume|cv|profile|summary|contact)$/i.test(line.trim())) return false;
    // ALL-CAPS headings are common; a name in caps is possible, so shape is
    // checked rather than case alone.
    return words.every((word) => /^[A-Z][A-Za-z'’.-]*$/.test(word) || /^[A-Z.'’-]+$/.test(word));
  }

  /* ---------------------------------------------------------------------- */
  /* Skills (FR3.1)                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Skills, by closed-vocabulary match.
   *
   * A FIXED LIST, NOT FREE EXTRACTION. Pulling arbitrary nouns out of a resume
   * and calling them skills yields noise a recruiter then has to clean. Matching
   * a known vocabulary is narrower but everything it returns is real; a term
   * outside the list is simply not found, which is a knowable limitation rather
   * than a silent error.
   *
   * Matching is whole-token and case-insensitive, so "Java" does not match
   * "JavaScript" and "R" does not match every capital R in the document.
   */
  private readSkills(text: string, confidence: FieldConfidence): string[] {
    const haystack = text.toLowerCase();
    const found: string[] = [];

    for (const skill of SKILL_VOCABULARY) {
      /*
       * Lookarounds, not a character class, so a skill ending a sentence still
       * matches: "deployed on AWS." must find AWS, while "Java" must not match
       * inside "JavaScript". The boundary rejects only characters that could
       * CONTINUE a technology name — letters, digits, `+`, `#` — which leaves
       * `.` free to act as punctuation. `Node.js` and `.NET` still match
       * because the dot is inside the term itself, not at the boundary.
       */
      const pattern = new RegExp(
        `(?<![a-z0-9+#])${escapeRegExp(skill.toLowerCase())}(?![a-z0-9+#])`,
        'i',
      );
      if (pattern.test(haystack)) found.push(skill);
    }

    /*
     * Confidence reflects the EVIDENCE, not the count: an exact vocabulary hit
     * is unambiguous, so a non-empty result scores high. Zero matches is a real
     * finding (this resume mentions nothing we recognise) and scores 0 so the
     * field is flagged for review rather than accepted as "no skills".
     */
    confidence['skills'] = found.length > 0 ? 0.9 : 0;
    return found;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
