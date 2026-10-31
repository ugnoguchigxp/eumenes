/** The fixtures of the page-operator task tests: the real domain, bundle and runner with a scripted model and driver. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser, type BrowserCompletion } from "../../domains/browser";
import {
	connect,
	FakeDriver,
	retarget,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
	until,
	WEB,
	type Env,
} from "../../domains/browser/test/fakes";
import { createCapabilities } from "../../domains/capabilities";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { createQueue } from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createBrowserAdapter } from "./browser-adapter";
import { registerBrowserEffects } from "./browser-effects";
import { createTaskRunner, type TaskRunnerPorts } from "./browser-task-runner";

export const OWNER = CONVERSATION_DEFAULT_PRINCIPAL;
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
export async function cleanup() {
	for (const close of closers.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

export type Message = { role: string; content: string };
export type Fn = (messages: Message[], call: number) => string;
export type Reply = string | Fn;

/** A scripted model: each call takes the next reply; every call's messages are kept. */
export function fakeInference(script: Reply[]) {
	const state = {
		calls: [] as Message[][],
		subjects: [] as string[],
		cancelled: [] as string[],
		released: [] as string[],
		sessions: [] as unknown[],
		accept: true,
		tokens: null as number | null,
		window: null as number | null,
		gate: null as Promise<void> | null,
	};
	let n = 0;
	const ports: TaskRunnerPorts["inference"] = {
		captureUserControlInTransaction(_db, input) {
			if (input.route !== "subagent")
				throw new Error("fixture_subagent_route_required");
			state.subjects.push(input.subject);
			return `request-${state.subjects.length}`;
		},
		async executeControl(requestId, messages, signal, _control, session) {
			state.calls.push(messages.map((m) => ({ ...m })) as Message[]);
			state.sessions.push(session);
			if (state.gate)
				await new Promise<void>((resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason));
					void state.gate!.then(resolve);
				});
			const reply = script[n++];
			if (reply === undefined) throw new Error("script_exhausted");
			const value =
				typeof reply === "function" ? reply(state.calls.at(-1)!, n) : reply;
			return { requestId, attemptId: `attempt-${n}`, value };
		},
		acceptInTransaction: () => state.accept,
		cancelRequestsInTransaction(_db, ids) {
			state.cancelled.push(...ids);
		},
		countControlTokens: () => state.tokens,
		savedLlmContextWindow: () => state.window,
		releaseTaskSession: async (taskId) => {
			state.released.push(taskId);
		},
	};
	return { ports, state };
}

