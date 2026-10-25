import type { Database } from "bun:sqlite";
import type { HostTodo } from "eumenes-agency";
import {
	replaceResourceUrisIn,
	type DialogueService,
} from "../../domains/dialogue";
import type { ResourceKind, ResourceRegistry } from "../../domains/resources";

/** Characters of one TODO line (the agency prompt stays short). */
export const TODO_TITLE_CHARS = 60;
/** Characters of one result line. */
export const TODO_RESULT_CHARS = 200;

const oneLine = (text: string, max: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

type LedgerTodo = ReturnType<DialogueService["todosInTransaction"]>[number];

/** The resource kinds' registrations: what each kind lets the host do next. */
export type KindLookup = Pick<ResourceRegistry, "kind">;

const TEXT_FIELDS = ["answer", "summary", "text", "message", "title", "name"];

/**
 * The result of finished work as one line: its own words where it has them, else its data. A resource URI in it
 * is replaced by `resourceName(uri)` before the line is cut (the agency never sees a URI).
 */
export function resultLine(
	given: unknown,
	resourceName: (uri: string) => string = () => "リソース",
): string | undefined {
	const result = replaceResourceUrisIn(given, resourceName);
	if (result === null || result === undefined) return undefined;
	if (typeof result === "string") return oneLine(result, TODO_RESULT_CHARS);
	if (typeof result === "object" && !Array.isArray(result)) {
		const record = result as Record<string, unknown>;
		for (const key of TEXT_FIELDS)
			if (typeof record[key] === "string" && record[key].trim())
				return oneLine(record[key], TODO_RESULT_CHARS);
		// A research report: its claims are the result.
		if (Array.isArray(record.claims)) {
			const claims = record.claims.flatMap((claim) =>
				claim && typeof claim === "object" && typeof claim.text === "string"
					? [claim.text]
					: [],
			);
			if (claims.length) return oneLine(claims.join(" "), TODO_RESULT_CHARS);
		}
	}
	return oneLine(JSON.stringify(result), TODO_RESULT_CHARS);
}

/**
 * What the host can do next with the resources a finished TODO made, in the kinds' words: each kind's default action
 * first, then the other ways to open it; telling its content is offered only where it is the kind's default (a
 * picture is shown, not read out). Repeated words are left out. None when the TODO made nothing.
 */
export function nextActionsOf(
	links: ReadonlyArray<{ kind: string }>,
	kinds: KindLookup,
): string[] {
	const words: string[] = [];
	for (const link of links) {
		const kind: ResourceKind | null = kinds.kind(link.kind);
		if (!kind) continue;
		const actions = [
			kind.defaultAction,
			...kind.actions.filter(
				(action) => action !== kind.defaultAction && action !== "read",
			),
		];
		for (const action of actions) {
			const word = kind.actionLabels[action];
			if (word && !words.includes(word)) words.push(word);
		}
	}
	return words;
}

/**
 * A TODO as the agency sees it: open work, a question the sub-agent asks the user, or finished work with its result.
 * The title names the toolchain the work went to (`[画像の作成] …`), so the agency knows what kind of work it was, and
 * a finished one lists what can be done next with what it made. The agency never sees a resource URI: one in the result
 * line is replaced by the resource's name. Work the user cancelled is not reported back.
 */
export function hostTodoOf(
	item: LedgerTodo,
	kinds: KindLookup,
): HostTodo | null {
	const base = {
		id: item.id,
		title: oneLine(
			item.toolchainTitle
				? `[${item.toolchainTitle}] ${item.title}`
				: item.title,
			TODO_TITLE_CHARS,
		),
		requestedAt: Date.parse(item.createdAt),
	};
	if (item.status === "todo") return { ...base, status: "todo" };
	if (item.status === "waiting")
		return {
			...base,
			status: "waiting",
			question: oneLine(item.question ?? "", TODO_RESULT_CHARS),
		};
	if (item.outcome === "cancelled") return null;
	const links = item.links ?? [];
	const names = new Map(links.map((link) => [link.uri, link.label]));
	const result = resultLine(item.result, (uri) => names.get(uri) ?? "リソース");
	const nextActions = nextActionsOf(links, kinds);
	return {
		...base,
		status: "done",
		outcome:
			item.outcome === "succeeded" || item.outcome === "partial"
				? item.outcome
				: "failed",
		...(result ? { result } : {}),
		...(nextActions.length ? { nextActions } : {}),
		doneAt: Date.parse(item.changedAt),
	};
}

/**
 * The agency's view of a conversation's TODOs (the dialogue ledger, spec ContextWindow section 9): open work,
 * questions to ask and finished work to report. The agency reports what finished and asks what the work asks.
 */
export function createAgencyWork(deps: {
	dialogue: Pick<DialogueService, "todosInTransaction">;
	/** The registered resource kinds (the resource registry). */
	resources: KindLookup;
}) {
	return {
		todosInTransaction(db: Database, conversationId: string): HostTodo[] {
			return deps.dialogue
				.todosInTransaction(db, conversationId)
				.flatMap((item) => hostTodoOf(item, deps.resources) ?? []);
		},
	};
}
export type AgencyWork = ReturnType<typeof createAgencyWork>;
