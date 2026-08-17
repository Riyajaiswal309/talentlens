import { useEffect, useRef, useState } from 'react';
import type { PipelineStage } from './usePipeline';

/**
 * The "Move to…" control on a card (RC-09's primary action).
 *
 * A MENU, NOT DRAG-ONLY — and that is a correctness decision, not a shortcut.
 * Table 5.1 asks for draggable cards, but NFR4 commits the project to WCAG 2.1
 * AA, and 2.1.1 Keyboard (Level A) requires every function to be operable from
 * a keyboard. Native HTML5 drag-and-drop is not, and no accessible drag library
 * is a dependency of this project. A menu of real buttons is keyboard-operable
 * by construction, reaches the identical endpoint, and leaves drag free to be
 * added later as a REDUNDANT path rather than the only one.
 *
 * Only this job's real stages are offered — the API validates `toStage` against
 * the job's own `pipeline_stages` and rejects anything else with a 400 listing
 * the valid names, so an invented option could only ever fail.
 */
export function MoveStageMenu({
  stages,
  currentStage,
  candidateName,
  onMove,
  pending,
}: {
  stages: PipelineStage[];
  currentStage: string;
  /** Named in the confirmation so the recruiter sees who they are rejecting. */
  candidateName: string;
  onMove: (toStage: string) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Escape closes, and a click elsewhere dismisses — expected of any menu, and
  // Escape is the only exit for someone not using a pointer.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  function choose(stage: PipelineStage) {
    setOpen(false);

    if (stage.name === currentStage) return; // Already here; the API no-ops too.

    /*
     * BR-01 — a terminal transition needs explicit human authorship. Flow 7:
     * "no system actor may perform this transition; the confirm makes the human
     * authorship unambiguous". The candidate is named so the decision cannot be
     * made about the wrong person by accident.
     */
    if (stage.isTerminal) {
      const message =
        stage.name === 'Rejected'
          ? `Move ${candidateName} to Rejected? This is a final decision and the candidate is notified.`
          : `Move ${candidateName} to ${stage.name}? This is a terminal stage and the candidate is notified.`;
      if (!window.confirm(message)) return;
    }

    onMove(stage.name);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={pending}
        aria-disabled={pending}
        aria-haspopup="menu"
        aria-expanded={open}
        className="h-8 w-full rounded-sm border border-neutral-300 bg-neutral-0 px-2 text-xs font-semibold text-neutral-900 hover:bg-neutral-100 disabled:opacity-40"
      >
        {pending ? 'Moving…' : 'Move to…'}
      </button>

      {open && (
        /*
         * IN NORMAL FLOW, NOT ABSOLUTE. The board scrolls horizontally, and
         * `overflow-x-auto` on that container clips absolutely-positioned
         * descendants — an overlay menu was cut off after its first item, so
         * the later stages were in the DOM but unreachable by pointer. Letting
         * the menu expand the card costs a little layout shift and cannot be
         * clipped by any ancestor.
         *
         * Real buttons in DOM order, so Tab and Shift+Tab walk the options with
         * no key handling of our own.
         */
        <div
          role="menu"
          aria-label={`Move ${candidateName} to another stage`}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-neutral-0 py-1"
        >
          {stages.map((stage) => {
            const isCurrent = stage.name === currentStage;
            return (
              <button
                key={stage.name}
                type="button"
                role="menuitem"
                onClick={() => choose(stage)}
                disabled={isCurrent}
                aria-disabled={isCurrent}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${
                  isCurrent
                    ? 'cursor-not-allowed text-neutral-300'
                    : 'text-neutral-900 hover:bg-neutral-100'
                }`}
              >
                <span>{stage.name}</span>
                {isCurrent && <span className="text-neutral-300">Current</span>}
                {/* Flagged before the click, so the confirm is not a surprise. */}
                {!isCurrent && stage.isTerminal && <span className="text-neutral-500">Final</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
