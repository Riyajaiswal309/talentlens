import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CalendarProvider,
  ManualCalendarProvider,
  type CalendarEvent,
  type InterviewerAvailability,
} from './calendar.provider';

/**
 * FR6.1 — the interviewer-availability seam.
 *
 * STRUCTURAL ONLY. No provider is implemented, no route calls this, and FR6.1
 * is not complete: an ownership model, an OAuth contract, token storage and a
 * consent flow remain unspecified (register section F). What these tests pin
 * is the shape of the boundary and the meaning of `null`, because those are
 * the two things a future provider must not quietly redefine.
 *
 * The distinction the seam exists to make: `isAvailable()` answers "is the
 * provider reachable" (FR6.3); `getAvailability()` answers "when is this
 * person committed" (FR6.1). They were one word apart and a whole requirement
 * apart, which is how the second went missing until the FR6.1 inspection.
 */
describe('CalendarProvider availability seam (FR6.1)', () => {
  const window = () => ({
    from: new Date('2026-09-01T09:00:00.000Z'),
    to: new Date('2026-09-01T17:00:00.000Z'),
  });

  describe('ManualCalendarProvider — no provider connected', () => {
    const provider = new ManualCalendarProvider();

    it('returns null, not an empty array', async () => {
      const result = await provider.getAvailability(['interviewer@test.local'], window());

      /*
       * The difference is not cosmetic. `[]` would render RC-11's grid as
       * though the interviewer had no commitments all week — a claim about
       * someone's diary that a deployment with no calendar cannot make. Null
       * means "unknown", which routes the caller to the manual path FR6.3
       * already defines.
       */
      expect(result).toBeNull();
      expect(result).not.toEqual([]);
    });

    it('returns null regardless of how many interviewers are asked about', async () => {
      expect(await provider.getAvailability([], window())).toBeNull();
      expect(await provider.getAvailability(['a@test.local'], window())).toBeNull();
      expect(await provider.getAvailability(['a@test.local', 'b@test.local'], window())).toBeNull();
    });

    it('still reports itself available and still creates no event (FR6.3 unchanged)', async () => {
      // Adding the availability method must not have disturbed the two
      // behaviours graceful degradation depends on.
      expect(provider.isAvailable()).toBe(true);
      expect(
        await provider.createEvent({
          jobTitle: 'Backend Engineer',
          candidateName: 'A Candidate',
          startsAt: new Date(),
          endsAt: new Date(),
          timezone: 'Europe/London',
          interviewerEmails: [],
        }),
      ).toBeNull();
    });
  });

  describe('a provider CAN return busy blocks through this interface', () => {
    /**
     * A stub, not an implementation. It exists to prove the declared shape is
     * expressible and useful — if a future Google or Microsoft binding cannot
     * be written against this signature, the seam is the wrong shape and this
     * test is where that shows up.
     */
    class StubCalendarProvider extends CalendarProvider {
      isAvailable(): boolean {
        return true;
      }
      async createEvent(): Promise<CalendarEvent | null> {
        return { eventId: 'stub-event-1' };
      }
      async getAvailability(
        interviewerEmails: string[],
        w: { from: Date; to: Date },
      ): Promise<InterviewerAvailability[] | null> {
        // One busy hour at the start of the window, per interviewer.
        return interviewerEmails.map((email) => ({
          email,
          busy: [{ startsAt: w.from, endsAt: new Date(w.from.getTime() + 3_600_000) }],
        }));
      }
    }

    const stub = new StubCalendarProvider();

    it('returns one entry per interviewer asked about', async () => {
      const result = await stub.getAvailability(['a@test.local', 'b@test.local'], window());

      expect(result).toHaveLength(2);
      expect(result!.map((r) => r.email)).toEqual(['a@test.local', 'b@test.local']);
    });

    it('carries busy blocks as start/end Dates', async () => {
      const w = window();
      const [first] = (await stub.getAvailability(['a@test.local'], w))!;

      expect(first!.busy).toHaveLength(1);
      expect(first!.busy[0]!.startsAt).toBeInstanceOf(Date);
      expect(first!.busy[0]!.endsAt).toBeInstanceOf(Date);
      expect(first!.busy[0]!.startsAt.toISOString()).toBe(w.from.toISOString());
      expect(first!.busy[0]!.endsAt.getTime() - first!.busy[0]!.startsAt.getTime()).toBe(3_600_000);
    });

    it('distinguishes "no commitments" from "no provider"', async () => {
      class FreeProvider extends StubCalendarProvider {
        override async getAvailability(
          interviewerEmails: string[],
          _window: { from: Date; to: Date },
        ): Promise<InterviewerAvailability[] | null> {
          // Connected, asked, and the person genuinely has nothing booked.
          return interviewerEmails.map((email) => ({ email, busy: [] }));
        }
      }

      const connected = await new FreeProvider().getAvailability(['a@test.local'], window());
      const unconnected = await new ManualCalendarProvider().getAvailability(
        ['a@test.local'],
        window(),
      );

      // A connected provider says "free": an entry with an empty busy list.
      expect(connected).toEqual([{ email: 'a@test.local', busy: [] }]);
      // No provider says nothing at all.
      expect(unconnected).toBeNull();
    });

    it('reports only busy time — the seam carries no event contents', async () => {
      const [first] = (await stub.getAvailability(['a@test.local'], window()))!;

      // A provider can say WHEN someone is committed without disclosing what
      // they are doing. Keys are pinned so a future binding cannot widen the
      // boundary to titles, attendees or locations without this failing.
      expect(Object.keys(first!).sort()).toEqual(['busy', 'email']);
      expect(Object.keys(first!.busy[0]!).sort()).toEqual(['endsAt', 'startsAt']);
    });
  });

  describe('the seam is not wired to anything yet', () => {
    /**
     * FR6.1 is deliberately NOT complete. No route calls getAvailability:
     * §23.2 specifies no availability endpoint and Phase 1's Table 12.3 gap
     * list omits one despite RC-11 rendering an availability grid (E3).
     *
     * This asserts the boundary of the approved scope. If it fails, either an
     * endpoint appeared without a specification, or scheduling started
     * depending on availability data that no deployment can supply.
     */
    it('no production code calls getAvailability', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((entry) => {
          const full = join(dir, entry);
          if (statSync(full).isDirectory()) return walk(full);
          return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
        });

      const src = join(__dirname, '..', '..');
      const callers = walk(src).filter(
        (file) =>
          !file.endsWith('calendar.provider.ts') &&
          /\bgetAvailability\s*\(/.test(readFileSync(file, 'utf8')),
      );

      expect(callers).toEqual([]);
    });
  });
});
