BEGIN;

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
  parent_message_id text REFERENCES a2a_runtime_messages(id) ON DELETE SET NULL,
  correlation_id text NOT NULL,
  round integer NOT NULL CHECK (round >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  content jsonb NOT NULL,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  routing_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, sequence)
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

CREATE INDEX IF NOT EXISTS a2a_runtime_events_conversation_idx
  ON a2a_runtime_events(conversation_id, event_order);
CREATE INDEX IF NOT EXISTS a2a_runtime_events_type_idx
  ON a2a_runtime_events(type, event_order);

COMMIT;
