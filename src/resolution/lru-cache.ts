/**
 * Simple LRU cache backed by JavaScript's insertion-ordered Map.
 *
 * Used by ReferenceResolver to bound the per-resolver caches that
 * previously grew without limit and OOM'd on large codebases (20k+
 * files). Each cache is sized independently — see `index.ts` for
 * the chosen limits per cache type.
 *
 * Eviction is plain LRU: on `set`, if the cache is full, the
 * least-recently-used entry is evicted. Touching via `get` moves the
 * entry to the most-recently-used position so hot keys survive eviction
 * passes.
 *
 * Recency is a doubly linked list threaded through the entries, oldest
 * first. Moving an entry is a few pointer writes: doing it by deleting and
 * re-inserting the Map key made a cache hit the single hottest line of
 * resolution, and left the Map's table to rehash as the deleted slots piled up.
 */
interface LRUEntry<K, V> {
  key: K;
  value: V;
  weight: number;
  older: LRUEntry<K, V> | null;
  newer: LRUEntry<K, V> | null;
}

export class LRUCache<K, V> {
  private readonly max: number;
  private readonly store = new Map<K, LRUEntry<K, V>>();
  private oldest: LRUEntry<K, V> | null = null;
  private newest: LRUEntry<K, V> | null = null;

  private readonly maxWeight: number | null;
  private readonly weightOf: ((value: V, key: K) => number) | null;
  private totalWeight = 0;

  constructor(
    max: number,
    opts: { maxWeight: number; weightOf: (value: V, key: K) => number } | null = null
  ) {
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`LRUCache max must be a positive finite number, got ${max}`);
    }
    if (opts && (!Number.isFinite(opts.maxWeight) || opts.maxWeight <= 0)) {
      throw new Error(`LRUCache maxWeight must be a positive finite number, got ${opts.maxWeight}`);
    }
    this.max = Math.floor(max);
    this.maxWeight = opts ? Math.floor(opts.maxWeight) : null;
    this.weightOf = opts?.weightOf ?? null;
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    this.touch(entry);
    return entry.value;
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  set(key: K, value: V): void {
    const weight = this.weightOf ? Math.max(0, Math.ceil(this.weightOf(value, key))) : 0;
    const entry = this.store.get(key);
    if (entry) {
      this.totalWeight -= entry.weight;
      this.unlink(entry);
      this.store.delete(key);
    }
    if (this.maxWeight !== null && weight > this.maxWeight) return;
    while (this.oldest && (this.store.size >= this.max ||
        (this.maxWeight !== null && this.totalWeight + weight > this.maxWeight))) {
      this.totalWeight -= this.oldest.weight;
      this.store.delete(this.oldest.key);
      this.unlink(this.oldest);
    }
    this.totalWeight += weight;
    const added: LRUEntry<K, V> = { key, value, weight, older: this.newest, newer: null };
    if (this.newest !== null) this.newest.newer = added;
    else this.oldest = added;
    this.newest = added;
    this.store.set(key, added);
  }

  clear(): void {
    this.store.clear();
    this.totalWeight = 0;
    this.oldest = null;
    this.newest = null;
  }

  /** Make an entry the most recently used. */
  private touch(entry: LRUEntry<K, V>): void {
    if (entry === this.newest) return;
    this.unlink(entry);
    entry.older = this.newest;
    entry.newer = null;
    this.newest!.newer = entry;
    this.newest = entry;
  }

  private unlink(entry: LRUEntry<K, V>): void {
    if (entry.older !== null) entry.older.newer = entry.newer;
    else this.oldest = entry.newer;
    if (entry.newer !== null) entry.newer.older = entry.older;
    else this.newest = entry.older;
  }
}
