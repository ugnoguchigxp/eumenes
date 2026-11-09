import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	recordRequest,
	type AppDevelopment,
} from "../../domains/app-development";
import type { DomainAdapter } from "../../domains/tool-runtime";
import { workflowScreenInTransaction } from "../../domains/ui-compositions";
import type { AppWorkflowControls } from "./app-development-adapter";
import {
	deletionDigest,
	type createAppStorageRuntime,
} from "./storage-runtime";

export const studio = "query:app-development.studio@1";
export const records = "query:app-development.records@1";
type Work = ReturnType<AppDevelopment["draft"]>;

export function createStudioSource(
	service: AppDevelopment,
	deps: {
		workflow(): Pick<AppWorkflowControls, "view">;
		storage(): Pick<
			ReturnType<typeof createAppStorageRuntime>,
			"view" | "records"
		>;
	},
	preview: (db: Database, work: Work) => { digest: string; summary: unknown },
	draftIssue: (error: unknown) => string,
): DomainAdapter["sourceInTransaction"] {
	return (db, query, targetRef, params) => {
		if (query === records && targetRef) {
			const checked = z
				.strictObject({
					revision: z.number().int().positive(),
					collection: z.string(),
					request: recordRequest,
				})
				.safeParse(params);
			if (!checked.success) return null;
			const input = checked.data;
			if (
				input.request.operation !== "list" &&
				input.request.operation !== "get"
			)
				return null;
			const app = service.app(db, targetRef);
			if (!app || app.revision !== input.revision) return null;
			return {
				revision: app.revision,
				data: deps.storage().records(db, app, input.collection, input.request),
			};
		}
		if (query !== studio) return null;
		const work = service.current(db);
		const viewing = targetRef ? service.storedApp(db, targetRef) : null;
		const lifecycle = targetRef ? service.storage.get(db, targetRef) : null;
		const workLifecycle = work ? service.storage.get(db, work.appId) : null;
		const available = !lifecycle || lifecycle.state === "active";
		const read = z
			.object({ page: z.number().int().min(0).max(399).default(0) })
			.parse(params ?? {});

		const screen =
			available && viewing?.screenRevision
				? workflowScreenInTransaction(
						db,
						{ scope: service.scope, workflowId: viewing.appId },
						viewing.workflowRevision
							? `${viewing.appId}.workflow`
							: viewing.appId,
						viewing.screenRevision,
					)?.value
				: null;
		let confirmation = null,
			issue: string | null = null;
		if (
			work?.draft &&
			!work.busy &&
			work.dirty &&
			service.storage.available(db, work.appId)
		) {
			try {
				const checked = preview(db, work);
				confirmation = { digest: checked.digest, summary: checked.summary };
			} catch (error) {
				issue = draftIssue(error);
			}
		}
		const live =
			available && viewing?.workflowRevision
				? deps.workflow().view(db, viewing)
				: null;
		const data = {
			kind: "ui-studio",
			work: work
				? {
						workRef: work.id,
						sessionId: work.sessionId,
						title: work.draft?.title ?? "",
						definition: work.draft?.screen?.definition ?? null,
						revision: work.revision,
						source: work.draft ? JSON.stringify(work.draft, null, 2) : "",
						previousSource: "",
						rejected: work.rejected,
						savedRef: work.savedRevision ? work.appId : null,
						savedRevision: work.savedRevision,
						busy: work.busy,
						dirty: work.dirty,
						canUndo: false,
						canRedo: false,
						...(workLifecycle?.state === "initializing" ||
						workLifecycle?.state === "deleting"
							? {
									storageState: workLifecycle.state,
									storageError: workLifecycle.errorCode,
								}
							: {}),
						confirmation,
						issue,
					}
				: null,
			viewing: viewing
				? {
						id: viewing.appId,
						title: viewing.title,
						definition: screen?.definition ?? null,
						storedDefinition: viewing.draft,
						savedRevision: viewing.revision,
						bindings: screen?.bindings ?? null,
						workflow: available ? (viewing.draft.workflow ?? null) : null,
						...(viewing.draft.storage ? { hasStorage: true } : {}),
						deleteDigest: deletionDigest(viewing),
						...(lifecycle
							? {
									storageState: lifecycle.state,
									storageError: lifecycle.errorCode,
								}
							: {}),
						storage: available
							? deps.storage().view(db, viewing, read.page)
							: null,
						...live,
					}
				: null,
			history: service.list(db),
		};
		return {
			revision: Math.max(1, work?.revision ?? 0, viewing?.revision ?? 0),
			data,
		};
	};
}
