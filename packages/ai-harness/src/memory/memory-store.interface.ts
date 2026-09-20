/** A stored memory item. */
export interface MemoryRecord {
  id: number;
  namespace: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Retrieval weight in [0,1] for facts that matter more than others. */
  importance: number;
  createdAt: Date;
  /** Conversation this was extracted from; null when written directly. */
  sourceSessionId: string | null;
  /** Cosine similarity in [0,1]; present on search results only. */
  score?: number;
  /** True when the row also matched the lexical index, not just the vector one. */
  lexical?: boolean;
}

/** Everything needed to store one memory. */
export interface MemoryWrite {
  namespace: string;
  content: string;
  metadata?: Record<string, unknown>;
  importance?: number;
  sourceSessionId?: string;
}

/** How a single retrieval is filtered and ranked. */
export interface SearchOptions {
  topK?: number;
  /**
   * Cosine floor. A hit below it is dropped *unless* it also matched lexically —
   * gating purely on cosine would discard exactly the exact-name matches that
   * hybrid search exists to find.
   */
  minScore?: number;
  /** Days for the recency weight to halve. Omit to rank without recency. */
  halfLifeDays?: number;
  /** Maximum token overlap allowed between two returned memories, in [0,1]. */
  maxOverlap?: number;
}

/**
 * Storage for long-term memory.
 *
 * Every method takes the namespaces it may touch, and every statement behind them
 * carries a `namespace = ANY(...)` clause. The clause is what enforces the
 * boundary — a parameter only describes an intention, and `supersede` is proof:
 * it writes across many rows using ids an LLM picked out of a neighbour lookup,
 * so without the clause a model naming an id from another tenant would have it
 * obeyed.
 */
export interface MemoryStore {
  /** Store a memory, collapsing a near-identical restatement into the existing row. */
  upsert(write: MemoryWrite): Promise<MemoryRecord>;

  /** Retrieve across one or more namespaces at once. */
  search(namespaces: string | string[], query: string, options?: SearchOptions): Promise<MemoryRecord[]>;

  /**
   * Nearest existing memories to a candidate, used to decide whether it is new, a
   * replacement, or already known. Ignores score floors on purpose: the caller
   * needs the closest rows even when nothing is close.
   *
   * Takes several namespaces because a candidate can contradict a memory that
   * lives outside the one it will be written to — retrieval reads more than one
   * namespace, so adjudication has to as well.
   */
  neighbours(namespaces: string | string[], content: string, limit?: number): Promise<MemoryRecord[]>;

  /**
   * Mark rows as replaced. They stop appearing in retrieval but stay in the table,
   * so a wrong supersede is auditable and recoverable.
   */
  supersede(namespaces: string | string[], ids: number[]): Promise<number>;

  /** Live rows in a namespace, newest first. */
  list(namespace: string, limit?: number): Promise<MemoryRecord[]>;
}
