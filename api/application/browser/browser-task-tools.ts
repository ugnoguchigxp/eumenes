import { z } from "zod";
import {
	BrowserApprovalRequired,
	type ApprovalRequest,
	type ApprovedItem,
	type CaptureView,
	type InputValueApproval,
	type Observation,
	type OperationOutcome,
	type TaskApi,
} from "../../domains/browser";
import type { SchemaKey, validators } from "../../domains/capabilities";
import type { TaskToolResult } from "../../domains/inference";
import { addSeen, clip, fromPage, originOf, placeOf } from "./browser-text";

/**
 * What the page operator's tools do (spec browser-tabs-toolchain §5.2). The model fills one flat object per
 * tool; each tool turns it into one call of the task's api, which checks the lease, epoch, observation and
 * grant again. The host holds no element names, site procedures or phrases: the model decides, the host
 * only checks what it declared.
 */

export const TOOLCHAIN_ID = "browser.operate";

/** What the runner keeps between jobs besides the task core's own state. */
export const workSchema = z.strictObject({
	/** The tab the page tools act on; null until one is selected (after closing the current one). */
	tabRef: z.string().nullable(),
	/** The origin that tab was last seen at: what an input grant is bound to (the URL itself is not kept). */
	origin: z.string().nullable(),
	/** Tools of the frozen operator package, by id. */
	tools: z.array(z.string()),
	/** What pages showed this task (normalised, bounded): a typed value that comes from it needs the user's allowance. */
	seen: z.array(z.string()).max(6),
	/** Observation and capture refs the model may cite as evidence. */
	evidence: z.array(z.string()).max(64),
	/** Captures this task started; the task waits for them before it ends. */
	captures: z.array(z.string()).max(8),
});
export type Work = z.infer<typeof workSchema>;

/** `request` is the user's own request: what a typed value may come from. */
export type ToolEnv = {
	api: TaskApi;
	work: Work;
	signal: AbortSignal;
	request: string;
};

/** What the user is asked to allow when the task stops; the domain stores it as pending approvals. */
export type Approvals = (ApprovalRequest | InputValueApproval)[];
export type ToolOutcome =
	| { kind: "result"; result: TaskToolResult }
	/** The task stops here and asks the user; nothing was sent to the page. */
	| { kind: "stop"; code: string; text: string; approvals?: Approvals };

/** Codes after which the task cannot go on at all; everything else is a refusal the model may answer. */
export const FATAL_CODES: ReadonlySet<string> = new Set([
	"task_not_active",
	"task_indeterminate",
	/** The domain ended the task when an operation may have reached the page. */
	"operation_indeterminate",
	"browser_disconnected",
	"browser_not_configured",
]);

/** What a model can do about a refusal; the code alone is not always enough. */
const HINTS: Record<string, string> = {
	observation_stale:
		"ページが変わりました。結果の最新のobservationを使うか、observeで観測し直してください。",
	ref_not_actionable:
		"その要素は最新の観測にありません。observationRefとrefを最新の観測から取り直してください。",
	approval_required: "利用者の確認が要る操作です。",
	tab_blocked:
		"そのタブは開けないページを表示しているため操作できません。別のタブを選ぶか、利用者に伝えてください。",
	navigation_unresolved_blocked:
		"ホスト名を確認できないため開けません。別のURLを試すか、利用者に伝えてください。",
	grant_mismatch:
		"入力先のサイトか用途が、値を作ったときと違います。入力先のページで改めて入力してください。",
	tab_lost: "そのタブは見つかりません。tabsで一覧を取り直してください。",
	tab_busy: "そのタブは別の作業が使っています。",
	no_target_tab:
		"操作するタブがありません。tabsで一覧を見て、tab_selectで選んでください。",
	effect_required: "submitがtrueのときはeffectを宣言してください。",
	value_source:
		"inputValueRefを使うならvalueとquoteは書かず、使わないならvalueとquoteを書いてください。",
	navigation_scheme_blocked: "httpとhttps以外は開けません。",
	navigation_private_blocked: "ローカルや社内のアドレスは開けません。",
	navigation_api_blocked: "EumenesのAPIのアドレスは開けません。",
	navigation_credentials_blocked: "認証情報を含むURLは開けません。",
	navigation_invalid_url: "URLの形が正しくありません。",
	capture_dimensions_exceeded: "撮影範囲が大きすぎます（各辺2500pxまで）。",
};

