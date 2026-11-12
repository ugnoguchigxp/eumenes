import type { Database } from "bun:sqlite";
import { runRespond, emotionName } from "eumenes-agency";
import {
	agendaReplyMessages,
	createAgendaReplyTools,
	dropRepeatedSentences,
	notesMentioned,
	READ_NOTE,
	SET_QUIET,
	SHOW_NOTE,
	START_PREPARATION,
	type AgendaAddedWords,
} from "eumenes-agency/agenda";
import { agencyStatusSchema } from "../../domains/dialogue/contracts";
import type {
	AgencyLayerPort,
	AgentMessage,
	ConversationAgentPort,
} from "../../domains/dialogue/contracts";
import { getLogger } from "../../infrastructure/logger";
import { currentInput, referencedInput } from "./input";
import { agencyReplyParts } from "./system-context";
import { deliveryEmotionOf } from "./speech";
import {
	agendaClock,
	agendaInterval,
	agendaReady,
	citableNotes,
	knownOf,
	noteRef,
	type AgendaScope,
} from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { quietThought } from "./always-on-thoughts";

const log = getLogger("agency");
/** The calls a reply keeps in its history: the agenda's own tools. */
const AGENDA_TOOL_NAMES: ReadonlySet<string> = new Set([
	START_PREPARATION,
	READ_NOTE,
	SHOW_NOTE,
	SET_QUIET,
]);
/** Tool calls a reply may add for the agenda's own tools (the host's read tools keep theirs). */
const AGENDA_TOOL_CALLS = 3;
/** What a reply left for the pump (its tool calls, the messages a model call took) is kept this many replies. */
const KEPT_REPLIES = 32;

const remember = <T>(map: Map<string, T>, key: string, value: T) => {
	map.set(key, value);
	for (const old of map.keys()) {
		if (map.size <= KEPT_REPLIES) break;
		map.delete(old);
	}
};

