import { describe, expect, it } from "vitest";
import {
  nextPollFireAt,
  POLL_INTERVAL_MS,
  startPollScheduler,
} from "../app/poll/scheduler.ts";

describe("nextPollFireAt", () => {
  it("adds interval from fire time", () => {
    expect(nextPollFireAt(1_000_000, 300_000)).toBe(1_300_000);
    expect(POLL_INTERVAL_MS).toBe(300_000);
  });
});

describe("startPollScheduler", () => {
  it("schedules first tick after intervalMs and can stop", () => {
    let now = 1_000;
    const timeouts: Array<{ at: number; id: number }> = [];
    let idSeq = 0;
    const cleared: number[] = [];

    const handle = startPollScheduler({
      intervalMs: 5_000,
      now: () => now,
      setTimeoutFn: ((_fn: () => void, ms: number) => {
        const id = ++idSeq;
        timeouts.push({ at: now + Number(ms), id });
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: ((id: ReturnType<typeof setTimeout>) => {
        cleared.push(id as unknown as number);
      }) as typeof clearTimeout,
      run: async () => undefined,
    });

    expect(timeouts).toEqual([{ at: 6_000, id: 1 }]);
    handle.stop();
    expect(cleared).toEqual([1]);
  });

  it("does not start a second run while one is in flight", async () => {
    let now = 0;
    type Entry = { at: number; fn: () => void };
    const pending: Entry[] = [];
    const runs: number[] = [];
    let unblock!: () => void;
    const blocked = new Promise<void>((r) => {
      unblock = r;
    });

    startPollScheduler({
      intervalMs: 10,
      now: () => now,
      setTimeoutFn: ((fn: () => void, ms: number) => {
        pending.push({ at: now + Number(ms), fn: fn as () => void });
        return pending.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeoutFn: (() => undefined) as typeof clearTimeout,
      run: async () => {
        runs.push(now);
        if (runs.length === 1) {
          await blocked;
        }
      },
    });

    // Fire first scheduled tick
    now = pending[0]!.at;
    const first = pending.shift()!;
    void first.fn();
    // Allow microtasks so run() starts and schedule() queues next
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(runs).toEqual([now]);

    // There should be a follow-up timeout queued from inside tick
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const second = pending[pending.length - 1]!;
    now = second.at;
    second.fn();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    // Still only one run — overlap skipped
    expect(runs).toHaveLength(1);

    unblock();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });
});
