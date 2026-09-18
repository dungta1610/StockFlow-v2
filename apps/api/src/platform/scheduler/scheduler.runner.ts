import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Job } from './job.interface';

/**
 * Runs registered jobs on their own interval. Each job guards against overlapping
 * itself: if a tick fires while the previous run of that job has not finished, the
 * tick is skipped rather than starting a second run concurrently. This module knows
 * nothing about what a job does — only that it is named and periodic; the policy
 * (which job, what interval) lives in `modules/`.
 */
@Injectable()
export class SchedulerRunner implements OnApplicationShutdown {
  private readonly logger = new Logger(SchedulerRunner.name);
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();

  schedule(job: Job, intervalMs: number): void {
    if (this.timers.has(job.name)) throw new Error(`Job "${job.name}" is already scheduled`);
    const timer = setInterval(() => void this.tick(job), intervalMs);
    timer.unref?.();
    this.timers.set(job.name, timer);
  }

  private async tick(job: Job): Promise<void> {
    if (this.running.has(job.name)) return;
    this.running.add(job.name);
    try {
      await job.run();
    } catch (err) {
      // A job that rejects entirely (rather than handling its own row failures) must
      // not take the timer down with it — the next tick still fires.
      this.logger.error(`Job "${job.name}" failed: ${(err as Error).message}`);
    } finally {
      this.running.delete(job.name);
    }
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.running.clear();
  }
}
