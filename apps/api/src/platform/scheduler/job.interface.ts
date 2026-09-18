/**
 * A periodic unit of work registered with `SchedulerRunner`. `run()` owns its own
 * partial-failure handling — the runner only guards against two runs of the same
 * job overlapping; it has no opinion on what one bad row inside a run should do.
 */
export interface Job {
  readonly name: string;
  run(): Promise<void>;
}
