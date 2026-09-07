export class RateLimit {
  private readonly buckets = new Map<string, { count: number; until: number }>();
  constructor(private readonly maximum: number, private readonly windowMs: number) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.buckets.size > 2048) {
      for (const [id, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(id);
      if (this.buckets.size > 2048 && !this.buckets.has(key)) return false;
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.until <= now) {
      bucket = { count: 0, until: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.maximum;
  }
}
