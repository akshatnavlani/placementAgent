export const POLL_INTERVAL_MS = 5 * 60 * 1000;

export type PollSchedulerDeps = {
  /** Run one poll cycle. */
  run: () => Promise<unknown>;
  /** Called at tick fire (period start), before run — only when not skipped. */
  onTick?: (firedAt: Date) => void | Promise<void>;
  intervalMs?: number;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  log?: {
    info?: (obj: Record<string, unknown>, msg?: string) => void;
    warn?: (obj: Record<string, unknown>, msg?: string) => void;
  };
};

export type PollSchedulerHandle = {
  stop: () => void;
  /** Test seam: whether a poll is in flight. */
  isRunning: () => boolean;
};

/**
 * Fixed-cadence poll loop from period start (not “sleep interval after finish”).
 * Always queues the next tick immediately; skips work if previous run is still in flight.
 */
export function startPollScheduler(deps: PollSchedulerDeps): PollSchedulerHandle {
  const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
  const nowFn = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextFireAt = nowFn() + intervalMs;

  const schedule = () => {
    if (stopped) {
      return;
    }
    const delay = Math.max(0, nextFireAt - nowFn());
    timer = setTimeoutFn(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) {
      return;
    }
    const firedAt = new Date(nowFn());
    // Advance cadence from this fire, then queue the next tick immediately.
    nextFireAt += intervalMs;
    while (nextFireAt <= nowFn()) {
      nextFireAt += intervalMs;
    }
    schedule();

    if (running) {
      deps.log?.warn?.({ nextFireAt }, "poll tick skipped; previous still running");
      return;
    }

    running = true;
    try {
      await deps.onTick?.(firedAt);
      await deps.run();
      deps.log?.info?.({ firedAt: firedAt.toISOString() }, "scheduled poll complete");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "poll error";
      deps.log?.warn?.({ reason }, "scheduled poll failed");
    } finally {
      running = false;
    }
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeoutFn(timer);
        timer = undefined;
      }
    },
    isRunning: () => running,
  };
}

/** Pure helper for tests: next fire after a tick at `firedAt`. */
export function nextPollFireAt(firedAtMs: number, intervalMs = POLL_INTERVAL_MS): number {
  return firedAtMs + intervalMs;
}
