/** Append-only host migration; existing terminal events are not reopened. */
export const extractionHoldMigration = `
ALTER TABLE world_host_extract_event
ADD COLUMN held_context_digest TEXT
CHECK (held_context_digest IS NULL OR length(held_context_digest) = 64);
`;
