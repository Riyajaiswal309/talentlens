/**
 * PDF and DOCX text extraction (FR3.3).
 *
 * TWO LIBRARIES, ONE JOB EACH. `pdf-parse` walks a PDF's content streams;
 * `mammoth` converts a DOCX's XML to text. Neither performs OCR, so a
 * scanned page contributes nothing — that case is detected and reported
 * rather than silently yielding an empty profile (FR3.4 stays out of scope).
 */

/** A page of extracted text plus what the extractor could tell us about it. */
export interface ExtractedText {
  text: string;
  /** Pages for a PDF; always 1 for DOCX, which has no page concept pre-render. */
  pageCount: number;
  /** Non-fatal observations worth showing a recruiter. */
  limitations: string[];
}

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Below this many characters per page, a PDF is almost certainly scanned
 * images with no text layer. Chosen empirically: a genuinely sparse one-page
 * CV still clears it comfortably, while an image-only page yields ~0.
 */
const MIN_CHARS_PER_PAGE = 40;

export async function extractText(bytes: Buffer, mimeType: string): Promise<ExtractedText> {
  if (mimeType === PDF_MIME) return extractPdf(bytes);
  if (mimeType === DOCX_MIME) return extractDocx(bytes);
  // The upload path already rejects other types; reaching here is a bug, not
  // user input, so it throws rather than degrading.
  throw new Error(`Cannot extract text from unsupported type: ${mimeType}`);
}

async function extractPdf(bytes: Buffer): Promise<ExtractedText> {
  /*
   * `pdf-parse` v2 exports a PDFParse CLASS, not the v1 default function —
   * `new PDFParse({ data }).getText()` returning `{ text, pages, total }`.
   * Imported lazily so a process that never parses anything does not pay for
   * loading a PDF engine at boot.
   */
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (options: { data: Uint8Array }) => {
      getText: () => Promise<{ text: string; total: number }>;
    };
  };

  // A Uint8Array view, because the engine indexes the buffer directly.
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  const text = normalise(result.text ?? '');
  const pageCount = result.total || 1;
  const limitations: string[] = [];

  if (text.length < MIN_CHARS_PER_PAGE * pageCount) {
    /*
     * FR3.4 is explicitly out of scope, so this is REPORTED, not worked around.
     * Saying "no text layer" is the honest reading: the file may be a scan, or
     * it may store its text as vector outlines. Either way nothing was read.
     */
    limitations.push(
      'This PDF contains little or no selectable text. It may be a scan or an image-only export; OCR is not available in this build, so few fields could be extracted.',
    );
  }

  return { text, pageCount, limitations };
}

async function extractDocx(bytes: Buffer): Promise<ExtractedText> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };

  const result = await mammoth.extractRawText({ buffer: bytes });
  const text = normalise(result.value);
  const limitations: string[] = [];

  if (text.length < MIN_CHARS_PER_PAGE) {
    limitations.push(
      'This DOCX yielded almost no text. Its content may be inside images or text boxes, which are not read.',
    );
  }

  return { text, pageCount: 1, limitations };
}

/**
 * Tidy extracted text without destroying its structure.
 *
 * LINE BREAKS ARE LOAD-BEARING and deliberately preserved: the contact rules
 * below depend on "the first few lines" meaning something. Only runs of blank
 * lines and trailing whitespace are collapsed.
 *
 * MULTI-COLUMN LAYOUTS (FR3.3): a two-column CV extracts as interleaved lines
 * — a heading from the left column, then a fragment from the right. Nothing
 * here reflows that, because guessing column boundaries from a flat text
 * stream is unreliable. It is why the parser reads tokens that are
 * self-identifying wherever it can (an email is an email wherever it lands)
 * and why line-position rules carry LOWER confidence than pattern rules.
 */
function normalise(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // Non-breaking and zero-width characters break the pattern rules below.
      .replace(/[ ​‌‍﻿]/g, ' ')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}
