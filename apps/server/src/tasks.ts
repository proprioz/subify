import { runPassIfDue } from './catalog/pass';
import { addSeededChannel } from './catalog/seeding';
import { logError } from './log';
import { refreshDictionary } from './search/dictionary';
import type { Platform } from './platform';
import type { SourceAdapter } from './sources/source';

/**
 * Work that runs on a schedule. A single trigger fires every minute, on Workers (Cron Trigger)
 * and on Node (src/node/scheduler.ts) alike, and each task says how often it is due. This keeps
 * one schedule for both runtimes, and one Cron Trigger out of the five the Free plan allows.
 */
export interface ScheduledTask {
  name: string;
  everyMinutes: number;
  run(platform: Platform, sources: readonly SourceAdapter[]): Promise<unknown>;
}

export const scheduledTasks: readonly ScheduledTask[] = [
  { name: 'seeding', everyMinutes: 1, run: addSeededChannel },
  // The pass polls, renews WebSub and drops old items; it decides itself when its period comes round.
  { name: 'pass', everyMinutes: 1, run: runPassIfDue },
  // Off without WIKIDATA_USER_AGENT; while a refresh runs, one slice a minute.
  { name: 'dictionary', everyMinutes: 1, run: refreshDictionary },
];

export function isDue(task: ScheduledTask, now: number): boolean {
  return Math.floor(now / 60_000) % task.everyMinutes === 0;
}

/**
 * Runs the tasks due this minute, one after the other. A failing task does not stop the others.
 * Both entry points call this, so Workers and Node run exactly the same schedule.
 */
export async function runDueTasks(
  platform: Platform,
  sources: readonly SourceAdapter[],
  tasks: readonly ScheduledTask[] = scheduledTasks,
): Promise<void> {
  const now = platform.clock.now();

  for (const task of tasks) {
    if (!isDue(task, now)) {
      continue;
    }

    try {
      await task.run(platform, sources);
    } catch (error) {
      logError(`Scheduled task ${task.name} failed`, error);
    }
  }
}