const tabLine = (t: {
	tabRef: string;
	title: string;
	url: string;
	active: boolean;
	status: string;
}) => ({
	tabRef: t.tabRef,
	title: clip(t.title, 100),
	place: placeOf(t.url),
	active: t.active,
	status: t.status,
});

export const observationView = (o: Observation) => ({
	observationRef: o.observationRef,
	title: clip(o.title, 200),
	place: placeOf(o.url),
	text: o.text,
	truncated: o.truncated,
	...(o.reasons.length ? { reasons: o.reasons } : {}),
	refCount: o.refCount,
});

/** What the user already allowed this task (REFERENCE.approved): operations as described, values by ref, never raw. */
export const approvedView = (items: readonly ApprovedItem[]) =>
	items.map((i) =>
		i.kind === "operation"
			? {
					kind: i.kind,
					tabRef: i.tabRef,
					place: placeOf(i.url),
					action: i.action,
					element: i.element,
					summary: i.summary,
				}
			: {
					kind: i.kind,
					inputValueRef: i.inputValueRef,
					origin: i.origin,
					purpose: i.purpose,
					summary: i.summary,
				},
	);

export const refusal = (
	code: string,
	extra: Record<string, unknown> = {},
): TaskToolResult => ({
	ok: false,
	error: code,
	...(HINTS[code] ? { detail: HINTS[code] } : {}),
	...extra,
});
const unretryable = (code: string): TaskToolResult => ({
	ok: false,
	error: code,
	retryable: false,
});

const remember = (work: Work, ref: string) => {
	if (!work.evidence.includes(ref))
		work.evidence = [...work.evidence, ref].slice(-64);
};
const needTab = (work: Work) => {
	if (!work.tabRef) throw new Error("no_target_tab");
	return work.tabRef;
};

/** The task's tab as it is now; what it showed is kept for the check on typed values. */
async function observeNow(env: ToolEnv, tabRef: string) {
	const o = await env.api.observe(tabRef);
	env.work.origin = originOf(o.url);
	env.work.seen = addSeen(env.work.seen, `${o.title}\n${o.text}`);
	remember(env.work, o.observationRef);
	return { observation: observationView(o) };
}

/** The page after a state-changing call: the current observation, so the next call has valid refs. */
async function observed(env: ToolEnv): Promise<Record<string, unknown>> {
	if (!env.work.tabRef) return {};
	try {
		return await observeNow(env, env.work.tabRef);
	} catch (e) {
		const code = e instanceof Error ? e.message : "";
		if (FATAL_CODES.has(code)) throw e;
		return {
			observationError: /^[a-z][a-z0-9_]*$/.test(code) ? code : "failed",
		};
	}
}

/** What the text names of the page or of the user's request is kept short: the screen shows 160 characters of it. */
const shown = (text: string) => `「${clip(text, 40)}」`;

/** What will be done if the user agrees: the element, the action and the page origin, never page text. */
function operationText(request: ApprovalRequest, value?: string) {
	const origin = originOf(request.url) ?? "表示中のページ";
	const what =
		request.action === "press"
			? `キー${shown(request.element)}を押します`
			: request.action === "type"
				? `${shown(request.element)}に${value ? shown(value) : "許可済みの値"}を入力して送信します`
				: `${shown(request.element)}をクリックします`;
	return `${origin}で${what}。確認が要るため止めました。`;
}

/** An operation the host will not run without the user's approval: the task stops and says what it would do. */
function approvalStop(request: ApprovalRequest, typed?: InputValueApproval) {
	return {
		kind: "stop",
		code: "approval_required",
		text: operationText(request, typed?.value),
		approvals: typed ? [request, typed] : [request],
	} satisfies ToolOutcome;
}

/** A value the request did not give: the user is shown it and decides whether it may be typed. */
function valueStop(typed: InputValueApproval) {
	return {
		kind: "stop",
		code: "input_value_unconfirmed",
		text: `${shown(typed.value)}を${typed.origin}の${shown(typed.purpose)}に入力してよいですか。依頼の文から確認できない値のため止めました。`,
		approvals: [typed],
	} satisfies ToolOutcome;
}

/**
 * One operation, then its result; a sent operation that may have reached the page ends the retries. An
 * operation the host holds back for the user's approval stops the task (`approval` words that stop).
 */
