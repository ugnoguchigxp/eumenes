import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { BrowserService } from "../../domains/browser";
import { collaborationInputs } from "../../domains/capabilities";
import type { ChildView, Ports, Source } from "../../domains/collaboration";
import { CONVERSATION_DEFAULT_PRINCIPAL as owner } from "../../domains/conversation/contracts";
import type {
	ExecutionSource,
	ToolchainExecutionPort,
} from "../../domains/tool-runtime";

const target = collaborationInputs.collaborationBraveStart.omit({
	expectedRevision: true,
});
const imageTarget = collaborationInputs.collaborationBraveImage.omit({
	expectedRevision: true,
});
const caller = z.strictObject({
	kind: z.literal("collaboration"),
	workRef: z.uuid(),
	source: z.custom<ExecutionSource>(),
});

function registerTaskAuthority(
	browser: BrowserService,
	execution: Pick<ToolchainExecutionPort, "validSourceInTransaction">,
) {
	browser.setCollaborationTaskAuthority((db, raw) => {
		const parsed = caller.safeParse(raw);
		return (
			parsed.success &&
			!!parsed.data.source?.specialistSessionId &&
			execution.validSourceInTransaction(db, parsed.data.source)
		);
	});
}

export function collaborationBrave(
	browser: BrowserService,
	execution: Pick<ToolchainExecutionPort, "validSourceInTransaction">,
) {
	registerTaskAuthority(browser, execution);

	const available = browser.taskAvailableInTransaction;
	const task = (db: Database, source: Source, id: string) => {
		const view = browser.taskExecutionResultInTransaction(db, owner, id);
		if (view.conversationId !== source.conversationId)
			throw new Error("origin_invalid");
		return view;
	};
	function view(db: Database, source: Source, id: string): ChildView {
		const t = task(db, source, id);
		const approvalExpiry =
			t.state === "needs_input"
				? browser.taskApprovalExpiryInTransaction(db, id)
				: undefined;
		const status: ChildView["status"] =
			t.state === "queued" || t.state === "running"
				? "running"
				: t.state === "needs_input"
					? "waiting_user"
					: t.state === "expired"
						? "failed"
						: t.state;
		const summary = t.result || t.errorLabel;
		return {
			id,
			status,
			revision: t.revision,
			...(summary ? { summary } : {}),
			...(status === "completed" && t.excerpt ? { excerpt: t.excerpt } : {}),
			...(status === "waiting_user"
				? {
						question: {
							id,
							prompt:
								t.result || "ブラウザの操作を続けるには、確認が必要です。",
							approval: approvalExpiry !== undefined,
							revision: t.revision,
							expiresAt: approvalExpiry ?? t.updatedAt + 600_000,
						},
					}
				: {}),
		};
	}
	function start(
		db: Database,
		input: {
			workRef: string;
			requestId: string;
			source: Source;
			root: Source;
			brief: string;
			tabRef?: string;
			url?: string;
			continueFrom?: string;
			approvePending?: boolean;
			visual?: {
				mode: "reuse" | "capture";
				captureId?: string;
				tabRef?: string;
				range?: string;
			};
		},
	) {
		const { source, root, workRef, brief, visual, ...args } = input;
		const authority: ExecutionSource =
			source.messageId === root.messageId
				? root
				: {
						...root,
						responses: [
							{
								messageId: source.messageId,
								request: source.request,
								digest: source.digest,
							},
						],
					};
		if (visual?.mode !== "reuse" && !available(db))
			throw new Error("browser_disconnected");
		if (!execution.validSourceInTransaction(db, authority))
			throw new Error("execution_source_invalid");
		const started = browser.startTaskInTransaction(db, {
			...args,
			owner,
			conversationId: source.conversationId,
			request: source.request,
			origin: "child",
			scriptRequired: !visual || !!args.url,
			frozen: {
				brief,
				packageRevisionId: "package:browser.brave-operator@4",
				caller: { kind: "collaboration", workRef, source: authority },
				...(visual ? { visual } : {}),
			},
		});
		return view(db, source, started.taskId);
	}

	function cancel(db: Database, source: Source, id: string) {
		task(db, source, id);
		const result = browser.cancelTaskInTransaction(db, owner, id);
		if (result.state === "cancelled")
			queueMicrotask(() => {
				if (browser.taskRow(id)?.state === "cancelled") browser.abortTask(id);
			});
		return view(db, source, id);
	}
	return {
		available,
		view,
		cancel,
		owns: (db: Database, source: Source, id: string) =>
			!!source.specialistSessionId &&
			browser.isCollaborationTaskInTransaction(
				db,
				id,
				source.conversationId,
				source.specialistSessionId,
			),
		context(db: Database, source: Source) {
			const tabs = browser
				.tabsInTransaction(db)
				.filter((tab) => tab.status === "idle" || tab.status === "busy")
				.slice(0, 20);
			const live = new Set(tabs.map((tab) => tab.tabRef));
			return {
				available: available(db),
				tabs: tabs.map(({ tabRef, title, active, url }) => ({
					tabRef,
					title: title.slice(0, 150),
					active,
					place: new URL(url).origin + new URL(url).pathname.slice(0, 300),
				})),
				recentTasks: browser
					.recentTasksInTransaction(db, owner, source.conversationId)
					.flatMap(({ taskId, state, requestSummary }) => {
						if (!requestSummary) return [];
						const found = task(db, source, taskId);
						const tabRef =
							"lastTabRef" in found ? found.lastTabRef : found.tabRef;
						return [
							{
								state,
								request: requestSummary,
								tabRef: tabRef && live.has(tabRef) ? tabRef : null,
								...(found.visualCaptureRef &&
								source.specialistSessionId &&
								browser.isCollaborationTaskInTransaction(
									db,
									taskId,
									source.conversationId,
									source.specialistSessionId,
								)
									? { visualCaptureId: found.visualCaptureRef }
									: {}),
							},
						];
					}),
			};
		},
		check(value: unknown) {
			const parsed = target.safeParse(value);
			return parsed.success
				? { ok: true as const, value: parsed.data }
				: {
						ok: false as const,
						issues: [{ path: "", rule: "invalid_browser_request" }],
					};
		},
		start(
			db: Database,
			input: Parameters<Ports["start"]>[2],
			explicitTarget = false,
		) {
			const image = imageTarget.safeParse(input.value);
			const {
				request: brief,
				tabRef,
				url,
			} = image.success ? image.data : target.parse(input.value);
			const previous = input.previousChildId
				? task(db, input.source, input.previousChildId)
				: null;
			const lastTab =
				previous &&
				("lastTabRef" in previous ? previous.lastTabRef : previous.tabRef);
			const mode = image.success ? image.data.mode : undefined;
			if (
				mode === "recapture" &&
				(!lastTab || url || (tabRef && tabRef !== lastTab))
			)
				throw new Error("tab_lost");
			const captureId =
				(image.success ? image.data.captureId : undefined) ??
				previous?.visualCaptureRef;
			const capture =
				mode === "reuse" && captureId && !url
					? browser.collaborationCaptureInTransaction(
							db,
							owner,
							{
								kind: "collaboration",
								workRef: input.workRef,
								source: input.response,
							},
							captureId,
						)
					: undefined;
			if (
				mode === "reuse" &&
				(!capture || url || (tabRef && tabRef !== capture.tabRef))
			)
				throw new Error("browser_capture_not_found");
			// A continuation without a new explicit tab stays on the previous tab even if focus changed.
			if (!capture && previous && !lastTab && !tabRef && !url)
				throw new Error("tab_lost");
			if (explicitTarget && !capture && !previous && !tabRef && !url)
				throw new Error("tab_lost");
			const activeTab = !previous
				? browser
						.tabsInTransaction(db)
						.find((tab) => tab.active && tab.status === "idle")?.tabRef
				: undefined;
			const chosen = tabRef ?? capture?.tabRef ?? lastTab ?? activeTab;
			if (!chosen && !url) throw new Error("tab_lost");
			return start(db, {
				workRef: input.workRef,
				requestId: input.requestId,
				source: input.response,
				root: input.source,
				brief,
				tabRef: mode === "reuse" ? undefined : chosen,
				url,
				...(mode
					? {
							visual: {
								mode: mode === "reuse" ? "reuse" : "capture",
								...(capture && {
									captureId: capture.id,
									tabRef: capture.tabRef,
									range: capture.range,
								}),
								...(mode === "recapture" &&
								!url &&
								chosen === lastTab &&
								previous?.visualCaptureRange
									? { range: previous.visualCaptureRange }
									: {}),
							},
						}
					: {}),
			});
		},
		answer(
			db: Database,
			workRef: string,
			source: Source,
			response: Source,
			child: ChildView,
			raw: unknown,
		) {
			const previous = task(db, source, child.id);
			const approved = child.question?.approval
				? z.strictObject({ approved: z.boolean() }).parse(raw).approved
				: undefined;
			if (approved === false) return cancel(db, source, child.id);
			const brief = approved
				? previous.requestSummary
				: z
						.strictObject({ text: z.string().trim().min(1).max(4000) })
						.parse(raw).text;
			const tabRef =
				"lastTabRef" in previous ? previous.lastTabRef : previous.tabRef;
			if (!tabRef) throw new Error("tab_lost");
			const result = start(db, {
				workRef,
				requestId: response.runId,
				source: response,
				root: source,
				brief,
				tabRef,
				continueFrom: child.id,
				approvePending: approved,
			});
			browser.cancelTaskInTransaction(db, owner, child.id);
			return result;
		},
		forget(db: Database, workRef: string) {
			browser.purgeTaskExecutionInTransaction(db, workRef);
		},
	};
}
