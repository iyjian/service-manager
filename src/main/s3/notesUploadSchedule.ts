export const NOTES_UPLOAD_IDLE_MS = 30_000;
export const NOTES_UPLOAD_MAX_WAIT_MS = 300_000;
export const NOTES_UPLOAD_MAX_RETRY_MS = 900_000;

/** Independent of remote polling; activity never postpones the maximum wait or retry floor. */
export class NotesUploadSchedule {
  private firstChange?: number;
  private lastChange = 0;
  private retryAt = 0;
  private failures = 0;
  private lastSuccess?: number;

  changed(now: number): void {
    this.firstChange ??= now;
    this.lastChange = now;
  }

  delay(now: number): number | undefined {
    if (this.firstChange === undefined) return undefined;
    return Math.max(0, Math.max(this.retryAt,
      Math.min(this.lastChange + NOTES_UPLOAD_IDLE_MS, (this.lastSuccess ?? this.firstChange) + NOTES_UPLOAD_MAX_WAIT_MS)) - now);
  }

  canExpedite(now: number): boolean { return now >= this.retryAt; }

  succeeded(now: number, pending: boolean): void {
    this.failures = 0;
    this.retryAt = 0;
    this.lastSuccess = now;
    this.firstChange = pending ? now : undefined;
  }

  failed(now: number): void {
    this.changedIfMissing(now);
    this.retryAt = now + Math.min(NOTES_UPLOAD_IDLE_MS * 2 ** Math.min(this.failures++, 5), NOTES_UPLOAD_MAX_RETRY_MS);
  }

  private changedIfMissing(now: number): void {
    if (this.firstChange === undefined) this.changed(now);
  }
}
