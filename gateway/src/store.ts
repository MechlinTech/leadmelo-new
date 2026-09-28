import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { GatewayHttpError } from './errors';

// Idempotency results, "already enriched" markers and search cursors. In memory, with optional
// append-only file persistence so a gateway restart does not repurchase vendor data. A single
// gateway process is assumed: for several instances, replace this class with a shared database.
export class GatewayStore {
  private results = new Map<string, { hash: string; value: unknown }>();
  private inflight = new Map<string, { hash: string; promise: Promise<unknown> }>();
  private seen = new Set<string>();
  private cursors = new Map<string, number>();
  constructor(private file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          if (r.t === 'r') this.results.set(r.k, { hash: r.hash, value: r.v });
          else if (r.t === 's') this.seen.add(r.k);
          else if (r.t === 'c') this.cursors.set(r.k, r.v);
        } catch { /* ignore a torn final line */ }
      }
    }
  }
  private persist(record: object) { if (this.file) appendFileSync(this.file, JSON.stringify(record) + '\n', { mode: 0o600 }); }

  // The same key with the same request returns the same result, and concurrent calls share one execution.
  // The same key with a different request is refused. Failures and non-cacheable results are not stored.
  run<T>(key: string, hash: string, fn: () => Promise<T>, cacheable: (v: T) => boolean = () => true): Promise<T> {
    const done = this.results.get(key);
    if (done) { if (done.hash !== hash) throw new GatewayHttpError(422, 'idempotency_key_reused'); return Promise.resolve(done.value as T); }
    const running = this.inflight.get(key);
    if (running) { if (running.hash !== hash) throw new GatewayHttpError(422, 'idempotency_key_reused'); return running.promise as Promise<T>; }
    const promise = fn().then(value => {
      this.inflight.delete(key);
      if (cacheable(value)) { this.results.set(key, { hash, value }); this.persist({ t: 'r', k: key, hash, v: value }); }
      return value;
    }, error => { this.inflight.delete(key); throw error; });
    this.inflight.set(key, { hash, promise });
    return promise;
  }
  hasSeen(key: string) { return this.seen.has(key); }
  markSeen(key: string) { if (!this.seen.has(key)) { this.seen.add(key); this.persist({ t: 's', k: key }); } }
  cursor(key: string) { return this.cursors.get(key) ?? 0; }
  setCursor(key: string, value: number) { this.cursors.set(key, value); this.persist({ t: 'c', k: key, v: value }); }
}
