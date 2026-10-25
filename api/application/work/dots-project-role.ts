import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Capabilities } from "../../domains/capabilities";
import { workOperation, putWorkOperation } from "../../domains/dots";
import type { DotsTasks } from "./dots-tasks";
const roleInput = z.strictObject({
	projectRef: z.string().min(1).max(160),
	expectedRevision: z.number().int().positive(),
	capabilityRevisionId: z
		.string()
		.regex(/^package:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/),
});
export function dotsRoleOptions(db: Database, caps: Capabilities) {
	const refs = [
		{
			revisionId: "package:dots.orchestrate@4",
			title: "標準の作業調整手順（第4版）",
		},
		...caps
			.listDotsPackagesInTransaction(db)
			.items.filter((p) => p.enabled)
			.map((p) => ({ revisionId: p.revisionId, title: p.title })),
	];
	return refs.flatMap((p) => {
		try {
			caps.prepareActiveByIdInTransaction(
				db,
				{ rootRunId: "dots-settings", taskId: "dots-settings", cancelEpoch: 0 },
				p.revisionId,
				{},
			);
			return [{ value: p.revisionId, label: p.title }];
		} catch {
			return [];
		}
	});
}
/** An explicit project-role edit, with the row's revision; no silent upgrade on startup or start. */
export function applyDotsProjectRole(
	db: Database,
	configuration: DotsTasks["config"],
	caps: Capabilities,
	raw: unknown,
	id: string,
	scope: string,
) {
	const input = roleInput.parse(raw),
		digest = createHash("sha256")
			.update(JSON.stringify(["project-role", input]))
			.digest("hex"),
		origin = JSON.stringify({ kind: "ui", scope }),
		old = workOperation(db, id);
	if (old) {
		if (old.digest !== digest || old.origin_json !== origin)
			throw new Error("dots_conflict");
		return { receipt: JSON.parse(old.receipt_json), replay: true };
	}
	if (
		!dotsRoleOptions(db, caps).some(
			(p) => p.value === input.capabilityRevisionId,
		)
	)
		throw new Error("dots_permission_denied");
	const project = configuration
		.listInTransaction(db)
		.projects.find((p) => p.ref === input.projectRef);
	if (!project) throw new Error("dots_not_found");
	const { revision, ...fields } = project;
	if (revision !== input.expectedRevision) throw new Error("revision_conflict");
	const next = configuration.configureProjectInTransaction(db, {
		...fields,
		expectedRevision: revision,
		capabilityRevisionId: input.capabilityRevisionId,
	});
	const receipt = {
		version: 1,
		operation: "project-role",
		value: { projectRef: next.ref, revision: next.revision },
	};
	putWorkOperation(db, { id, digest, origin, receipt, now: Date.now() });
	return { receipt, replay: false };
}
