/** Transient failure: the orchestrator retries with exponential backoff (bounded by max_attempts). */
export class RetryableError extends Error {
  constructor(message: string) { super(message); this.name = 'RetryableError'; }
}
/** Permanent failure: the task goes straight to the dead-letter queue. */
export class PermanentError extends Error {
  constructor(message: string) { super(message); this.name = 'PermanentError'; }
}
/** Capacity unavailable (no AI model / budget exhausted): re-queue later without consuming an attempt. */
export class DeferError extends Error {
  constructor(message: string, public readonly seconds = 900) { super(message); this.name = 'DeferError'; }
}
