BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE nodes (
  id text PRIMARY KEY,
  name text NOT NULL,
  canonical_uri text NOT NULL UNIQUE,
  public_key text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE federation_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id text NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  trust_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  capability_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (node_id, endpoint)
);

CREATE TABLE agents (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES nodes(id),
  canonical_uri text NOT NULL UNIQUE,
  name text NOT NULL,
  adapter_type text NOT NULL,
  status text NOT NULL DEFAULT 'offline',
  ephemeral boolean NOT NULL DEFAULT false,
  parent_agent_id text REFERENCES agents(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_capabilities (
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  capability text NOT NULL,
  success_rate double precision NOT NULL DEFAULT 0,
  quality_score double precision NOT NULL DEFAULT 0,
  latency_score double precision NOT NULL DEFAULT 0,
  cost_score double precision,
  sample_count integer NOT NULL DEFAULT 0,
  confidence double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, capability)
);

CREATE TABLE agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  vendor_session_id text,
  conversation_id uuid,
  task_id uuid,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_credentials_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  provider text NOT NULL,
  secret_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(agent_id, provider)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  coordinator_node_id text NOT NULL REFERENCES nodes(id),
  objective text NOT NULL,
  orchestration text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_conversation_fk FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

CREATE TABLE conversation_participants (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  role text NOT NULL DEFAULT 'participant',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_agent_id text NOT NULL REFERENCES agents(id),
  intent text NOT NULL,
  task_id uuid,
  parent_message_id uuid REFERENCES messages(id),
  correlation_id text NOT NULL,
  round integer NOT NULL,
  sequence bigint NOT NULL,
  content jsonb NOT NULL,
  artifacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  routing_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  vendor_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE message_recipients (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  delivery_status text NOT NULL DEFAULT 'pending',
  delivered_at timestamptz,
  PRIMARY KEY (message_id, agent_id)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES tasks(id),
  title text NOT NULL,
  objective text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  owner_agent_id text REFERENCES agents(id),
  workspace_id uuid,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE messages ADD CONSTRAINT messages_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_task_fk FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE subagents (
  agent_id text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_agent_id text NOT NULL REFERENCES agents(id),
  parent_task_id uuid NOT NULL REFERENCES tasks(id),
  depth integer NOT NULL,
  specialization text NOT NULL,
  objective text NOT NULL,
  limits jsonb NOT NULL,
  permission_policy jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active',
  termination_reason text,
  result jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  produced_by_agent_id text REFERENCES agents(id),
  kind text NOT NULL,
  uri text NOT NULL,
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  url text,
  default_branch text NOT NULL DEFAULT 'main',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES agents(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  branch text NOT NULL,
  worktree_path text NOT NULL,
  base_revision text NOT NULL,
  head_revision text,
  status text NOT NULL DEFAULT 'creating',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, branch)
);

ALTER TABLE tasks ADD CONSTRAINT tasks_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  base_revision text NOT NULL,
  head_revision text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE code_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reviewer_agent_id text NOT NULL REFERENCES agents(id),
  verdict text NOT NULL,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merge_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL,
  base_revision text NOT NULL,
  head_revision text NOT NULL,
  conflict_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_revision text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  node_id text REFERENCES nodes(id),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id),
  session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  adapter_type text NOT NULL,
  status text NOT NULL,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  scope_id text NOT NULL,
  content text NOT NULL,
  embedding vector(1536),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  salience double precision NOT NULL CHECK (salience BETWEEN 0 AND 1),
  usefulness double precision NOT NULL CHECK (usefulness BETWEEN 0 AND 1),
  validation_status text NOT NULL,
  source_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  target_memory_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  relation text NOT NULL,
  confidence double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memory_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  provider text NOT NULL,
  score double precision,
  useful boolean,
  task_succeeded boolean,
  evidence_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  usefulness_score double precision NOT NULL CHECK (usefulness_score BETWEEN 0 AND 1),
  validation_status text NOT NULL DEFAULT 'candidate',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  reviewer_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
  verdict text NOT NULL,
  reasoning text,
  confidence double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_evidence (
  knowledge_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES artifacts(id) ON DELETE CASCADE,
  evidence_uri text,
  evidence_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (artifact_id IS NOT NULL OR evidence_uri IS NOT NULL)
);

CREATE TABLE graph_nodes (
  id text PRIMARY KEY,
  kind text NOT NULL,
  canonical_ref text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  confidence double precision,
  source_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  source_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  publisher text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  checksum text NOT NULL,
  status text NOT NULL DEFAULT 'candidate',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(skill_id, version)
);

CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  type text NOT NULL,
  publisher text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE package_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  version text NOT NULL,
  manifest jsonb NOT NULL,
  checksum text NOT NULL,
  signature jsonb,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_id, version)
);

CREATE TABLE package_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_version_id uuid NOT NULL REFERENCES package_versions(id),
  enabled boolean NOT NULL DEFAULT false,
  installed_by text,
  installed_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);

CREATE TABLE benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  category text NOT NULL,
  version text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE benchmark_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  input jsonb NOT NULL,
  expected jsonb,
  grading_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(benchmark_id, external_id)
);

CREATE TABLE benchmark_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  status text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id text NOT NULL,
  baseline_id text NOT NULL,
  benchmark_id uuid NOT NULL REFERENCES benchmarks(id),
  success_delta double precision NOT NULL,
  quality_delta double precision NOT NULL,
  latency_delta double precision NOT NULL,
  cost_delta double precision,
  regressions jsonb NOT NULL DEFAULT '[]'::jsonb,
  verdict text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  version text NOT NULL,
  state text NOT NULL,
  evaluation_result_id uuid REFERENCES evaluation_results(id),
  previous_promotion_id uuid REFERENCES promotions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);

CREATE TABLE workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  version text NOT NULL,
  definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agent_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  benchmark_run_id uuid REFERENCES benchmark_runs(id) ON DELETE SET NULL,
  capability text,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  decision text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_created_idx ON messages(conversation_id, created_at);
CREATE INDEX tasks_conversation_status_idx ON tasks(conversation_id, status);
CREATE INDEX events_conversation_created_idx ON events(conversation_id, created_at);
CREATE INDEX events_type_created_idx ON events(type, created_at);
CREATE INDEX invocations_agent_started_idx ON agent_invocations(agent_id, started_at DESC);
CREATE INDEX memory_scope_idx ON memory_records(scope, scope_id, validation_status);
CREATE INDEX memory_fts_idx ON memory_records USING gin (to_tsvector('english', content));
CREATE INDEX memory_embedding_idx ON memory_records USING hnsw (embedding vector_cosine_ops);
CREATE INDEX graph_source_relation_idx ON graph_edges(source_id, relation, valid_from);
CREATE INDEX graph_target_relation_idx ON graph_edges(target_id, relation, valid_from);
CREATE INDEX knowledge_status_idx ON knowledge_items(validation_status, updated_at DESC);
CREATE INDEX benchmark_runs_subject_idx ON benchmark_runs(subject_type, subject_id, started_at DESC);
CREATE INDEX audit_resource_idx ON audit_events(resource_type, resource_id, created_at DESC);

COMMIT;
