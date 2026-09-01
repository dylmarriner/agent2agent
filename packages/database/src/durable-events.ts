import { EventStore, type IdFactory } from "../../core/src/index.js";
import type { CollectiveEvent, CollectiveEventType } from "../../protocol/src/index.js";

export interface DurableEventJournal {
  list(limit?: number): Promise<CollectiveEvent[]>;
  append(event: CollectiveEvent): Promise<void>;
}

export interface CreateDurableEventStoreOptions {
  nodeId: string;
  id: IdFactory;
  journal: DurableEventJournal;
  replayLimit?: number;
}

/** EventStore implementation that replays persisted history and serializes new journal writes. */
export class DurableEventStore extends EventStore {
  private readonly history: CollectiveEvent[];
  private readonly listeners = new Set<(event: CollectiveEvent) => void>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private closed = false;

  private constructor(
    private readonly durableNodeId: string,
    private readonly durableId: IdFactory,
    private readonly journal: DurableEventJournal,
    history: CollectiveEvent[],
  ) {
    super(durableNodeId, durableId);
    this.history = history.map((event) => structuredClone(event));
  }

  /** Hydrates the newest configured replay window without re-emitting historical events. */
  static async create(options: CreateDurableEventStoreOptions): Promise<DurableEventStore> {
    const history = await options.journal.list(options.replayLimit ?? 50_000);
    const ids = new Set<string>();
    for (const event of history) {
      if (ids.has(event.id)) throw new Error(`Duplicate persisted event id: ${event.id}`);
      ids.add(event.id);
    }
    return new DurableEventStore(options.nodeId, options.id, options.journal, history);
  }

  override publish<T>(
    type: CollectiveEventType,
    data: T,
    refs: Partial<Pick<CollectiveEvent, "conversationId" | "taskId" | "agentId">> = {},
  ): CollectiveEvent<T> {
    if (this.closed) throw new Error("Durable event store is closed");
    const event: CollectiveEvent<T> = {
      id: this.durableId("evt"),
      type,
      nodeId: this.durableNodeId,
      ...refs,
      at: new Date().toISOString(),
      data,
    };
    const historyEvent = structuredClone(event);
    const persisted = structuredClone(event) as CollectiveEvent;
    this.history.push(historyEvent);

    // Queue persistence before user callbacks run. A throwing subscriber may reject
    // the synchronous publish call, but it cannot make an accepted event vanish on restart.
    this.persistenceTail = this.persistenceTail
      .then(() => this.journal.append(persisted))
      .catch((error: unknown) => {
        this.persistenceError ??= error;
      });

    for (const listener of this.listeners) listener(structuredClone(event));
    return structuredClone(event);
  }

  override list(type?: CollectiveEventType): CollectiveEvent[] {
    return this.history
      .filter((event) => type === undefined || event.type === type)
      .map((event) => structuredClone(event));
  }

  override subscribe(listener: (event: CollectiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits until all accepted events have reached the durable journal. */
  async flush(): Promise<void> {
    await this.persistenceTail;
    if (this.persistenceError !== undefined) {
      const error = this.persistenceError;
      this.persistenceError = undefined;
      throw error;
    }
  }

  /** Stops new publishes, flushes durability, and always releases subscribers. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush();
    } finally {
      this.listeners.clear();
    }
  }
}
