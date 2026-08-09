import { Injectable } from '@nestjs/common';
import type { AuditEntry } from './audit-query.service';

/** The exported columns. Order is part of the file's contract. */
export const EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actorEmail',
  'actorType',
  'action',
  'resourceType',
  'resourceId',
  'correlationId',
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  // RFC 4180: quote when the value contains a delimiter, quote or newline,
  // and double any embedded quote. A stray comma in an email or action would
  // otherwise shift every later column in the row.
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function row(entry: AuditEntry): string[] {
  return [
    entry.id,
    entry.createdAt.toISOString(),
    entry.actorId ?? '',
    entry.actor?.email ?? '',
    entry.actorType,
    entry.action,
    entry.resourceType,
    entry.resourceId,
    entry.correlationId,
  ];
}

/**
 * FR8.3 — the audit export (PRD §23.2, Phase 1 AD-05).
 *
 * Generated as an async iterable rather than one string. §30.1 requires the
 * export to be reconciled against source records, which means it has to hold
 * every matching row — and a year of audit history assembled in memory would
 * be the thing that breaks first.
 */
@Injectable()
export class AuditExportService {
  async *toCsv(entries: AuditEntry[]): AsyncGenerator<string> {
    yield `${EXPORT_COLUMNS.join(',')}\n`;
    for (const entry of entries) {
      yield `${row(entry).map(csvCell).join(',')}\n`;
    }
  }

  /**
   * A JSON array, emitted incrementally.
   *
   * Written by hand rather than JSON.stringify on the whole collection, for
   * the same reason as CSV: the caller receives the first bytes before the
   * last row has been read.
   */
  async *toJson(entries: AuditEntry[]): AsyncGenerator<string> {
    yield '[';
    let first = true;
    for (const entry of entries) {
      yield (first ? '' : ',') +
        JSON.stringify(
          Object.fromEntries(
            EXPORT_COLUMNS.map((column, index) => [column, row(entry)[index] || null]),
          ),
        );
      first = false;
    }
    yield ']';
  }
}
