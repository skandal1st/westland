/**
 * Job runner contract skeleton (M0).
 *
 * This only fixes the shape of the durable-job boundary so later modules can
 * depend on it. There is deliberately NO implementation, NO scheduler and NO
 * provider here — the durable PostgreSQL-backed runner (IntegrationJob /
 * IntegrationAttempt / Outbox / Inbox / SyncCheckpoint / IntegrationError) is
 * built in M4. Nothing runs on a timer at M0.
 */

export type JobContext = {
  /** Stable, caller-supplied key. Re-running a job with the same key must be a no-op or safe retry. */
  idempotencyKey: string
  /** Attempt number, 1-based. Bounded by the runner in M4. */
  attempt: number
  signal?: AbortSignal
}

export type JobResult =
  | { status: 'success'; checkpoint?: string }
  | { status: 'retry'; reason: string; availableInMs?: number }
  | { status: 'failed'; reason: string }

export interface JobHandler<Input = unknown> {
  readonly type: string
  run(input: Input, ctx: JobContext): Promise<JobResult>
}

/**
 * Placeholder runner interface. Implemented in M4 against durable state.
 * Present now so domain modules can type against it without importing an impl.
 */
export interface JobRunner {
  register(handler: JobHandler): void
  enqueue(type: string, input: unknown, idempotencyKey: string): Promise<void>
}
