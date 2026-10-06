import pg from "pg";
import type { AgentMessage, CollectiveEvent, CollectiveEventType, MessagePart, ArtifactReference, RoutingMetadata } from "../../protocol/src/index.js";
import type { ConversationRecord, ConversationRepository, UnsequencedAgentMessage } from "../../conversation/src/index.js";

const { Pool } = pg;

export interface SqlQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlQueryResult<Row>>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export const RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS a2a_runtime_conversations (
  id text PRIMARY KEY,
  node_id text NOT NULL,
  title text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL,
  participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS a2a_runtime_conversations_node_created_idx
  ON a2a_runtime_conversations(node_id, created_at, id);

CREATE TABLE IF NOT EXISTS a2a_runtime_conversation_sequences (
  conversation_id text PRIMARY KEY REFERENCES a2a_runtime_conversations(id) ON DELETE CASCADE,
  next_sequence bigint NOT NULL CHECK (next_sequence >= 1)
);

CREATE TABLE IF NOT EXISTS a2a_runtime_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES a2a_runtime_conversations(id) ON DELETE CASCADE,
  sender_participant_id text NOT NULL,
  recipient_participant_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  intent text NOT NULL,
  task_id text,
  parent_message_id text,
  correlation_id text NOT NULL,
  round integer NOT NULL CHECK (round >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  content jsonb NOT NULL,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  routing_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, id),
  CONSTRAINT a2a_runtime_messages_parent_same_conversation_fk
    FOREIGN KEY (conversation_id, parent_message_id)
    REFERENCES a2a_runtime_messages(conversation_id, id)
);

CREATE INDEX IF NOT EXISTS a2a_runtime_messages_conversation_created_idx
  ON a2a_runtime_messages(conversation_id, sequence);
CREATE INDEX IF NOT EXISTS a2a_runtime_messages_correlation_idx
  ON a2a_runtime_messages(correlation_id);

