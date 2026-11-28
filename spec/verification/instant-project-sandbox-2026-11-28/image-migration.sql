-- P0 migration candidate. Apply with the image owner writer, in one transaction.
CREATE TABLE image_generations_next (
 id TEXT PRIMARY KEY,
 run_id TEXT,
 conversation_id TEXT,
 record_json TEXT NOT NULL,
 request_json TEXT NOT NULL,
 plan_json TEXT,
 bindings_json TEXT NOT NULL,
 deadline INTEGER NOT NULL,
 queue_job_id TEXT,
 generated_version TEXT,
 origin TEXT NOT NULL DEFAULT 'conversation',
 prototype_id TEXT,
 operation_id TEXT,
 grant_revision INTEGER,
 hard_deadline INTEGER,
 CHECK (
   (origin = 'conversation' AND run_id IS NOT NULL AND conversation_id IS NOT NULL
    AND prototype_id IS NULL AND operation_id IS NULL AND grant_revision IS NULL
    AND hard_deadline IS NULL)
   OR
   (origin = 'prototype' AND run_id IS NULL AND conversation_id IS NULL
    AND prototype_id IS NOT NULL AND operation_id IS NOT NULL AND grant_revision IS NOT NULL
    AND plan_json IS NOT NULL AND hard_deadline IS NOT NULL AND deadline <= hard_deadline)
 )
);
INSERT INTO image_generations_next(
 rowid, id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json,
 deadline, queue_job_id, generated_version
)
SELECT rowid, id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json,
 deadline, queue_job_id, generated_version FROM image_generations;
DROP TABLE image_generations;
ALTER TABLE image_generations_next RENAME TO image_generations;
CREATE INDEX image_conversation ON image_generations(conversation_id)
 WHERE origin = 'conversation';
CREATE UNIQUE INDEX image_source_once ON image_generations(run_id)
 WHERE origin = 'conversation' AND json_extract(request_json,'$.execution') IS NULL;
CREATE UNIQUE INDEX image_prototype_operation ON image_generations(prototype_id, operation_id)
 WHERE origin = 'prototype';
