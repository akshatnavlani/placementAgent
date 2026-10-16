import type { DriveRow } from "../db/drive.ts";
import type { DiffAction } from "../poll/diff.ts";
import { materialSnapshot } from "./format.ts";

export type ShouldAlertInput = {
  action: DiffAction;
  /** Row state before this poll's upsert (undefined on insert). */
  previous: DriveRow | undefined;
  /** Row state after upsert. */
  next: DriveRow;
};

/**
 * Decide whether to send a Telegram alert for this poll action.
 * Never alerts ineligible drives or unchanged touches.
 */
export function shouldAlert(input: ShouldAlertInput): boolean {
  const { action, previous, next } = input;

  if (next.is_eligible !== true || next.status !== "New") {
    return false;
  }
  if (action.kind === "touch" || action.kind === "markNotApplied") {
    return false;
  }

  if (action.kind === "insert") {
    return action.isEligible === true && next.alerted_at == null;
  }

  if (action.kind === "refresh") {
    // First time becoming New (status was null).
    if (action.setStatusNewIfNull) {
      return previous?.alerted_at == null;
    }
    // Material re-alert only after we have already notified once.
    if (previous?.alerted_at) {
      return materialSnapshot(previous) !== materialSnapshot(next);
    }
    return false;
  }

  return false;
}