/** The real browser domain, the shipped bundle in a real registry, the real runner; the model and the driver are fakes. */
export async function setup(
	script: Reply[],
	options: {
		taskMs?: number;
		now?: () => number;
		canAutoConnect?: () => boolean;
		credentialRevision?: () => number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-browser-runner-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const driver = new FakeDriver();
	const notices: BrowserCompletion[] = [];
	const capabilities = createCapabilities(
		store,
		new Set(["browser", "web", "timer", "image"]),
		{ bundleHost: offlineBundleHost },
	);
	await capabilities.seed();
	const model = fakeInference(script);
	const service = createBrowser({
		store,
		queue,
		driver,
		encoder: new FakeEncoder(),
		files: new FakeFiles(),
		webOrigins: [WEB],
		resolveHost: fakeResolver(),
		announceInTransaction: (_db, notice) => notices.push(notice),
		...options,
		runTaskStep: createTaskRunner({
			store,
			inference: model.ports,
			capabilities: () => capabilities,
		}),
	});
	queue.start();
	closers.push(async () => {
		await queue.close(100);
		await store.close();
	});
	const said = new Map<string, string>();
	const adapter = createBrowserAdapter(
		service,
		registerBrowserEffects({ queue, service }),
		{ userMessageInTransaction: (_db, id) => said.get(id) ?? null },
	);
	const env = { service, store, queue, driver, notices, dir } as unknown as Env;
	const typed: string[] = [];
	const act = driver.act.bind(driver);
	driver.act = async (action, signal) => {
		if (action.kind === "type") typed.push(action.text);
		return act(action, signal);
	};
	return { env, service, store, driver, notices, model, typed, adapter, said };
}
export type S = Awaited<ReturnType<typeof setup>>;

export const ASKED = "このタブで「ワイヤレスイヤホン」を探して、一番上を開いて";
export async function start(
	s: S,
	extra: {
		request?: string;
		brief?: string;
		url?: string;
		continueFrom?: string;
		approvePending?: boolean;
	} = {},
) {
	const tabRef = await connect(s.env);
	// These tests exercise the operator, not Eumenes' own page. Clicks there need approval (spec §4.4).
	await retarget(s.env, tabRef, "https://example.com/");
	return { tabRef, taskId: await begin(s, tabRef, extra) };
}
/** A task on a tab that is already connected (a follow-up uses the same tab). */
export async function begin(
	s: S,
	tabRef: string,
	extra: Parameters<typeof start>[1] = {},
) {
	const task = await s.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		requestId: crypto.randomUUID(),
		request: extra.request ?? ASKED,
		tabRef,
		...(extra.url ? { url: extra.url } : {}),
		...(extra.brief ? { frozen: { brief: extra.brief } } : {}),
		...(extra.continueFrom
			? {
					continueFrom: extra.continueFrom,
					approvePending: extra.approvePending === true,
				}
			: {}),
	});
	return task.taskId;
}
export const ended = (s: S, taskId: string) =>
	until(
		() =>
			!["queued", "running"].includes(
				s.service.taskStatus(OWNER, taskId).state,
			),
	);

export const tag = (content: string, name: "REFERENCE" | "TOOL_RESULT") =>
	JSON.parse(content.slice(content.indexOf(`${name}=`) + name.length + 1));
/** The newest observation the model has seen: a tool result's, else the first one in REFERENCE. */
export function observation(messages: Message[]) {
	for (const m of [...messages].reverse()) {
		if (m.role !== "user") continue;
		if (m.content.startsWith("TOOL_RESULT=")) {
			const result = tag(m.content, "TOOL_RESULT");
			if (result.observation) return result.observation;
		} else if (m.content.includes("REFERENCE="))
			return tag(m.content, "REFERENCE").observation;
	}
	throw new Error("no observation");
}
export const lastResult = (messages: Message[]) =>
	tag(messages.at(-1)!.content, "TOOL_RESULT");

export const invoke = (tool: string, arguments_: Record<string, unknown>) =>
	JSON.stringify({ action: "invoke", tool, arguments: arguments_ });
/** An invoke whose arguments are built from the observation the model has just seen. */
export const onPage =
	(tool: string, build: (obs: { observationRef: string }) => object): Fn =>
	(messages) => {
		const obs = observation(messages);
		return invoke(tool, { observationRef: obs.observationRef, ...build(obs) });
	};
export const finish = (text: string, refs?: string[]) =>
	JSON.stringify({ action: "finish", text, ...(refs ? { refs } : {}) });
export const clarify = (text: string) =>
	JSON.stringify({ action: "clarify", text });
export const typeInto = (value: string, quote: string, extra: object = {}) =>
	onPage("browser.page.type", () => ({
		ref: "e2",
		element: "検索ボックス",
		value,
		quote,
		purpose: "検索",
		submit: false,
		...extra,
	}));
export const clickGo = (effect = "navigate") =>
	onPage("browser.page.click", () => ({
		ref: "e2",
		element: "Goボタン",
		effect,
	}));

export const approvalRows = (s: S) =>
	s.store.read(
		(db) =>
			db
				.query(
					"SELECT kind, status, action, element, value FROM browser_approvals ORDER BY created_at, rowid",
				)
				.all() as Array<{
				kind: string;
				status: string;
				action: string;
				element: string;
				value: string | null;
			}>,
	);
export const POST_FORM = {
	tag: "button",
	type: "submit",
	inForm: true,
	formMethod: "post",
	submits: true,
};