CREATE TABLE IF NOT EXISTS a2a_runtime_events (
  event_order bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  type text NOT NULL,
  node_id text NOT NULL,
  conversation_id text,
  task_id text,
  agent_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS a2a_runtime_events_node_order_idx
  ON a2a_runtime_events(node_id, event_order);
CREATE INDEX IF NOT EXISTS a2a_runtime_events_conversation_idx
  ON a2a_runtime_events(conversation_id, event_order);
CREATE INDEX IF NOT EXISTS a2a_runtime_events_type_idx
  ON a2a_runtime_events(type, event_order);
`;

/** Ensures the control-plane persistence schema exists before repositories are used. */
export async function ensureRuntimeSchema(sql: SqlExecutor): Promise<void> {
  await sql.query(RUNTIME_SCHEMA_SQL);
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly sql: SqlExecutor, private readonly nodeId: string) {
    assertNodeId(nodeId);
  }

  async saveConversation(record: ConversationRecord): Promise<void> {
    if (record.nodeId !== this.nodeId) throw new Error(`Conversation ${record.id} belongs to node ${record.nodeId}, not ${this.nodeId}`);
    await this.sql.query(
      `INSERT INTO a2a_runtime_conversations
        (id, node_id, title, objective, status, participant_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (id) DO UPDATE SET
         node_id = EXCLUDED.node_id,
         title = EXCLUDED.title,
         objective = EXCLUDED.objective,
         status = EXCLUDED.status,
         participant_ids = EXCLUDED.participant_ids,
         updated_at = EXCLUDED.updated_at
       WHERE a2a_runtime_conversations.node_id = EXCLUDED.node_id`,
      [record.id, record.nodeId, record.title, record.objective, record.status, JSON.stringify(record.participantIds), record.createdAt, record.updatedAt],
    );
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    const result = await this.sql.query<ConversationRow>(
      `SELECT id, node_id, title, objective, status, participant_ids, created_at, updated_at
       FROM a2a_runtime_conversations WHERE id = $1 AND node_id = $2`,
      [id, this.nodeId],
    );
    return result.rows[0] ? mapConversationRow(result.rows[0]) : undefined;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const result = await this.sql.query<ConversationRow>(
      `SELECT id, node_id, title, objective, status, participant_ids, created_at, updated_at
       FROM a2a_runtime_conversations WHERE node_id = $1 ORDER BY created_at ASC, id ASC`,
      [this.nodeId],
    );
    return result.rows.map(mapConversationRow);
  }

  async appendMessage(message: UnsequencedAgentMessage): Promise<AgentMessage> {
    return this.sql.transaction(async (tx) => {
      const sequenceResult = await tx.query<{ sequence: string | number }>(
        `INSERT INTO a2a_runtime_conversation_sequences (conversation_id, next_sequence)
         SELECT id, 2 FROM a2a_runtime_conversations WHERE id = $1 AND node_id = $2
         ON CONFLICT (conversation_id) DO UPDATE
           SET next_sequence = a2a_runtime_conversation_sequences.next_sequence + 1
         RETURNING next_sequence - 1 AS sequence`,
        [message.conversationId, this.nodeId],
      );
      const rawSequence = sequenceResult.rows[0]?.sequence;
      const sequence = Number(rawSequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error(`Conversation ${message.conversationId} does not belong to node ${this.nodeId} or returned an invalid sequence`);
      }

      await tx.query(
        `INSERT INTO a2a_runtime_messages
          (id, conversation_id, sender_participant_id, recipient_participant_ids, intent, task_id,
           parent_message_id, correlation_id, round, sequence, content, artifacts, routing_metadata, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::timestamptz)`,
        [
          message.id,
          message.conversationId,
          message.senderAgentId,
          JSON.stringify(message.recipientAgentIds),
          message.intent,
          message.taskId ?? null,
          message.parentMessageId ?? null,
          message.correlationId,
          message.round,
          sequence,
          JSON.stringify(message.content),
          JSON.stringify(message.artifacts),
          JSON.stringify(message.routingMetadata),
          message.createdAt,
        ],
      );
      return { ...structuredClone(message), sequence };
    });
  }

  async getMessage(conversationId: string, messageId: string): Promise<AgentMessage | undefined> {
    const result = await this.sql.query<MessageRow>(
      `${MESSAGE_SELECT}
       WHERE conversation_id = $1 AND id = $2
         AND EXISTS (
           SELECT 1 FROM a2a_runtime_conversations c
           WHERE c.id = a2a_runtime_messages.conversation_id AND c.node_id = $3
         )`,
      [conversationId, messageId, this.nodeId],
    );
    return result.rows[0] ? mapMessageRow(result.rows[0]) : undefined;
  }

  async listMessages(conversationId: string): Promise<AgentMessage[]> {
    const result = await this.sql.query<MessageRow>(
      `${MESSAGE_SELECT}
       WHERE conversation_id = $1
         AND EXISTS (
           SELECT 1 FROM a2a_runtime_conversations c
           WHERE c.id = a2a_runtime_messages.conversation_id AND c.node_id = $2
         )
       ORDER BY sequence ASC`,
      [conversationId, this.nodeId],
    );
    return result.rows.map(mapMessageRow);
  }
}

const MESSAGE_SELECT = `SELECT id, conversation_id, sender_participant_id, recipient_participant_ids,
  intent, task_id, parent_message_id, correlation_id, round, sequence, content, artifacts,
  routing_metadata, created_at FROM a2a_runtime_messages`;

export class PostgresEventJournal {
  constructor(private readonly sql: SqlExecutor, private readonly nodeId: string) {
    assertNodeId(nodeId);
  }

  async append(event: CollectiveEvent): Promise<void> {
    if (event.nodeId !== this.nodeId) throw new Error(`Event ${event.id} belongs to node ${event.nodeId}, not ${this.nodeId}`);
    await this.sql.query(
      `INSERT INTO a2a_runtime_events
        (id, type, node_id, conversation_id, task_id, agent_id, data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id,
        event.type,
        event.nodeId,
        event.conversationId ?? null,
        event.taskId ?? null,
        event.agentId ?? null,
        JSON.stringify(event.data),
        event.at,
      ],
    );
  }

  async list(limit = 5000): Promise<CollectiveEvent[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new Error("Event replay limit must be between 1 and 100000");
    const result = await this.sql.query<EventRow>(
      `SELECT event_order, id, type, node_id, conversation_id, task_id, agent_id, data, created_at
       FROM (
         SELECT event_order, id, type, node_id, conversation_id, task_id, agent_id, data, created_at
         FROM a2a_runtime_events
         WHERE node_id = $1
         ORDER BY event_order DESC
         LIMIT $2
       ) recent
       ORDER BY event_order ASC`,
      [this.nodeId, limit],
    );
    return result.rows.map(mapEventRow);
  }
}

