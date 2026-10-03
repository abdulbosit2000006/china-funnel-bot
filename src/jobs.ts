// Background work queue on D1, drained by the every-minute cron.

export interface JobRow {
  id: number;
  kind: string;
  payload: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  attempts: number;
}

const LOCK_MINUTES = 5;
export const MAX_ATTEMPTS = 3;

export async function enqueueJob(db: D1Database, kind: string, payload: unknown, now: string): Promise<number> {
  const row = await db
    .prepare("INSERT INTO jobs (kind, payload, run_after, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(kind, JSON.stringify(payload), now, now)
    .first<{ id: number }>();
  return row!.id;
}

/** Atomically takes one due job. A RUNNING job whose lock expired (crashed run) is taken again. */
export function claimJob(db: D1Database, now: Date): Promise<JobRow | null> {
  const at = now.toISOString();
  const lockedUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000).toISOString();
  return db
    .prepare(
      `UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1, locked_until = ?
       WHERE id = (SELECT id FROM jobs
                   WHERE (status = 'QUEUED' AND run_after <= ?) OR (status = 'RUNNING' AND locked_until < ?)
                   ORDER BY id LIMIT 1)
       RETURNING id, kind, payload, status, attempts`,
    )
    .bind(lockedUntil, at, at)
    .first<JobRow>();
}

export async function finishJob(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE jobs SET status = 'DONE', locked_until = NULL WHERE id = ?").bind(id).run();
}

/** Retries with a delay until MAX_ATTEMPTS, then marks FAILED. Returns true when it gave up. */
export async function failJob(db: D1Database, job: JobRow, error: unknown, now: Date): Promise<boolean> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const giveUp = job.attempts >= MAX_ATTEMPTS;
  const retryAt = new Date(now.getTime() + 2 * 60_000).toISOString();
  await db
    .prepare("UPDATE jobs SET status = ?, run_after = ?, locked_until = NULL, last_error = ? WHERE id = ?")
    .bind(giveUp ? "FAILED" : "QUEUED", retryAt, message, job.id)
    .run();
  return giveUp;
}
