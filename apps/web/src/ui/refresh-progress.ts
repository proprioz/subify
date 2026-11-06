import { useEffect, useRef, useState } from 'react';

/**
 * The loading bar of a feed refresh.
 *
 * A sync that reads one page does not tell how far it got, so the bar runs on time: it heads for
 * {@link WAITING_CAP} at the end of an estimate, the length of the last sync, and only creeps on
 * once that is overdue. When the sync is over, it fills up within a short time and then hides.
 * The speed eases towards the one it needs, so the bar never goes back. A sync that reads several
 * pages, after an absence, tells how far it got after each one: the bar moves up to that.
 */

/** A sync that finishes sooner still fills the bar across this time, so it can be seen. */
export const MINIMUM_VISIBLE_MS = 500;

/** The estimate before any sync was measured in this session. */
export const FIRST_ESTIMATE_MS = 1_000;

/** Where the bar heads at the estimated end. It only fills up once the sync is over. */
export const WAITING_CAP = 95;

/** Where the bar creeps towards once the estimate is overdue. */
export const OVERDUE_CAP = 99;

/** How slowly the bar creeps once the estimate is overdue. */
const CREEP_MS = 30_000;

/** How gently the bar slows down as it nears the waiting cap. */
const BRAKE_MS = 1_500;

/** Time the speed takes to cover about two thirds of a change of pace. */
const SPEED_SMOOTHING_MS = 400;

/** Shortest time the bar takes to fill up once the sync is over. */
const FINISH_MS = 250;

/** Time added per percent left, so a sync that ends sooner than estimated fills up as smoothly. */
const FINISH_MS_PER_PERCENT = 10;

/** How long a full bar stays before it hides. */
const HOLD_MS = 200;

/** How long the bar takes to fill up from this width once the sync is over. */
export function finishMs(shown: number): number {
  return Math.max(FINISH_MS, Math.ceil(Math.max(0, 100 - shown) * FINISH_MS_PER_PERCENT));
}

/**
 * The bar's width (percent) and speed (percent per millisecond) on the next frame. While the
 * sync runs, the speed eases towards the one that reaches the waiting cap when the estimate
 * ends, slowing down as the bar nears it, and only creeps on past it or once it is overdue. Once the sync is over, the bar fills up within the
 * time left.
 */
export function advance(shown: number, speed: number, remainingMs: number, frameMs: number, finished: boolean): [number, number] {
  frameMs = Math.max(0, frameMs);

  if (finished) {
    speed = Math.max(0, 100 - shown) / Math.max(frameMs, remainingMs, 1);
    shown = Math.min(100, shown + speed * frameMs);

    return [100 - shown < 0.1 ? 100 : shown, speed];
  }

  const creepSpeed = Math.max(0, OVERDUE_CAP - shown) / CREEP_MS;
  const onTimeSpeed = remainingMs > 0 ? (WAITING_CAP - shown) / Math.max(remainingMs, SPEED_SMOOTHING_MS) : 0;
  const brakedSpeed = Math.max(0, WAITING_CAP - shown) / BRAKE_MS;
  const wantedSpeed = Math.max(creepSpeed, Math.min(onTimeSpeed, brakedSpeed));

  speed += (wantedSpeed - speed) * (1 - Math.exp(-frameMs / SPEED_SMOOTHING_MS));
  shown = Math.min(OVERDUE_CAP, shown + Math.max(0, speed) * frameMs);

  return [shown, speed];
}

interface Run {
  startedAt: number;
  estimatedMs: number;
  shown: number;
  speed: number;
  frameAt: number;
  /** When the bar must be full, once the sync is over. */
  finishBy: number | null;
}

/**
 * The width of the loading bar while `running` is true and as it fills up afterwards, or null
 * when the bar is hidden. `done` is how far the sync says it got, in percent, when it knows.
 */
export function useRefreshProgress(running: boolean, done = 0): number | null {
  const [progress, setProgress] = useState<number | null>(null);
  const run = useRef<Run | null>(null);
  const lastMs = useRef(FIRST_ESTIMATE_MS);
  const known = useRef(done);
  known.current = done;

  useEffect(() => {
    const now = performance.now();
    const current = run.current;
    let frame = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;

    if (running) {
      // A sync that starts while the bar fills up carries on from where the bar is.
      if (current === null || current.shown >= 100) {
        run.current = { startedAt: now, estimatedMs: lastMs.current, shown: 0, speed: 0, frameAt: now, finishBy: null };
      } else {
        current.startedAt = now;
        current.finishBy = null;
      }
    } else if (current === null) {
      return;
    } else if (current.finishBy === null) {
      lastMs.current = Math.max(1, now - current.startedAt);
      current.finishBy = Math.max(now + finishMs(current.shown), current.startedAt + MINIMUM_VISIBLE_MS);
    }

    const tick = () => {
      const bar = run.current!;
      const at = performance.now();
      const remainingMs = (bar.finishBy ?? bar.startedAt + bar.estimatedMs) - at;

      [bar.shown, bar.speed] = advance(bar.shown, bar.speed, remainingMs, at - bar.frameAt, bar.finishBy !== null);
      // A long sync tells how far it got: the bar never stays behind that.
      bar.shown = Math.max(bar.shown, Math.min(OVERDUE_CAP, known.current));
      bar.frameAt = at;
      setProgress(bar.shown);

      if (bar.finishBy !== null && bar.shown >= 100) {
        hold = setTimeout(() => {
          run.current = null;
          setProgress(null);
        }, HOLD_MS);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };

    run.current!.frameAt = now;
    tick();

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(hold);
    };
  }, [running]);

  return progress;
}
