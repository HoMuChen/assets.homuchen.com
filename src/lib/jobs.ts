import { db, type JobRun } from "./db";

/**
 * Record one run of a background job, quote feed, or VM heartbeat. A falsy `error` means success.
 * The last error is kept after a later success, so /status can still show what went wrong.
 */
export function recordRun(name: string, error?: string | null, at: Date = new Date()) {
  const iso = at.toISOString();
  db()
    .prepare(
      `INSERT INTO job_runs (name, failing, last_run_at, last_ok_at, last_error_at, last_error)
       VALUES (@name, @failing, @iso, @ok, @errorAt, @error)
       ON CONFLICT(name) DO UPDATE SET failing = excluded.failing, last_run_at = excluded.last_run_at,
         last_ok_at = COALESCE(excluded.last_ok_at, job_runs.last_ok_at),
         last_error_at = COALESCE(excluded.last_error_at, job_runs.last_error_at),
         last_error = COALESCE(excluded.last_error, job_runs.last_error)`,
    )
    .run({ name, failing: error ? 1 : 0, iso, ok: error ? null : iso, errorAt: error ? iso : null, error: error || null });
}

/** Run `fn`, recording its outcome under `name`; errors are recorded and rethrown. */
export async function tracked<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  try {
    const result = await fn();
    recordRun(name);
    return result;
  } catch (e) {
    recordRun(name, (e as Error).message || String(e));
    throw e;
  }
}

export function getRuns(): Map<string, JobRun> {
  const rows = db().prepare("SELECT * FROM job_runs").all() as JobRun[];
  return new Map(rows.map((r) => [r.name, r]));
}

/** The most recent run failed. */
export function isFailing(run: JobRun | undefined | null): boolean {
  return run?.failing === 1;
}
