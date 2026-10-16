import type { CatalogEvent } from "../placement/client.ts";
import type { DriveRow, DriveStatus } from "../db/drive.ts";

export type DiffActionKind = "insert" | "touch" | "refresh" | "markNotApplied";

export type DiffAction = {
  kind: DiffActionKind;
  id: string;
  event?: CatalogEvent;
  isEligible: boolean | null;
  statusOnInsert: DriveStatus | null;
  setStatusNewIfNull: boolean;
  fetchDetail: boolean;
  alertMissingEligibility?: boolean;
};

export type DiffResult = {
  actions: DiffAction[];
  alerts: string[];
};

/** Normalize platform timestamps so Postgres timestamptz round-trips compare equal. */
export function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return value;
  }
  return new Date(ms).toISOString();
}

function platformUpdatedAt(event: CatalogEvent): string | null {
  return normalizeTimestamp(event.updatedAt);
}

function eligibilityOf(event: CatalogEvent): boolean | null {
  if (typeof event.isEligible === "boolean") {
    return event.isEligible;
  }
  return null;
}

function deadlineOf(event: CatalogEvent): string | null {
  return normalizeTimestamp(event.deadline);
}

/**
 * Pure catalog diff. No I/O.
 * Compare updatedAt as platform ISO strings. Do not recompute eligibility.
 */
export function diffCatalog(
  events: CatalogEvent[],
  existing: DriveRow[],
  now: Date = new Date(),
): DiffResult {
  const byId = new Map(existing.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const actions: DiffAction[] = [];
  const alerts: string[] = [];

  for (const event of events) {
    const id = event._id;
    seen.add(id);
    const isEligible = eligibilityOf(event);
    const missingFlag = isEligible === null;
    if (missingFlag) {
      alerts.push(`missing_isEligible:${id}`);
    }

    const row = byId.get(id);
    if (!row) {
      actions.push({
        kind: "insert",
        id,
        event,
        isEligible,
        statusOnInsert: isEligible === true ? "New" : null,
        setStatusNewIfNull: false,
        fetchDetail: isEligible === true,
        alertMissingEligibility: missingFlag,
      });
      continue;
    }

    const prevUpdated = normalizeTimestamp(row.updated_at_platform);
    const nextUpdated = platformUpdatedAt(event);
    const updatedChanged = prevUpdated !== nextUpdated;
    const eligibilityChanged = row.is_eligible !== isEligible;
    const deadlineChanged = normalizeTimestamp(row.deadline) !== deadlineOf(event);

    if (!updatedChanged && !eligibilityChanged && !deadlineChanged) {
      actions.push({
        kind: "touch",
        id,
        event,
        isEligible,
        statusOnInsert: null,
        setStatusNewIfNull: false,
        fetchDetail: false,
        alertMissingEligibility: missingFlag,
      });
      continue;
    }

    const becameEligible = row.is_eligible !== true && isEligible === true;
    actions.push({
      kind: "refresh",
      id,
      event,
      isEligible,
      statusOnInsert: null,
      setStatusNewIfNull: becameEligible && row.status === null,
      fetchDetail: updatedChanged || becameEligible,
      alertMissingEligibility: missingFlag,
    });
  }

  const nowMs = now.getTime();
  for (const row of existing) {
    if (row.status !== "New") {
      continue;
    }
    if (!seen.has(row.id)) {
      actions.push({
        kind: "markNotApplied",
        id: row.id,
        isEligible: row.is_eligible,
        statusOnInsert: null,
        setStatusNewIfNull: false,
        fetchDetail: false,
      });
      continue;
    }
    if (row.deadline) {
      const deadlineMs = Date.parse(row.deadline);
      if (Number.isFinite(deadlineMs) && deadlineMs < nowMs) {
        // Only if not already queued from missing-catalog above.
        if (!actions.some((a) => a.kind === "markNotApplied" && a.id === row.id)) {
          actions.push({
            kind: "markNotApplied",
            id: row.id,
            isEligible: row.is_eligible,
            statusOnInsert: null,
            setStatusNewIfNull: false,
            fetchDetail: false,
          });
        }
      }
    }
  }

  // Also mark New rows that appear in this catalog but whose deadline is already past.
  for (const action of actions) {
    if (action.kind === "insert" || action.kind === "refresh" || action.kind === "touch") {
      const event = action.event;
      if (!event) {
        continue;
      }
      const deadline = deadlineOf(event);
      if (!deadline) {
        continue;
      }
      const deadlineMs = Date.parse(deadline);
      if (!Number.isFinite(deadlineMs) || deadlineMs >= nowMs) {
        continue;
      }
      const row = byId.get(action.id);
      const wouldBeNew =
        action.kind === "insert"
          ? action.statusOnInsert === "New"
          : row?.status === "New" || (action.setStatusNewIfNull && action.isEligible === true);
      if (wouldBeNew || row?.status === "New") {
        if (!actions.some((a) => a.kind === "markNotApplied" && a.id === action.id)) {
          actions.push({
            kind: "markNotApplied",
            id: action.id,
            isEligible: action.isEligible,
            statusOnInsert: null,
            setStatusNewIfNull: false,
            fetchDetail: false,
          });
        }
      }
    }
  }

  return { actions, alerts };
}

export function extractPdfUrls(event: CatalogEvent | Record<string, unknown>): string[] {
  const urls = event.pdfUrls;
  if (!Array.isArray(urls)) {
    return [];
  }
  return urls.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function eventDisplayFields(event: CatalogEvent): {
  companyId: string | null;
  companyName: string | null;
  companyUsername: string | null;
  eventName: string | null;
  updatedAtPlatform: string | null;
  deadline: string | null;
} {
  return {
    companyId: typeof event.companyId === "string" ? event.companyId : null,
    companyName: typeof event.companyName === "string" ? event.companyName : null,
    companyUsername: typeof event.companyUsername === "string" ? event.companyUsername : null,
    eventName: typeof event.eventName === "string" ? event.eventName : null,
    updatedAtPlatform: platformUpdatedAt(event),
    deadline: deadlineOf(event),
  };
}