export function createAgendaPorts(input: {
	deps: AgencyHostDeps;
	convs: Map<string, AgendaScope>;
	/** The scope of a conversation the agenda serves now, or null (off, or not ready). */
	serving(id: string): AgendaScope | null;
	active(): string | null;
	display(): { id: string; until: number } | null;
	now(): number;
	/** Reads the outbox up to its head into the agents (the user's words are in before the reply is written). */
	catchUp(): void;
	/** A reply begins: what the agent was saying counts as said now (the reply follows it). */
	heard(c: AgendaScope): void;
	changed(): void;
}) {
	const { deps, convs, serving, active, display, now, catchUp, changed } =
		input;
	function noteText(c: AgendaScope, id: string) {
		const note = c.notes.find((n) => n.id === id);
		return note
			? { id: note.id, title: note.title, markdown: note.markdown }
			: null;
	}
	const dialoguePort: AgencyLayerPort = {
		isCurrentInputInTransaction: (db, input) => currentInput(deps, db, input),
		// Memory keeps the input of delivered speech with the message; a line handed to Live is asked for here.
		inputForMessageInTransaction: (_db, id) =>
			[...convs.values()].find((c) => c.proposals.has(id))?.proposals.get(id) ??
			null,
		// What the reply knows of the agent is placed in the reply itself (see `respond`).
		inputForContextInTransaction: () => ({ sources: [], complete: true }),
		stateForContextInTransaction: () => [],
		workChangedInTransaction: () => {
			changed();
		},
		steeredInTransaction: (_db: Database, runId: string) =>
			[...convs.values()].flatMap((c) => c.taken.get(runId) ?? []),
		// A scope exists for every conversation the agenda has seen (no scope is made inside a prompt's transaction).
		servesRepliesInTransaction: (_db: Database, conversationId: string) =>
			convs.has(conversationId) && agendaReady(deps),
		// What the reply was given, captured again at its adoption: gone means forgotten meanwhile.
		replyInputInTransaction: (db: Database, runId: string) => {
			const c = [...convs.values()].find((x) => x.given.has(runId));
			return c
				? referencedInput(deps, db, citableNotes(c), c.given.get(runId) ?? [])
				: null;
		},
	};

	async function agendaReply(
		c: AgendaScope,
		run: NonNullable<Parameters<ConversationAgentPort["respond"]>[0]["run"]>,
		args: Parameters<ConversationAgentPort["respond"]>[0],
	) {
		catchUp();
		input.heard(c);
		const at = now();
		const userIds = new Set(
			c.agent
				.view()
				.said.filter((x) => x.who === "user")
				.map((x) => x.id),
		);
		const citable = (ref: string) =>
			ref.startsWith("memory:") || ref.startsWith("note:") || userIds.has(ref);
		// The agent's state as the reply reads it, placed before the user's last message (the prompt's prefix stays).
		// A reply to a notice or a work report asks the user nothing of its own: no question is offered.
		const asks = run.messageIds.length > 0;
		const built = agendaReplyMessages({
			agent: asks ? c.agent : { ...c.agent, askForReply: () => null },
			known: knownOf(deps, at),
			notes: c.notes.map(noteRef),
			profile: c.profile.markdown,
			clock: agendaClock(at),
			now: at,
		});
		const state = built.find(
			(m) => m.role === "user" && m.content.startsWith("<あなたの今の状態"),
		);
		const messages: AgentMessage[] = state
			? [
					...args.messages.slice(0, -1),
					{ role: "user", content: state.content },
					...args.messages.slice(-1),
				]
			: args.messages;
		// What this reply is given rests in its input: the memory, the notes, and what the state cites.
		remember(c.given, run.runId, [
			...knownOf(deps, at).map((k) => `memory:${k.id}`),
			...c.notes.map((n) => `note:${n.id}`),
			...c.profile.passes.flatMap((p) => p.sources),
			...c.agent.view().items.flatMap((i) => i.refs.filter(citable)),
		]);
		const own = createAgendaReplyTools({
			agent: c.agent,
			read: (id) => noteText(c, id),
			now,
		});
		const ownNames = new Set(own.tools.map((t) => t.name));
		const hostNames = new Set(args.tools.tools.map((t) => t.name));
		const offered = own.tools.filter((t) => !hostNames.has(t.name));
		c.reply = { runId: run.runId, included: new Set(run.messageIds) };
		let steer: ReturnType<AgendaAddedWords["begin"]> | null = null;
		try {
			steer = c.steering?.begin(run.runId) ?? null;
		} catch (error) {
			// No steer for this reply: words sent meanwhile get a reply of their own.
			log.warn("agency.steer_unavailable", {
				subjectId: c.id,
				reason: error instanceof Error ? error.message : "steer_failed",
			});
		}
		let taken: string[] = [];
		let ok = false;
		const quiet = { ...c.agent.view().quiet };
		try {
			const reply = await runRespond({
				messages,
				chat: steer ? steer.wrap(args.chat) : args.chat,
				tools: {
					tools: [...args.tools.tools, ...offered],
					async call(call, signal) {
						if (!ownNames.has(call.name) || hostNames.has(call.name))
							return args.tools.call(call, signal);
						if (call.name === SHOW_NOTE) {
							let id = "";
							try {
								const parsed = JSON.parse(call.arguments) as { id?: unknown };
								id = typeof parsed.id === "string" ? parsed.id : "";
							} catch {
								id = "";
							}
							const note = c.notes.find(
								(n) => n.id === id.replace(/^note:/u, ""),
							);
							// Shown once the reply is adopted (its message appears), never for a reply that is not.
							if (note)
								remember(c.shows, run.runId, [
									...new Set([...(c.shows.get(run.runId) ?? []), note.id]),
								]);
						}
						return own.call(call, signal);
					},
				},
				// Four calls in all, as the reference host allows (the host's own tools keep theirs on top).
				maxToolCalls: Math.max(
					AGENDA_TOOL_CALLS + 1,
					Math.max(0, args.maxToolCalls) + AGENDA_TOOL_CALLS,
				),
				emotion: deps.settings.get().agency.emotion,
				signal: args.signal,
				onDelta: args.onDelta,
			});
			// A reply that said something before a tool and again after says it once in the record.
			const text = dropRepeatedSentences(reply.text);
			for (const id of notesMentioned(text, c.notes.map(noteRef)))
				c.agent.noteUsed(id, now());
			remember(c.calls, run.runId, reply.calls);
			ok = true;
			return { ...reply, text };
		} finally {
			// A reply that failed is news too: the plan looks again.
			if (!ok) c.agent.infoChanged(now());
			quietThought(c, now(), quiet, c.agent.view().quiet);
			// The target is closed whatever happened (one inbox serves the whole server).
			if (steer) taken = steer.end();
			remember(c.taken, run.runId, taken);
			c.reply = null;
			// The reply may have set a quiet or asked for research: saved with the next checkpoint.
			c.revision++;
			changed();
		}
	}

	const conversationAgent: ConversationAgentPort = {
		system: () =>
			agencyReplyParts(deps.settings.get().agency, agendaReady(deps)),
		// The same condition as the agenda's rules in the system: they say how to look for a toolchain and hand over.
		handsWork: () => agendaReady(deps),
		async respond(args) {
			const c = args.run ? serving(args.run.conversationId) : null;
			const reply =
				c && args.run
					? await agendaReply(c, args.run, args)
					: await runRespond({
							...args,
							emotion: deps.settings.get().agency.emotion,
						});
			return {
				text: reply.text,
				ended: reply.ended,
				...(c && args.run
					? {
							calls: reply.calls.filter((call) =>
								AGENDA_TOOL_NAMES.has(call.name),
							),
						}
					: {}),
				...(reply.emotion
					? { emotion: deliveryEmotionOf(emotionName(reply.emotion)) }
					: {}),
			};
		},
	};

	function status(id: string) {
		const c = convs.get(id);
		const view = c?.agent.view();
		return agencyStatusSchema.parse({
			conversationId: id,
			activeConversationId: active(),
			displayedConversationId:
				display() && display()!.until > now() ? display()!.id : null,
			displayExpiresAt: display()?.until ?? null,
			actionsEnabled: deps.settings.get().agency.actions?.enabled ?? true,
			tracked: !!c,
			busy: !!c?.controller,
			idle: c
				? {
						blockedBy: c.busy ? "busy" : null,
						unanswered: view!.unanswered,
						level: 0,
						nextIntervalSec: agendaInterval(
							deps.settings.get().agency.speechIntervalSec,
						),
					}
				: null,
			counts: {
				interests: deps.settings.get().agency.interests.length,
				openIntents: view
					? view.items.filter(
							(i) => i.status === "open" || i.status === "doing",
						).length
					: 0,
				inFlight: c?.tickets.length ?? 0,
			},
		});
	}

	return { dialoguePort, conversationAgent, status };
}
