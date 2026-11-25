import { hash } from "../../domains/capabilities";
import type { AssignmentDetails } from "../../domains/dialogue";
import type { LarmPort } from "../../domains/larm";
import { waitFor } from "../../infrastructure/wait-for";
import {
	agendaFixture,
	composeSay,
	replyWith,
	type CallKind,
} from "../agency/always-on.fixture";
import { answerUtterance } from "./conversation-turn.fixture";

/**
 * A toolchain that is not instant and not a session is the agent's assignment (spec
 * toolchain-assignment-stage2-implementation-2026-11-25.md section 1): the user's words are the work's source, the
 * agent starts it at its owner, shows it as being worked on, and reports on its own with the resources it made. The
 * media and work tests start their toolchains the way `delegate` does, through the agency's `assign`, and read the
 * assignment instead of a TODO, a confirmation or the run that waited.
 */
export type Fixture = Awaited<ReturnType<typeof agendaFixture>>;
type AgendaOptions = NonNullable<Parameters<typeof agendaFixture>[0]>;

/** The user's conversation of these fixtures (the agenda's own). */
export const CONVERSATION = "ao";

/** What the agent says when a work report is due (the words themselves are not what the tests read). */
export const said = (kind: CallKind) =>
	kind === "compose" ? composeSay("できました。") : undefined;

/**
 * An agenda over the toolchain harness. `harness` is the toolchain harness's own options (a media gateway, the
 * toolchain's model, the browser's fetcher): the agenda takes them whole.
 */
export async function assignmentAgenda(options: AgendaOptions = {}) {
	return agendaFixture({ script: said, ...options });
}

/**
 * A conversation's model answering its own turns in words (the user's words are handed to a toolchain by the test,
 * as `delegate` does, not by the conversation), and each toolchain's plan by the fixture of that toolchain: the
 * library's by its tags, music's by its duration, any other by the one that is left.
 */
export function plannedBy(parts: {
	image?: { model: LarmPort };
	music?: { model: LarmPort };
	library?: { model: LarmPort };
	other?: { model: LarmPort };
}): LarmPort {
	const base = Object.values(parts).find(Boolean);
	if (!base) throw new Error("fixture_plan_missing");
	return {
		...base.model,
		answer: async (messages, signal, options) => {
			const talk = answerUtterance(
				options,
				messages,
				options?.onToolCalls,
				() => ({ text: "承知しました。" }),
			);
			if (talk !== undefined) return talk;
			const chosen = messages[1]?.content.includes("libraryTags")
				? parts.library
				: messages[0]!.content.includes("durationSeconds")
					? parts.music
					: (parts.image ?? parts.other);
			return (chosen ?? base).model.answer(messages, signal, options);
		},
	};
}

/** The user's words as the conversation stores them (a run of their own), and the source an assignment of them has. */
export async function userWords(
	f: Fixture,
	text: string,
	conversationId = CONVERSATION,
) {
	const run = await f.h.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId,
		text,
	});
	return {
		conversationId,
		messageId: run.inputMessageId,
		runId: run.id,
		request: text,
		digest: hash(text),
	};
}
export type Words = Awaited<ReturnType<typeof userWords>>;

export function card(f: Fixture, toolchainId: string) {
	const found = f.h.store
		.read((db) => f.port.catalogInTransaction(db))
		.find((c) => c.revisionId.startsWith(`toolchain:${toolchainId}@`));
	if (!found) throw new Error(`fixture_toolchain_missing: ${toolchainId}`);
	return found;
}

/** What `delegate` hands the agent when the user asks a toolchain for something. */
export function assign(
	f: Fixture,
	source: Words,
	toolchainId: string,
	details?: AssignmentDetails,
	request = source.request,
) {
	const found = card(f, toolchainId);
	return f.host.dialoguePort.assign!({
		toolchainId,
		revisionId: found.revisionId,
		title: found.title,
		request,
		references: [],
		source,
		...(details ? { details } : {}),
	});
}

/** The user asks a toolchain for something: their words, then the assignment of them. */
export async function ask(
	f: Fixture,
	toolchainId: string,
	text: string,
	details?: AssignmentDetails,
) {
	const source = await userWords(f, text);
	const outcome = await assign(f, source, toolchainId, details);
	if (outcome.status !== "accepted")
		throw new Error(`fixture_assignment_refused: ${JSON.stringify(outcome)}`);
	return { source, id: outcome.id };
}

type Work = {
	root_id: string;
	toolchain_revision_id: string;
	execution_id: string | null;
	returned: number;
};
/** The agent's work rows: one per assignment that was started. */
export const works = (f: Fixture) =>
	f.h.store.read((db) =>
		db
			.query(
				"SELECT root_id,toolchain_revision_id,execution_id,returned FROM dialogue_agency_work ORDER BY created_at,root_id",
			)
			.all(),
	) as Work[];
/** The toolchain executions the assignments started at their owners. */
export const executions = (f: Fixture) =>
	f.h.toolchain.agents.executions.list(CONVERSATION);
/** The agent's open items that are handed to a toolchain (what its state shows as being worked on). */
export const items = (f: Fixture) =>
	f.host
		.inspect(CONVERSATION)!
		.snapshot.agent.items.filter((i) => i.delegatedTo);
/** The work report notes the agent has written. */
export const notes = (f: Fixture) =>
	f.host.inspect(CONVERSATION)!.snapshot.notes;

const ENDED = new Set(["completed", "partial", "failed", "cancelled"]);
/** Every assignment started so far (at least `count`) has ended at its owner. */
export const ended = (f: Fixture, count = 1) =>
	executions(f).length >= count &&
	executions(f).every((e) => ENDED.has(e.status));

/** The agent's own line that reports a finished assignment (its note is quoted, its resources are the chips). */
export const reportLine = (f: Fixture) =>
	f.h.conversation
		.get(CONVERSATION)
		.messages.find((m) => m.id.startsWith("agency:"));

/** The conversation's resources and which messages carry them as chips. */
export async function resources(f: Fixture) {
	return (await (
		await f.h.request(`/api/conversations/${CONVERSATION}/resources`)
	).json()) as {
		resources: Array<{ kind: string; uri: string }>;
		messages: Array<{ messageId: string }>;
	};
}

/** Lets the agent's step run until the condition holds. */
export const until = (f: Fixture, condition: () => boolean, timeout = 15_000) =>
	waitFor(
		async () => {
			await f.advance(1000);
			return condition();
		},
		{ timeout },
	);

/** The assignment has ended at its owner and its report note is written (the work is no longer an open item). */
export async function reported(f: Fixture, count = 1) {
	await until(f, () => notes(f).length >= count);
	await until(f, () => items(f).length === 0);
}

/** The user's reply that cancels an assignment through the assignment tool, as the conversation's agent does. */
export async function cancelAssignment(
	f: Fixture,
	id: string,
	text = "やめて",
) {
	const words = await userWords(f, text);
	return replyWith(
		f,
		[{ name: "assignment", arguments: { id, action: "cancel" } }],
		{
			runId: `run-cancel-${id}`,
			messageIds: [words.messageId],
		},
	);
}
