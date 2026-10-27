import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
	SUMMARY_CHARS,
	type ApprovalRequest,
	type Effect,
	type PageOperation,
} from "../contracts";
import type { DriverAction } from "../contracts/ports";
import { originPath } from "../contracts/url";
import type { TabRow } from "../repository";
import { keyCommits } from "./approvals";
import type { Ctx } from "./context";
import type { Grants } from "./grants";
import { originOf } from "./grants";
import { checkNavigationTarget } from "./navigation";
import { checkRef, type TaskRef } from "./operation-checks";

export const digestOf = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * What decides whether an operation needs the user's approval: the model's own declaration, or what the
 * host reads from the element the operation would act on (a fixed inspection, taken when the tab is current).
 */
export type CommitGuard = {
	declared: boolean;
	probe: { ref: string } | "focused";
	request: ApprovalRequest;
};

export type Planned = {
	driver: DriverAction | null;
	newTabUrl: string | null;
	observation: { ref: string; element: string } | null;
	digest: unknown;
	commit: CommitGuard | null;
	/** What the operation was given, kept for the history (spec browser-run-history §3.1). */
	detail: Record<string, unknown>;
};

const clip = (text: string) => text.slice(0, SUMMARY_CHARS);

/** Validates an operation against the tab, observation and grants and turns it into a driver call, a ledger digest and a commit guard. */
export function planOperation(
	ctx: Ctx,
	grants: Grants,
	db: Database,
	action: PageOperation,
	tab: TabRow | null,
	task: TaskRef | null,
): Planned {
	const base = {
		kind: action.kind,
		tab: tab?.tab_ref ?? null,
		at: tab?.url ?? null,
	};
	const none = { newTabUrl: null, observation: null, commit: null };
	const declaredEffect = (effect: Effect | undefined) =>
		effect ? { effect } : {};
	const request = (
		kind: "click" | "press" | "type",
		element: string,
		summary: string,
		valueDigest?: string,
	): ApprovalRequest => ({
		kind: "operation",
		tabRef: tab!.tab_ref,
		url: originPath(tab!.url),
		action: kind,
		element,
		summary: clip(summary),
		...(valueDigest ? { valueDigest } : {}),
	});
	const observed = (observationRef: string, ref: string) => {
		checkRef(db, tab!, task, observationRef, ref);
		return {
			observation: { ref: observationRef, element: ref },
			at: {
				observation: observationRef,
				generation: tab!.generation,
				ref,
			},
		};
	};
	switch (action.kind) {
		case "navigate": {
			const v = checkNavigationTarget(action.url, ctx.webOrigins);
			if (!v.ok) throw new Error(v.code);
			return {
				...none,
				driver: { kind: "navigate", url: v.url },
				digest: { ...base, url: v.url },
				detail: { url: v.url },
			};
		}
		case "tab_new": {
			const v = checkNavigationTarget(action.url, ctx.webOrigins);
			if (!v.ok) throw new Error(v.code);
			return {
				...none,
				driver: null,
				newTabUrl: v.url,
				digest: { ...base, url: v.url },
				detail: { url: v.url },
			};
		}
		case "back":
			return { ...none, driver: { kind: "back" }, digest: base, detail: {} };
		case "tab_close":
		case "tab_select":
			return { ...none, driver: null, digest: base, detail: {} };
		case "click": {
			const o = observed(action.observationRef, action.ref);
			return {
				driver: { kind: "click", ref: action.ref, element: action.element },
				newTabUrl: null,
				observation: o.observation,
				digest: { ...base, ...o.at },
				detail: {
					element: action.element,
					...declaredEffect(action.effect),
				},
				commit: {
					declared: action.effect === "commit",
					probe: { ref: action.ref },
					request: request(
						"click",
						action.element,
						`「${action.element}」をクリックします（送信・確定の操作）`,
					),
				},
			};
		}
		case "hover": {
			const o = observed(action.observationRef, action.ref);
			return {
				...none,
				driver: { kind: "hover", ref: action.ref, element: action.element },
				observation: o.observation,
				digest: { ...base, ...o.at },
				detail: { element: action.element },
			};
		}
		case "type": {
			const o = observed(action.observationRef, action.ref);
			if (!task) throw new Error("grant_not_found");
			const origin = originOf(tab!.url);
			if (!origin) throw new Error("grant_mismatch");
			const used = grants.useInTransaction(
				db,
				task.id,
				action.inputValueRef,
				origin,
				action.purpose,
			);
			const text = used.value;
			const value = digestOf(text);
			const commits = action.submit || action.effect === "commit";
			return {
				driver: {
					kind: "type",
					ref: action.ref,
					element: action.element,
					text,
					submit: action.submit,
				},
				newTabUrl: null,
				observation: o.observation,
				digest: { ...base, ...o.at, value, submit: action.submit },
				// The typed value is kept only when it is the user's own words and no Script variable.
				detail: {
					element: action.element,
					purpose: action.purpose,
					origin,
					provenance: used.provenance,
					...declaredEffect(action.effect),
					...(used.variable
						? { variable: used.variable }
						: used.provenance === "request"
							? { value: text }
							: {}),
				},
				commit: commits
					? {
							declared: action.effect === "commit",
							probe: { ref: action.ref },
							request: request(
								"type",
								action.element,
								`「${action.element}」へ入力して送信します（送信・確定の操作）`,
								value,
							),
						}
					: null,
			};
		}
		case "select": {
			const o = observed(action.observationRef, action.ref);
			return {
				...none,
				driver: {
					kind: "select",
					ref: action.ref,
					element: action.element,
					values: action.values,
				},
				observation: o.observation,
				digest: { ...base, ...o.at, values: digestOf(action.values) },
				detail: { element: action.element, values: action.values },
			};
		}
		case "press": {
			const declared = action.effect === "commit";
			return {
				driver: { kind: "press", key: action.key },
				newTabUrl: null,
				observation: null,
				digest: { ...base, key: action.key },
				detail: { key: action.key, ...declaredEffect(action.effect) },
				commit:
					declared || keyCommits(action.key)
						? {
								declared,
								probe: "focused",
								request: request(
									"press",
									action.key,
									`キー ${action.key} を押します（送信・確定の操作）`,
								),
							}
						: null,
			};
		}
		case "wait":
			return {
				...none,
				driver: {
					kind: "wait",
					...(action.text ? { text: action.text } : {}),
					...(action.textGone ? { textGone: action.textGone } : {}),
					...(action.seconds ? { seconds: action.seconds } : {}),
				},
				digest: { ...base, wait: digestOf(action) },
				detail: {
					...(action.text ? { text: action.text } : {}),
					...(action.textGone ? { textGone: action.textGone } : {}),
					...(action.seconds ? { seconds: action.seconds } : {}),
				},
			};
	}
}