export interface PgRuntimeDatabase extends SqlExecutor {
  close(): Promise<void>;
}

/** Creates the PostgreSQL executor owned by a standalone Agent2Agent runtime. */
export function createPgRuntimeDatabase(connectionString: string): PgRuntimeDatabase {
  if (!connectionString.trim()) throw new Error("PostgreSQL connection string is required");
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 8_000 });
  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      const result = await pool.query(text, [...values]);
      return { rows: result.rows as Row[] };
    },
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: SqlExecutor = {
          async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
            const result = await client.query(text, [...values]);
            return { rows: result.rows as Row[] };
          },
          async transaction<U>(inner: (nested: SqlExecutor) => Promise<U>): Promise<U> {
            return inner(tx);
          },
        };
        const value = await fn(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

interface ConversationRow {
  id: string;
  node_id: string;
  title: string;
  objective: string;
  status: ConversationRecord["status"];
  participant_ids: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_participant_id: string;
  recipient_participant_ids: unknown;
  intent: AgentMessage["intent"];
  task_id: string | null;
  parent_message_id: string | null;
  correlation_id: string;
  round: number;
  sequence: string | number;
  content: unknown;
  artifacts: unknown;
  routing_metadata: unknown;
  created_at: unknown;
}

interface EventRow {
  event_order: string | number;
  id: string;
  type: string;
  node_id: string;
  conversation_id: string | null;
  task_id: string | null;
  agent_id: string | null;
  data: unknown;
  created_at: unknown;
}

function mapConversationRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    nodeId: row.node_id,
    title: row.title,
    objective: row.objective,
    status: row.status,
    participantIds: stringArray(row.participant_ids, "participant_ids"),
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

function mapMessageRow(row: MessageRow): AgentMessage {
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`Invalid persisted message sequence: ${String(row.sequence)}`);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderAgentId: row.sender_participant_id,
    recipientAgentIds: stringArray(row.recipient_participant_ids, "recipient_participant_ids"),
    intent: row.intent,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.parent_message_id ? { parentMessageId: row.parent_message_id } : {}),
    correlationId: row.correlation_id,
    round: row.round,
    sequence,
    content: objectArray<MessagePart>(row.content, "content"),
    artifacts: objectArray<ArtifactReference>(row.artifacts, "artifacts"),
    routingMetadata: objectValue<RoutingMetadata>(row.routing_metadata, "routing_metadata"),
    createdAt: isoDate(row.created_at),
  };
}

function mapEventRow(row: EventRow): CollectiveEvent {
  return {
    id: row.id,
    type: row.type as CollectiveEventType,
    nodeId: row.node_id,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    at: isoDate(row.created_at),
    data: row.data,
  };
}

function assertNodeId(nodeId: string): void {
  if (!nodeId.trim()) throw new Error("Runtime node id is required for PostgreSQL isolation");
}

function isoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  throw new Error(`Invalid database timestamp: ${String(value)}`);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function stringArray(value: unknown, field: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error(`Invalid ${field}`);
  return parsed;
}

function objectArray<T>(value: unknown, field: string): T[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new Error(`Invalid ${field}`);
  return parsed as T[];
}

function objectValue<T extends object>(value: unknown, field: string): T {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Invalid ${field}`);
  return parsed as T;
}
