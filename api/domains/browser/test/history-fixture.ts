import type { ScriptBinding, ScriptView } from "../contracts/script";
import type { InputValueApproval } from "../contracts";
import type { TaskApi } from "../service";
import { OWNER, connect, setup, until, type Env } from "./fakes";

/**
 * Drives page-operator tasks by hand: the runner only parks the task and keeps its `TaskApi`, the test
 * publishes Scripts and operates through the service, then ends the task in the state it names.
 */
export type Finish = {
	state: "completed" | "failed" | "needs_input";
	errorCode?: string;
	approvals?: InputValueApproval[];
};
type Slot = { api?: TaskApi; finish?: Finish };

export const SITE = "https://www.example.com";

export async function harness() {
	const slots = new Map<string, Slot>();
	const slot = (id: string) => {
		let s = slots.get(id);
		if (!s) slots.set(id, (s = {}));
		return s;
	};
	const env = setup({
		taskMs: 3_600_000,
		runTaskStep: async (input, ctx) => {
			const s = slot(input.taskId);
			s.api = ctx.api;
			return s.finish
				? {
						kind: "done",
						state: s.finish.state,
						coreState: {},
						text: "終わりました",
						...(s.finish.errorCode ? { errorCode: s.finish.errorCode } : {}),
						...(s.finish.approvals ? { approvals: s.finish.approvals } : {}),
					}
				: { kind: "continue", coreState: {}, delayMs: 5 };
		},
	});
	const tabRef = await connect(env);
	return { env, tabRef, slot };
}
export type H = Awaited<ReturnType<typeof harness>>;

export async function begin(
	h: H,
	request: string,
	extra: { continueFrom?: string; approvePending?: boolean } = {},
) {
	const task = await h.env.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request,
		tabRef: h.tabRef,
		...extra,
	});
	await until(() => !!h.slot(task.taskId).api);
	return task.taskId;
}

export const apiOf = (h: H, taskId: string) => h.slot(taskId).api!;

export async function publish(
	h: H,
	taskId: string,
	over: Record<string, unknown> = {},
) {
	const prior = h.env.service.taskStatus(OWNER, taskId).script;
	const script = (await apiOf(h, taskId).publishScript({
		expectedRevision: prior?.revision ?? 0,
		title: "検索して再生する手順",
		summary: "検索して再生します",
		steps: prior
			? prior.steps.map((s) => ({ ...s }))
			: [{ label: "検索する", expectation: "結果が出る", state: "running" }],
		...over,
	})) as ScriptView;
	const binding: ScriptBinding = {
		revision: script.revision,
		stepId:
			script.steps.find((s) => s.state === "running")?.stepId ??
			script.steps[0]!.stepId,
	};
	return { script, binding };
}

export const observe = (h: H, taskId: string) =>
	h.env.service.observe({ owner: OWNER, taskId, tabRef: h.tabRef });

/** One operation of the task; `code` is what the fake browser reports having run. */
export async function operate(
	h: H,
	taskId: string,
	action: Record<string, unknown>,
	opts: { code?: string; binding?: ScriptBinding } = {},
) {
	const tab = h.env.service.tabs().find((t) => t.tabRef === h.tabRef)!;
	if (opts.code)
		h.env.driver.actResults.push({
			ok: true,
			url: action.kind === "navigate" ? String(action.url) : tab.url,
			title: tab.title,
			code: opts.code,
		});
	const needsRef = ["click", "hover", "type", "select"].includes(
		String(action.kind),
	);
	const o = needsRef ? await observe(h, taskId) : undefined;
	return h.env.service.operate({
		owner: OWNER,
		taskId,
		tabRef: h.tabRef,
		action: needsRef
			? { observationRef: o!.observationRef, ref: "e2", ...action }
			: action,
		...(opts.binding ? { scriptBinding: opts.binding } : {}),
	});
}

export async function finish(h: H, taskId: string, how: Finish) {
	h.slot(taskId).finish = how;
	await until(
		() =>
			!["queued", "running"].includes(
				h.env.service.taskStatus(OWNER, taskId).state,
			),
	);
}

export const histories = (env: Env) => env.service.listHistories(OWNER);
export const rowOf = (env: Env, id: string) =>
	env.store.read(
		(db) =>
			db.query("SELECT * FROM browser_histories WHERE id=?").get(id) as Record<
				string,
				unknown
			> | null,
	);
