import { hash } from "../../domains/capabilities";
import type { LarmPort } from "../../domains/larm";
import type { AssignmentDetails } from "../../domains/dialogue";
import { waitFor } from "../../infrastructure/wait-for";
import {
	agendaFixture,
	composeSay,
	type CallKind,
} from "../agency/always-on.fixture";
import { isNoticeRound, isUtteranceRound } from "./conversation-script.fixture";
import type { harness } from "./toolchain.fixture";

type HarnessOptions = NonNullable<Parameters<typeof harness>[0]>;

/** The conversation the agency fixture attends. */
export const ASSIGNMENT_CONVERSATION = "ao";

const said = (kind: CallKind) =>
	kind === "compose" ? composeSay("できました。") : undefined;

/** The conversation's own turns answered in words (a host notice with none), every other call by the given model. */
function talkInWords(model: LarmPort): LarmPort {
	return {
		...model,
		answer: async (messages, signal, callOptions) => {
			// A task's own steps are the model's; its tools include the same search the conversation has.
			const taskStep = callOptions?.tools?.some(
				(t) => t.function.name === "report_partial",
			);
			if (!taskStep && isNoticeRound(messages as never)) return "";
			if (!taskStep && isUtteranceRound(callOptions)) return "承知しました。";
			return model.answer(messages, signal, callOptions);
		},
	};
}

/**
 * A toolchain harness whose conversation is served by the agenda agent: every non-instant, non-session delegation is
 * an assignment of the agent (spec toolchain-assignment-stage2-implementation, section 1), so a test hands the user's
 * words to a toolchain the way `delegate` does and reads what came of the assignment: the item in the agent's
 * `assignments`, the execution at the owner, the report line and the work-report note.
 *
 * The agenda fixture composes the harness; its own `harness` option names a few seams, and the toolchain harness
 * takes all of its options, so the options pass through whole.
 */
export async function assignmentFixture(
	options: HarnessOptions = {},
	agency: { catalog?: (revisionId: string) => boolean } = {},
) {
	const f = await agendaFixture({
		// The conversation answers the user's words in words: handing them to a toolchain is the test's `assign`.
		harness: {
			firstRound: () => ({ text: "承知しました。" }),
			...options,
			// A given model plans the toolchains' work; the conversation's own turns are still answered in words.
			...(options.model ? { model: talkInWords(options.model) } : {}),
		},
		...(agency.catalog ? { catalog: agency.catalog } : {}),
		script: said,
	});
	await f.start();
	const conversationId = ASSIGNMENT_CONVERSATION;
	const card = (toolchainId: string) => {
		const found = f.h.store
			.read((db) => f.port.catalogInTransaction(db))
			.find((c) => c.revisionId.startsWith(`toolchain:${toolchainId}@`));
		if (!found) throw new Error(`fixture_toolchain_missing: ${toolchainId}`);
		return found;
	};
	/** The user's words as the conversation stores them (a run of their own), and the source an assignment of them has. */
	const userWords = async (text: string) => {
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
	};
	const assignFrom = (
		source: Awaited<ReturnType<typeof userWords>>,
		toolchainId: string,
		details: AssignmentDetails | undefined,
		request: string,
	) => {
		const found = card(toolchainId);
		return f.host.dialoguePort.assign!({
			toolchainId,
			revisionId: found.revisionId,
			title: found.title,
			request,
			references: [],
			source,
			...(details ? { details } : {}),
		});
	};
	const executions = (id = conversationId) =>
		f.h.toolchain.agents.executions.list(id);
	const items = (id = conversationId) =>
		f.host.inspect(id)!.snapshot.agent.items.filter((i) => i.delegatedTo);
	const notes = (id = conversationId) => f.host.inspect(id)!.snapshot.notes;
	/** Lets the agent's step run until the condition holds (the agent's clock moves a second per look, not faster than the work). */
	const until = (condition: () => boolean, timeout = 15_000) =>
		waitFor(
			async () => {
				await f.advance(1000);
				return condition();
			},
			{ timeout, interval: 25 },
		);
	return {
		f,
		h: f.h,
		conversationId,
		card,
		userWords,
		executions,
		items,
		notes,
		until,
		/** What `delegate` hands the agent when the user asks a toolchain for something. */
		async assign(
			text: string,
			toolchainId: string,
			details?: AssignmentDetails,
			request = text,
		) {
			const source = await userWords(text);
			return {
				source,
				result: await assignFrom(source, toolchainId, details, request),
			};
		},
		/** The same hand-over for words the conversation already holds (a voice turn, a run the test made). */
		async assignRun(
			runId: string,
			toolchainId: string,
			details?: AssignmentDetails,
			request?: string,
		) {
			const source = f.h.store.read((db) =>
				f.h.dialogue.executionSourceInTransaction(db, runId),
			);
			if (!source) throw new Error("fixture_run_source_missing");
			return {
				source,
				result: await assignFrom(
					source,
					toolchainId,
					details,
					request ?? source.request,
				),
			};
		},
		/** The agent attends one more conversation (a voice turn belongs to the main one). */
		attend: (id: string) => f.host.attend(id),
		/** The agent's own report lines of the conversation (the assignment's resource chips are linked to them). */
		reports: () =>
			f.h.conversation
				.get(conversationId)
				.messages.filter((m) => m.id.startsWith("agency:")),
		/** The result of the newest finished execution as text (what the agent reports from). */
		reported: (id = conversationId) => f.h.reported(id),
		/** Runs the agent until `count` executions exist and every one has ended. */
		settled: (count = 1, id = conversationId, timeout?: number) =>
			until(
				() =>
					executions(id).length >= count &&
					executions(id).every(
						(e) =>
							!["queued", "deciding", "waiting_child", "waiting_user"].includes(
								e.status,
							),
					),
				timeout,
			),
		close: () => f.close(),
	};
}
export type AssignmentFixture = Awaited<ReturnType<typeof assignmentFixture>>;
