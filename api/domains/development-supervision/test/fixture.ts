import { expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { offlineBundleHost } from "../../../application/toolchain/toolchain-adapters";
import {
	createCapabilities,
	hash,
	migrations as capabilityMigrations,
} from "../../capabilities";
import type { InferencePort } from "../../inference";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type {
	ExecutionSource,
	ExecutionView,
	OwnedExecutionView,
} from "../../tool-runtime";
import {
	createDevelopmentSupervision,
	migrations,
	type SupervisedAuthorityRequest,
	type SupervisionChildEvidence,
	type SupervisionChildObservation,
	type SupervisionDesignView,
	type SupervisionHost,
	type SupervisionNote,
	type SupervisionStart,
} from "..";
import type { Proposal } from "../decisions";

export const check = {
	executable: "bun",
	args: ["test", "regression.test.ts"],
	cwd: ".",
};
export const verify = {
	mode: "verify" as const,
	instruction: "Run the regression check.",
	acceptance: ["The check passes."],
	authorityQuote: "run the regression check",
	readablePaths: ["regression.test.ts"],
	writablePaths: [],
	checks: [check],
};
export function proposal(
	mode: Proposal["mode"],
	title = mode === "read" ? "Static read" : "Regression check",
	extra: Partial<Proposal> = {},
): Proposal {
	return {
		...verify,
		mode,
		title,
		after: null,
		verification: null,
		...(mode === "read"
			? {
					acceptance: ["Explain the condition."],
					instruction: "Read the target.",
					checks: [],
					readablePaths: ["input.ts"],
				}
			: {}),
		...(mode === "edit"
			? {
					writablePaths: ["code.ts"],
					readablePaths: ["code.ts", "regression.test.ts"],
					authorityQuote: "fix the source",
				}
			: {}),
		...extra,
	};
}
export const plan = (
	proposals: Proposal[],
	mode: "review" | "execute" = "execute",
) => ({
	action: "design",
	title: "Development work",
	analysis: "Use the existing regression check.",
	mode,
	guideQuery: null,
	proposals,
});

const target = {
	toolchainRevisionId: "toolchain:claude-code.request@7",
	bindingRevisionId: "binding:claude-code.managed@1",
};
const designText = "# Design\nConfirm the result with the regression check.";

type Child = SupervisionChildObservation & {
	start: SupervisionStart;
	stopped: boolean;
};
export async function fixture(
	reply: (data: Record<string, unknown>) => unknown,
	request = "Read the source, fix the source, and run the regression check.",
	researchEnabled = false,
	approvedRequest?: string,
	goal?: SupervisionHost["goal"],
	workspace?: SupervisionHost["workspace"],
	extraMigrations: Parameters<typeof openStore>[1] = [],
) {
	const folder = mkdtempSync(
		join(tmpdir(), "eumenes-development-supervision-"),
	);
	const path = join(folder, "test.db");
	const source: ExecutionSource = {
		conversationId: "chat",
		runId: "run",
		messageId: "message",
		request,
		digest: hash(request),
	};
	const children = new Map<string, Child>();
	const research = new Map<
		string,
		{
			view: ExecutionView;
			note: SupervisionNote;
			source: SupervisionStart["source"];
		}
	>();
	const designs = new Map<string, SupervisionDesignView>();
	const notices = new Map<string, ExecutionView>();
	let noticeDelivery: ((db: Database, id: string) => void) | undefined;
	const answers: { workId: string; questionId: string; answer: string }[] = [];
	const recorded = new Map<string, string>();
	let available = true;
	const confirmationId = approvedRequest ? crypto.randomUUID() : undefined;
	let confirmationCurrent = true;
	let time = Date.now();
	let inputRevision = "input-before";
	let readRevision: string | undefined;
	let preserved = true;
	let store!: ReturnType<typeof openStore>;
	let queue: ReturnType<typeof createQueue>;
	let service: ReturnType<typeof createDevelopmentSupervision>;
	const inference = {
		captureUserControlInTransaction: (
			_db: unknown,
			input: { subject: string; deadline: number },
		) => {
			expect(input.subject).toMatch(/^development-supervision:[a-z0-9-]+$/);
			expect(input.deadline).toBeLessThanOrEqual(time + 120_000);
			return crypto.randomUUID();
		},
		executeControl: async (
			requestId: string,
			messages: Parameters<NonNullable<InferencePort["executeControl"]>>[1],
		) => {
			const data = JSON.parse(messages.at(-1)!.content as string) as Record<
				string,
				unknown
			>;
			return {
				requestId,
				attemptId: requestId,
				value: { decision: reply(data) },
			};
		},
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	function auth(
		input: SupervisionStart,
		action: SupervisedAuthorityRequest["action"],
		extra: Partial<SupervisedAuthorityRequest> = {},
	) {
		return { ...input, action, ...extra };
	}
	const host: SupervisionHost = {
		...(goal ? { goal } : {}),
		validSourceInTransaction: (_db, input) =>
			available && hash(input) === hash(source),
		confirmedRequestInTransaction: (_db, input, id, text) =>
			confirmationCurrent &&
			approvedRequest &&
			id === confirmationId &&
			hash(input) === hash(source) &&
			text === approvedRequest
				? { request: approvedRequest, digest: hash(approvedRequest) }
				: null,
		controlSourceInTransaction: (_db, conversationId, messageId) => {
			const text = recorded.get(messageId);
			return conversationId === source.conversationId && text
				? { messageId, request: text, digest: hash(text) }
				: null;
		},
		validReferenceInTransaction: () => false,
		readReferenceInTransaction: () => "",
		deliverInTransaction: (db, view, eventId) => {
			noticeDelivery?.(db, eventId);
			notices.set(eventId, view);
			return true;
		},
		revokeInTransaction() {},
		workspace: workspace ?? {
			inTransaction: () => ({ workspaceRef: "test", targetRevision: "base" }),
			authorizeInTransaction: () => true,
			inspectInTransaction(_db, scope, workId) {
				const owned = workId ? children.get(workId) : undefined;
				const released = workId
					? (owned?.releaseConfirmed ?? false)
					: undefined;
				const unknown = [...children.values()].find(
					({ view, releaseConfirmed }) =>
						view.stop === "unconfirmed" && !releaseConfirmed,
				);
				if (unknown)
					return {
						released,
						reason:
							unknown === owned ? "自分の停止未確認" : "他タスクの停止未確認",
						blockerRef: unknown.view.id,
					};
				const isBusy = [...children.values()].some(
					({ start, view, releaseConfirmed }) =>
						view.id !== workId &&
						!releaseConfirmed &&
						start.request.includes("Read the target.") ===
							(scope.mode === "read"),
				);
				return isBusy
					? {
							released,
							reason: scope.mode === "read" ? "読取り枠待ち" : "編集枠待ち",
						}
					: { released };
			},
			capture: async (scope) => ({
				targetRevision: "base",
				inputDigest:
					scope.mode === "read"
						? (readRevision ?? inputRevision)
						: inputRevision,
				preserved,
			}),
		},
		research: {
			validEvidenceInTransaction(db, parentSource, evidence) {
				return (
					!!service.researchGrantInTransaction(db, parentSource, evidence.id) &&
					hash(research.get(evidence.id)?.note.evidence ?? null) ===
						hash(evidence)
				);
			},
			targetInTransaction: (_db, kind) =>
				researchEnabled && kind === "inspect.source"
					? {
							toolchainRevisionId: "toolchain:inspect.source@1",
							bindingRevisionId: "binding:inspect.source@1",
						}
					: null,
			startInTransaction(db, kind, start) {
				if (start.source.conversationId === null)
					throw new Error("test_conversation_required");
				expect(
					service.authorizeInTransaction(db, auth(start, "start"))?.kind,
				).toBe(kind);
				const id = crypto.randomUUID();
				const view: ExecutionView = {
					id,
					conversationId: start.source.conversationId,
					request: start.request,
					status: "partial",
					deadline: start.deadline,
					revision: 0,
					question: null,
					result: null,
				};
				const note: SupervisionNote = {
					title: "Read code",
					text: "input.ts still rejects empty rows.",
					at: time,
					evidence: {
						ref: `source:${id}`,
						kind: "source",
						id,
						digest: hash(start.request),
						locations: [
							{
								path: "input.ts",
								symbol: null,
								commit: "base",
								startLine: 3,
								endLine: 9,
								digest: "section-digest",
							},
						],
					},
				};
				research.set(id, { view, note, source: start.source });
				return view;
			},
			viewInTransaction: (db, grant) => {
				const found = grant.workId && research.get(grant.workId);
				return found &&
					service.authorizeInTransaction(db, {
						...grant,
						request: found.view.request,
						action: "view",
						workId: grant.workId!,
					})
					? found.view
					: null;
			},
			noteInTransaction: (_db, _grant, view) =>
				research.get(view.id)?.note ?? null,
			cancelInTransaction() {},
		},
		design: {
			prepare: async (_input, evidence) => ({
				kind: "ready",
				title: "Design",
				markdown: designText,
				digest: hash(designText),
				evidence,
			}),
			startInTransaction(db, binding, prepared) {
				expect(
					service.designBindingInTransaction(
						db,
						binding.documentId,
						binding.parentId,
					),
				).toEqual(binding);
				designs.set(binding.documentId, {
					...prepared,
					documentId: binding.documentId,
					uri: `resource:design:${binding.documentId}`,
				});
			},
			readInTransaction: (_db, binding) =>
				designs.get(binding.documentId) ?? null,
			stateInTransaction: (_db, binding) =>
				designs.has(binding.documentId) ? "ready" : "pending",
			cancelInTransaction(_db, id, forget) {
				if (forget) designs.delete(id);
			},
		},
		child: {
			targetInTransaction: () => target,
			startInTransaction(db, input) {
				const grant = service.authorizeInTransaction(db, auth(input, "start"));
				expect(grant).not.toBeNull();
				if (!input.source.goal) {
					expect(grant?.scope.targetRevision).toBe("base");
					expect(input.request.startsWith(designText)).toBe(true);
				}
				const id = crypto.randomUUID();
				const view: OwnedExecutionView = {
					id,
					...(input.source.goal
						? { conversationId: null, goal: input.source.goal }
						: { conversationId: input.source.conversationId }),
					request: input.request,
					revision: 0,
					status: "deciding",
					deadline: input.deadline,
					question: null,
					result: null,
				};
				children.set(id, {
					start: input,
					view,
					executionId: crypto.randomUUID(),
					evidence: [],
					releaseConfirmed: false,
					stopped: false,
				});
				return view;
			},
			viewInTransaction(db, src, id) {
				const found = children.get(id);
				return found &&
					service.authorizeInTransaction(
						db,
						auth(found.start, "view", { source: src, workId: id }),
					)
					? structuredClone(found)
					: null;
			},
			presentInTransaction(db, _src, id, input) {
				const child = children.get(id)!;
				expect(
					service.authorizeInTransaction(
						db,
						auth(child.start, "present", { ...input, workId: id }),
					),
				).not.toBeNull();
				child.view.question!.expiresAt = input.expiresAt;
			},
			answerInTransaction(db, _src, id, input) {
				const child = children.get(id)!;
				expect(
					service.authorizeInTransaction(
						db,
						auth(child.start, "answer", { ...input, workId: id }),
					),
				).not.toBeNull();
				answers.push({
					workId: id,
					questionId: input.questionId,
					answer: input.answer,
				});
				child.view.question = null;
				child.view.status = "waiting_child";
				child.view.revision++;
			},
			cancelInTransaction(db, _src, id, input) {
				const child = children.get(id)!;
				expect(
					service.authorizeInTransaction(
						db,
						auth(child.start, "cancel", { ...input, workId: id }),
					),
				).not.toBeNull();
				child.stopped = true;
				child.view.status = "stopping";
				child.view.revision++;
			},
		},
	};
	async function open() {
		store = openStore(path, [
			...capabilityMigrations,
			...queueMigrations,
			...extraMigrations,
			...migrations,
		]);
		queue = createQueue(store, {
			pollMs: 3,
			now: () => time,
			resources: { "inference.llm": 2 },
		});
		const capabilities = createCapabilities(
			store,
			new Set(["development-supervision"]),
			{ bundleHost: offlineBundleHost },
		);
		await capabilities.seed();
		service = createDevelopmentSupervision({
			store,
			queue,
			capabilities,
			inference,
			now: () => time,
		});
		service.configure(host);
		queue.start();
	}
	async function close() {
		service.close();
		await queue.close(200);
		await store.close();
	}
	await open();
	const started = await store.write((db) =>
		service.task.startInTransaction(db, {
			source,
			request: approvedRequest ?? request,
			...(confirmationId ? { confirmationId } : {}),
			references: [],
			toolchainRevisionId: "toolchain:development-supervision.request@1",
			bindingRevisionId: "binding:development-supervision.managed@1",
		}),
	);
	const view = () =>
		store.readSnapshot((db) => service.task.viewInTransaction(db, started.id)!);
	const progress = () =>
		store.readSnapshot((db) => service.progressInTransaction(db, started.id)!);
	function complete(
		child: Child,
		evidence: SupervisionChildEvidence[],
		status: ExecutionView["status"] = "completed",
	) {
		child.view.status = status;
		child.view.revision++;
		child.view.question = null;
		child.view.result = {
			status,
			summary: "Child work finished.",
			refs: evidence.map(({ ref }) => ref),
			missing: [],
			fulfilled: [],
		};
		child.evidence = evidence;
		child.releaseConfirmed = true;
		delete child.view.stop;
	}
	return {
		started,
		children,
		research,
		designs,
		notices,
		onNotice(deliver?: typeof noticeDelivery) {
			noticeDelivery = deliver;
		},
		withWriter<T>(run: (db: Database, owner: typeof service) => T) {
			return store.write((db) => run(db, service));
		},
		answers,
		view,
		progress,
		board: () =>
			store.readSnapshot((db) =>
				service.boardRowsInTransaction(db, {
					conversationId: source.conversationId,
				}),
			),
		workspaceChanged: (digest: string, unchanged = true) => {
			inputRevision = digest;
			preserved = unchanged;
		},
		readInputChanged: (digest: string) => {
			readRevision = digest;
		},
		invalidateConfirmation: () => {
			confirmationCurrent = false;
		},
		invalidate: () => {
			available = false;
		},
		advance: (ms: number) => {
			time += ms;
		},
		now: () => time,
		complete,
		async question(child: Child, prompt: string, sdk = false) {
			const id = crypto.randomUUID();
			child.view.status = "waiting_user";
			child.view.revision++;
			child.view.question = {
				id,
				prompt,
				expiresAt: child.start.deadline,
				inputSchema: { type: "string" },
			};
			child.questionExecutionId = sdk ? child.executionId : null;
			await store.write((db) =>
				service.observeInTransaction(db, child.start.source, child.view.id),
			);
			return id;
		},
		control(
			action: "cancel" | "amend" | "answer",
			extra: Record<string, unknown>,
			text: string,
			messageId: string = crypto.randomUUID(),
		) {
			recorded.set(messageId, text);
			return store.write((db) =>
				service.task.controlInTransaction(
					db,
					source.conversationId,
					{
						workRef: started.id,
						expectedRevision: view().revision,
						action,
						...extra,
					},
					messageId,
				),
			);
		},
		grant: (
			child: Child,
			action: SupervisedAuthorityRequest["action"],
			extra: Partial<SupervisedAuthorityRequest> = {},
		) =>
			store.readSnapshot((db) =>
				service.authorizeInTransaction(
					db,
					auth(child.start, action, { workId: child.view.id, ...extra }),
				),
			),
		async waitFor(condition: () => boolean) {
			for (let n = 0; n < 200; n++) {
				await service.recover();
				if (condition()) return;
				await Bun.sleep(5);
			}
			throw new Error(
				`Condition not reached: ${JSON.stringify(progress())}, children=${children.size}`,
			);
		},
		async restart() {
			await close();
			await open();
		},
		async close() {
			await close();
			rmSync(folder, { recursive: true, force: true });
		},
	};
}
