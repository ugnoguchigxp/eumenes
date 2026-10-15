import type { Database } from "bun:sqlite";
import type { ProfileSnapshot, Prepared } from "../../capabilities";
import { get, byRoot, update } from "../repository";
import { safeCode } from "./control-output";
import { requestUrls } from "./request-urls";
import { workerDeadline } from "./exploration";
import { owner, type RuntimeContext } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import { createActionOperation } from "./action-operation";

export function createStartTask(ctx: RuntimeContext, ops: TaskOps) {
	const { capabilities, tools, inference, now } = ctx.deps;
	const { prepared, actionPrepared, bindings } = ctx.state;
	const { enqueue, insertTask, ready, fail } = ops;
	const runAction = createActionOperation({
		tools,
		capabilities,
		actionPrepared,
		prepared,
		owner,
		ready,
		now,
	});
	return {
		startInTransaction(
			db: Database,
			input: {
				rootRunId: string;
				input: unknown;
				deadline: number;
				parentJobId?: string;
				/** The frozen package capability a bound operation runs with (kind "action"). */
				actionCapability?: Prepared;
				requirementProfiles?: ProfileSnapshot[];
				onCreated?: (taskId: string) => void;
			},
		) {
			const existing = byRoot(db, input.rootRunId);
			if (existing)
				return {
					taskId: existing.id,
					jobId: existing.job_id ?? input.parentJobId ?? existing.id,
				};
			const request = input.input as {
				kind?: "web" | "history" | "world" | "action";
				question: string;
				originalRequest?: string;
				urls?: string[];
				command?: unknown;
				researcher?: "codex_luna";
				/** The package of the toolchain the conversation chose. */
				packageRevisionId?: string;
			};
			if (
				request.packageRevisionId !== undefined &&
				!/^package:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/.test(
					request.packageRevisionId,
				)
			)
				throw new Error("capability_unavailable");
			// A World investigation has no default package: the toolchain names it.
			if (request.kind === "world" && request.packageRevisionId === undefined)
				throw new Error("capability_unavailable");
			if (
				request.researcher &&
				(request.kind !== "web" ||
					request.researcher !== "codex_luna" ||
					!inference.codexResearchAvailable?.())
			)
				throw new Error("codex_research_unavailable");
			if (request.kind === "web" && input.requirementProfiles?.length)
				throw new Error("invalid_requirement_contract");
			const root = insertTask(
				db,
				"coordinator",
				input.rootRunId,
				request,
				input.deadline,
			);
			input.onCreated?.(root.id);
			if (request.kind === "action") {
				const p = input.actionCapability;
				if (p) actionPrepared.set(root.id, p);
				db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
					JSON.stringify({ ...request, actionRequested: true }),
					root.id,
				);
				try {
					runAction(
						db,
						get(db, root.id)!,
						request.command,
						crypto.randomUUID(),
					);
				} catch (e) {
					fail(db, get(db, root.id)!, safeCode(e));
				}
				return { taskId: root.id, jobId: input.parentJobId ?? root.id };
			}
			const packageId =
				request.packageRevisionId ??
				(request.kind === "history"
					? "package:history.research@2"
					: request.researcher === "codex_luna"
						? "package:web.search@1"
						: "package:web.quick@2");
			const workerInput = {
				question: request.question,
				detail: "normal",
				// History and World readings stay inside the host: no URL reaches their worker.
				...(request.kind !== "history" && request.kind !== "world"
					? {
							urls: requestUrls(
								request.originalRequest ?? request.question,
								request.urls,
							),
						}
					: {}),
			};
			let childId: string | undefined;
			db.exec("SAVEPOINT start_worker");
			try {
				capabilities.validateRequirementProfilesInTransaction(
					db,
					input.requirementProfiles ?? [],
				);
				// Every entry creates exactly one child with the same deadline policy.
				const child = insertTask(
					db,
					"worker",
					root.root_run_id,
					{
						...workerInput,
						originalRequest: request.originalRequest ?? request.question,
						requirementProfiles: input.requirementProfiles ?? [],
						// The history sub-agent chooses applicable profiles from this snapshot.
						...(request.kind === "history" && !input.requirementProfiles?.length
							? {
									requirementCatalog:
										capabilities.requirementCatalogInTransaction(db),
								}
							: {}),
						researcher: request.researcher,
					},
					workerDeadline(root.deadline, now()),
					root.id,
				);
				childId = child.id;
				update(db, root, "waiting_child", "research");
				const p = capabilities.prepareActiveByIdInTransaction(
					db,
					owner(child),
					packageId,
					workerInput,
				);
				db.query("UPDATE agent_tasks SET package_revision_id=? WHERE id=?").run(
					p.package.revisionId,
					child.id,
				);
				for (const d of [p.package, ...p.dependencies])
					db.query("INSERT INTO agent_task_bindings VALUES(?,?,?,?)").run(
						child.id,
						d.kind,
						d.revisionId,
						d.hash,
					);
				prepared.set(child.id, p);
				prepared.set(root.id, p);
				bindings.set(child.id, tools.bind(owner(child), p, child.deadline));
				const jobId = enqueue(db, child, input.parentJobId);
				db.exec("RELEASE start_worker");
				return { taskId: root.id, jobId };
			} catch (e) {
				const metadata = get(db, root.id)!.input_json;
				db.exec("ROLLBACK TO start_worker");
				db.exec("RELEASE start_worker");
				if (safeCode(e) === "clarification_required")
					db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
						metadata,
						root.id,
					);
				if (childId) {
					tools.release(childId);
					prepared.delete(childId);
					bindings.delete(childId);
				}
				prepared.delete(root.id);
				fail(db, get(db, root.id)!, safeCode(e));
				return { taskId: root.id, jobId: input.parentJobId ?? root.id };
			}
		},
	};
}
