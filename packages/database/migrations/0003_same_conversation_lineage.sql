BEGIN;

-- Existing databases allowed parent_message_id to point at a message from any
-- conversation. Clear invalid legacy links before installing the stricter key.
UPDATE a2a_runtime_messages AS child
SET parent_message_id = NULL
WHERE child.parent_message_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM a2a_runtime_messages AS parent
    WHERE parent.id = child.parent_message_id
      AND parent.conversation_id = child.conversation_id
  );

ALTER TABLE a2a_runtime_messages
  DROP CONSTRAINT IF EXISTS a2a_runtime_messages_parent_message_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'a2a_runtime_messages_conversation_id_id_key'
      AND conrelid = 'a2a_runtime_messages'::regclass
  ) THEN
    ALTER TABLE a2a_runtime_messages
      ADD CONSTRAINT a2a_runtime_messages_conversation_id_id_key
      UNIQUE (conversation_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'a2a_runtime_messages_parent_same_conversation_fk'
      AND conrelid = 'a2a_runtime_messages'::regclass
  ) THEN
    ALTER TABLE a2a_runtime_messages
      ADD CONSTRAINT a2a_runtime_messages_parent_same_conversation_fk
      FOREIGN KEY (conversation_id, parent_message_id)
      REFERENCES a2a_runtime_messages(conversation_id, id);
  END IF;
END $$;

COMMIT;
