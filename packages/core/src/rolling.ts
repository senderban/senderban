/**
 * Units spent in the last `buckets` buckets, in memory bounded by the bucket count whatever the traffic (60 for a minute, 24
 * for a day). The window is `buckets` buckets plus the one running, so it always covers at least the whole period and over-counts
 * by up to one bucket: the safe side for a cap.
 */
export class Rolling {
  readonly #spent = new Map<number, number>();
  readonly #bucketMs: number;
  readonly #buckets: number;
  readonly #now: () => number;
  #elapsed = 0;
  #seen: number | null = null;

  constructor(bucketMs: number, buckets: number, now: () => number) {
    this.#bucketMs = bucketMs;
    this.#buckets = buckets;
    this.#now = now;
  }

  /** The window's own clock: it moves by the forward steps of the wall clock only, so a clock set back neither un-spends nor locks. */
  #current(): number {
    const t = this.#now();
    if (this.#seen !== null) this.#elapsed += Math.max(0, t - this.#seen);
    this.#seen = t;
    return Math.floor(this.#elapsed / this.#bucketMs);
  }

  used(): number {
    const current = this.#current();
    let total = 0;
    for (const [index, units] of this.#spent) {
      if (index < current - this.#buckets) this.#spent.delete(index);
      else total += units;
    }
    return total;
  }

  add(units: number): void {
    const current = this.#current();
    this.#spent.set(current, (this.#spent.get(current) ?? 0) + units);
  }
}