async function act(
	env: ToolEnv,
	tabRef: string | undefined,
	action: unknown,
	options: {
		after?: (o: OperationOutcome) => void;
		approval?: (request: ApprovalRequest) => ToolOutcome;
	} = {},
): Promise<ToolOutcome> {
	let o: OperationOutcome;
	try {
		o = await env.api.operate(tabRef, action);
	} catch (e) {
		if (e instanceof BrowserApprovalRequired)
			return (options.approval ?? approvalStop)(e.request);
		throw e;
	}
	if (o.state === "indeterminate")
		return {
			kind: "result",
			result: unretryable(o.errorCode ?? "operation_indeterminate"),
		};
	if (o.state === "failed")
		return {
			kind: "result",
			result: refusal(o.errorCode ?? "operation_failed"),
		};
	options.after?.(o);
	if (o.url) env.work.origin = originOf(o.url);
	return {
		kind: "result",
		result: { ok: true, state: "done", ...(await observed(env)) },
	};
}

const CAPTURE_POLL_MS = 150;
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
const capturing = (v: CaptureView) =>
	v.state === "queued" || v.state === "capturing" || v.state === "encoding";

/** A capture runs only while its task does, so the task waits until it is saved or has failed. */
export async function settleCapture(env: ToolEnv, captureId: string) {
	for (;;) {
		const view = env.api.captureStatus(captureId);
		if (!capturing(view)) return view;
		await sleep(CAPTURE_POLL_MS, env.signal);
	}
}

const captureResult = (v: CaptureView): TaskToolResult =>
	v.state === "local_ready"
		? {
				ok: true,
				captureId: v.captureId,
				range: v.range,
				width: v.width,
				height: v.height,
			}
		: refusal(v.errorCode ?? "capture_failed", { captureId: v.captureId });

type Spec<K extends SchemaKey> = {
	schemaKey: K;
	run: (
		args: z.infer<(typeof validators)[K]>,
		env: ToolEnv,
	) => Promise<ToolOutcome>;
};
const spec = <K extends SchemaKey>(s: Spec<K>) =>
	s as unknown as Spec<SchemaKey>;
const result = (r: TaskToolResult): ToolOutcome => ({
	kind: "result",
	result: r,
});

/** The model's own declaration that an operation finalises something; the host also judges it itself. */
const declared = (effect: string | undefined) =>
	effect === "commit" ? { effect: "commit" as const } : {};

