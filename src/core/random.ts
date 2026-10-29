/** Mulberry32 with FNV-1a seed hashing. State is explicit and serializable. */
export class SeededRandom {
  state: number;
  constructor(seed: string) {
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
    this.state = hash >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let n = this.state;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  }
  integer(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  pick<T>(items: readonly T[]): T { return items[this.integer(0, items.length - 1)]; }
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let product = 1, count = 0;
    do { count++; product *= this.next(); } while (product > limit);
    return count - 1;
  }
}
