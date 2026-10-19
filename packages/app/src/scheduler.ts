import {
  type Db,
  DEFAULT_SYNC,
  inWindow,
  nowIso,
  parseDuration,
  type SyncConfig,
  type SyncSource,
} from '@orgspec/core';

export interface SourceState {
  source: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  failures: number;
  status: 'idle' | 'running' | 'ok' | 'error' | 'paused';
  message?: string;
  effectiveIntervalMs?: number;
  /** When the source runs next; undefined while paused off hours. */
  nextRunAt?: string;
}

const MAX_BACKOFF = 8;

function isWorkingTime(now: Date, wh: SyncConfig['workingHours']): boolean {
  if (!wh.days.includes(now.getDay())) return false;
  return inWindow(now, wh.start, wh.end);
}

/**
 * The interval a source runs at right now: the admin default or the person's own (within min..max
 * when the source allows it), slowed or paused off hours, and doubled per consecutive failure.
 */
export function effectiveInterval(
  cfg: SyncSource,
  o: { personal?: string; failures: number; now: Date; workingHours: SyncConfig['workingHours'] },
): number | undefined {
  const min = parseDuration(cfg.min);
  const max = parseDuration(cfg.max);
  let every = parseDuration(cfg.every);
  if (cfg.personal && o.personal) every = Math.min(max, Math.max(min, parseDuration(o.personal)));
  if (!isWorkingTime(o.now, o.workingHours)) {
    if (cfg.offHours === 'pause') return undefined;
    if (cfg.offHours === 'slow') every = Math.max(every, parseDuration(cfg.offHoursEvery));
  }
  if (o.failures > 0) every = Math.min(max * 4, every * 2 ** Math.min(o.failures, MAX_BACKOFF));
  return every;
}

export type SyncJob = () => Promise<string | undefined>;

export interface SchedulerOptions {
  db: Db;
  sync: SyncConfig & { sources: Record<string, SyncSource> };
  personal: Record<string, string>;
  jobs: Record<string, SyncJob>;
  now?: () => Date;
  onEvent?: (e: { source: string; ok: boolean; message?: string; ms: number }) => void;
}

/** Polls each source on its own interval. One run per source at a time; state lives in sync_state. */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<string>();
  constructor(private readonly o: SchedulerOptions) {}

  private cfg(source: string): SyncSource | undefined {
    return this.o.sync.sources[source] ?? DEFAULT_SYNC[source];
  }

  state(source: string): SourceState {
    const r = this.o.db.prepare('select * from sync_state where source = ?').get(source) as
      | Record<string, string | number | null>
      | undefined;
    return {
      source,
      failures: Number(r?.clean_runs ?? 0) < 0 ? -Number(r?.clean_runs) : 0,
      status: (r?.status as SourceState['status']) ?? 'idle',
      ...(r?.last_run_at ? { lastRunAt: String(r.last_run_at) } : {}),
      ...(r?.last_success_at ? { lastSuccessAt: String(r.last_success_at) } : {}),
      ...(r?.message ? { message: String(r.message) } : {}),
      ...(r?.effective_interval_ms ? { effectiveIntervalMs: Number(r.effective_interval_ms) } : {}),
    };
  }

  states(): SourceState[] {
    const now = (this.o.now ?? (() => new Date()))();
    return Object.keys(this.o.jobs).map((source) => {
      const st = this.state(source);
      const cfg = this.cfg(source);
      const every = cfg
        ? effectiveInterval(cfg, {
            failures: st.failures,
            now,
            workingHours: this.o.sync.workingHours,
            ...(this.o.personal[source] ? { personal: this.o.personal[source] } : {}),
          })
        : undefined;
      if (every === undefined)
        return { ...st, ...(cfg ? { status: st.status === 'running' ? st.status : 'paused' } : {}) } as SourceState;
      const next = st.lastRunAt ? new Date(Math.max(now.getTime(), Date.parse(st.lastRunAt) + every)) : now;
      return { ...st, nextRunAt: next.toISOString() };
    });
  }

  /** Runs left `running` by a process that stopped mid-sync are marked interrupted, so they show and retry. */
  recoverInterrupted(): number {
    const r = this.o.db
      .prepare(
        "update sync_state set status = 'error', message = 'interrupted: OrgSpec stopped during this sync', last_run_at = null where status = 'running'",
      )
      .run();
    return Number(r.changes);
  }

  private save(
    source: string,
    patch: { status: string; message?: string | null; ok?: boolean; failures: number; interval?: number },
  ): void {
    const now = nowIso();
    this.o.db
      .prepare(
        `insert into sync_state (source, last_run_at, last_success_at, effective_interval_ms, clean_runs, status, message)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict(source) do update set last_run_at = excluded.last_run_at,
           last_success_at = coalesce(excluded.last_success_at, sync_state.last_success_at),
           effective_interval_ms = excluded.effective_interval_ms, clean_runs = excluded.clean_runs,
           status = excluded.status, message = excluded.message`,
      )
      .run(
        source,
        now,
        patch.ok ? now : null,
        patch.interval ?? null,
        -patch.failures,
        patch.status,
        patch.message ?? null,
      );
  }

  /** Sources due now. */
  due(): string[] {
    const now = (this.o.now ?? (() => new Date()))();
    return Object.keys(this.o.jobs).filter((source) => {
      if (this.running.has(source)) return false;
      const cfg = this.cfg(source);
      if (!cfg) return false;
      const st = this.state(source);
      const every = effectiveInterval(cfg, {
        failures: st.failures,
        now,
        workingHours: this.o.sync.workingHours,
        ...(this.o.personal[source] ? { personal: this.o.personal[source] } : {}),
      });
      if (every === undefined) return false;
      return !st.lastRunAt || now.getTime() - Date.parse(st.lastRunAt) >= every;
    });
  }

  async runSource(source: string): Promise<void> {
    const job = this.o.jobs[source];
    if (!job || this.running.has(source)) return;
    this.running.add(source);
    const st = this.state(source);
    const started = Date.now();
    this.save(source, { status: 'running', failures: st.failures });
    try {
      const message = await job();
      const cfg = this.cfg(source);
      const interval = cfg
        ? effectiveInterval(cfg, { failures: 0, now: new Date(), workingHours: this.o.sync.workingHours })
        : undefined;
      this.save(source, {
        status: 'ok',
        message: message ?? null,
        ok: true,
        failures: 0,
        ...(interval ? { interval } : {}),
      });
      this.o.onEvent?.({ source, ok: true, ...(message ? { message } : {}), ms: Date.now() - started });
    } catch (e) {
      this.save(source, { status: 'error', message: (e as Error).message, failures: st.failures + 1 });
      this.o.onEvent?.({ source, ok: false, message: (e as Error).message, ms: Date.now() - started });
    } finally {
      this.running.delete(source);
    }
  }

  async tick(): Promise<void> {
    await Promise.all(this.due().map((s) => this.runSource(s)));
  }

  start(everyMs = 15_000): void {
    this.stop();
    this.recoverInterrupted();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