export const PAGE_TOOLS: Readonly<Record<string, Spec<SchemaKey>>> = {
	"browser.page.script": spec({
		schemaKey: "browserScriptPublish",
		async run(args, env) {
			const { history: _history, ...script } =
				await env.api.publishScript(args);
			return result({ ok: true, script });
		},
	}),
	"browser.page.connect": spec({
		schemaKey: "emptyInput",
		async run(_args, env) {
			return result({
				ok: true,
				connection: await env.api.connect(),
				tabs: (await env.api.tabs())
					.filter((t) => t.status !== "closed")
					.slice(0, 20)
					.map(tabLine),
			});
		},
	}),
	"browser.page.tabs": spec({
		schemaKey: "emptyInput",
		async run(_args, env) {
			const tabs = (await env.api.tabs()).filter((t) => t.status !== "closed");
			env.work.seen = addSeen(env.work.seen, ...tabs.map((t) => t.title));
			return result({
				ok: true,
				current: env.work.tabRef,
				tabs: tabs.slice(0, 20).map(tabLine),
			});
		},
	}),
	"browser.page.tab_select": spec({
		schemaKey: "browserTabTarget",
		async run(args, env) {
			return act(
				env,
				args.tabRef,
				{ kind: "tab_select" },
				{
					after: () => {
						env.work.tabRef = args.tabRef;
					},
				},
			);
		},
	}),
	"browser.page.tab_new": spec({
		schemaKey: "browserTabOpen",
		async run(args, env) {
			return act(
				env,
				undefined,
				{ kind: "tab_new", url: args.url },
				{
					after: (o) => {
						if (o.tabRef) env.work.tabRef = o.tabRef;
					},
				},
			);
		},
	}),
	"browser.page.tab_close": spec({
		schemaKey: "browserTabTarget",
		async run(args, env) {
			return act(
				env,
				args.tabRef,
				{ kind: "tab_close" },
				{
					after: () => {
						if (env.work.tabRef === args.tabRef) {
							env.work.tabRef = null;
							env.work.origin = null;
						}
					},
				},
			);
		},
	}),
	"browser.page.navigate": spec({
		schemaKey: "browserTabOpen",
		run: (args, env) =>
			act(env, needTab(env.work), { kind: "navigate", url: args.url }),
	}),
	"browser.page.back": spec({
		schemaKey: "emptyInput",
		run: (_args, env) => act(env, needTab(env.work), { kind: "back" }),
	}),
	"browser.page.observe": spec({
		schemaKey: "emptyInput",
		async run(_args, env) {
			// Asked for on its own, a page that cannot be observed is a refusal the model reads.
			return result({
				ok: true,
				...(await observeNow(env, needTab(env.work))),
			});
		},
	}),
	"browser.page.click": spec({
		schemaKey: "browserPageClick",
		run: (a, env) =>
			act(env, needTab(env.work), {
				kind: "click",
				observationRef: a.observationRef,
				ref: a.ref,
				element: a.element,
				...declared(a.effect),
			}),
	}),
	"browser.page.hover": spec({
		schemaKey: "browserPageHover",
		run: (a, env) =>
			act(env, needTab(env.work), {
				kind: "hover",
				observationRef: a.observationRef,
				ref: a.ref,
				element: a.element,
			}),
	}),
	"browser.page.type": spec({
		schemaKey: "browserPageTypeValue",
		async run(a, env) {
			if (a.submit && !a.effect) throw new Error("effect_required");
			const tabRef = needTab(env.work);
			const origin = env.work.origin;
			if (!origin) throw new Error("no_page_origin");
			let inputValueRef = a.inputValueRef;
			// The value typed when the host holds the operation back: shown to the user, who may then allow it.
			const typed: InputValueApproval | undefined = a.value
				? { kind: "input_value", value: a.value, origin, purpose: a.purpose }
				: undefined;
			if (!inputValueRef) {
				// A value read from a page is not the user's own; the user is shown it before it is typed.
				if (typed && fromPage(typed.value, env.request, env.work.seen))
					return valueStop(typed);
				try {
					// The value becomes a grant only with a quote from the request; the host types it by reference.
					inputValueRef = (
						await env.api.grantFromRequest({
							value: a.value!,
							quote: a.quote!,
							origin,
							purpose: a.purpose,
						})
					).inputValueRef;
				} catch (e) {
					if (
						typed &&
						e instanceof Error &&
						e.message === "grant_source_mismatch"
					)
						return valueStop(typed);
					throw e;
				}
			}
			return act(
				env,
				tabRef,
				{
					kind: "type",
					observationRef: a.observationRef,
					ref: a.ref,
					element: a.element,
					inputValueRef,
					purpose: a.purpose,
					submit: a.submit,
					...declared(a.effect),
				},
				{ approval: (request) => approvalStop(request, typed) },
			);
		},
	}),
	"browser.page.select": spec({
		schemaKey: "browserPageSelect",
		run: (a, env) =>
			act(env, needTab(env.work), {
				kind: "select",
				observationRef: a.observationRef,
				ref: a.ref,
				element: a.element,
				values: a.values,
			}),
	}),
	"browser.page.press": spec({
		schemaKey: "browserPagePress",
		run: (a, env) =>
			act(env, needTab(env.work), {
				kind: "press",
				key: a.key,
				...declared(a.effect),
			}),
	}),
	"browser.page.wait": spec({
		schemaKey: "browserPageWait",
		run: (a, env) =>
			act(env, needTab(env.work), {
				kind: "wait",
				...(a.text ? { text: a.text } : {}),
				...(a.textGone ? { textGone: a.textGone } : {}),
				...(a.seconds ? { seconds: a.seconds } : {}),
			}),
	}),
	"browser.page.capture": spec({
		schemaKey: "browserPageCapture",
		async run(a, env) {
			const tabRef = needTab(env.work);
			const started = await env.api.capture(
				a.range === "element"
					? {
							tabRef,
							range: "element",
							elementRef: a.ref!,
							observationRef: a.observationRef!,
						}
					: { tabRef, range: a.range },
			);
			env.work.captures = [...env.work.captures, started.captureId].slice(-8);
			remember(env.work, started.captureId);
			return result(captureResult(await settleCapture(env, started.captureId)));
		},
	}),
};
