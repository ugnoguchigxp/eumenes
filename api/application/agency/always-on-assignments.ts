import { z } from "zod";
import { toErrorCode } from "../../infrastructure/error-code";
import { getLogger } from "../../infrastructure/logger";
import { workRoot } from "./always-on-flow";
import type { AgendaResearchTicket } from "../../domains/dialogue";
import type { AgendaScope } from "./always-on-scope";
import { GOAL_ASSIGNEE } from "./goal-assignments";
import type { AgencyHostDeps } from "./host-types";

/** The reply's tool for the work the user asked toolchains for (the agent's `assignments`). */
export const ASSIGNMENT = "assignment";

export const assignmentTool = {
	name: ASSIGNMENT,
	description:
		"状態の assignments にある担当の仕事を操作する。answer=担当の質問に利用者が答えた、amend=利用者が依頼の条件を変えた、cancel=利用者がやめると言った。",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["id", "action"],
		properties: {
			id: { type: "string", description: "assignments の id" },
			action: { type: "string", enum: ["answer", "amend", "cancel"] },
			text: {
				type: "string",
				description:
					"answer は利用者の答え、amend は変更後の条件（利用者の言葉から）",
			},
		},
	},
};

const args = z.strictObject({
	id: z.string().min(1),
	action: z.enum(["answer", "amend", "cancel"]),
	text: z.string().trim().max(8000).optional(),
});

/**
 * Answers, amends or cancels an assignment as the user's words of `messageId`: through the toolchain's own control,
 * and the agent's item follows (a cancel drops it, an answer closes the question when the assignee moves on).
 */
export async function controlAssignment(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	arguments: string;
	/** The user's message the reply answers; the toolchain checks the words are the user's. */
	messageId: string | undefined;
	at: number;
	/** Saves the checkpoint of the host (what `startResearch` saves with). */
	save(): Promise<boolean>;
}): Promise<{ content: string }> {
	const { deps, c, at } = input;
	let parsed: z.infer<typeof args>;
	try {
		parsed = args.parse(JSON.parse(input.arguments));
	} catch {
		return { content: "refused: invalid_arguments" };
	}
	const item = c.agent
		.view()
		.items.find((i) => i.id === parsed.id && i.delegatedTo !== undefined);
	if (!item) return { content: "refused: assignment_not_found" };
	if (item.status !== "open" && item.status !== "doing")
		return { content: "refused: assignment_ended" };
	if (item.delegatedTo === GOAL_ASSIGNEE)
		return controlGoal({
			...input,
			parsed,
			item,
			ticket: c.tickets.find((t) => t.itemId === item.id && t.goal),
		});
	const ticket = c.tickets.find((t) => t.itemId === item.id && t.assignment);
	const state = deps.state;
	if (!state) return { content: "refused: agency_unavailable" };
	// Every operation is the user's: a reply to no words of theirs (a notice, its own speech) changes nothing.
	if (!input.messageId) return { content: "refused: utterance_required" };
	if (parsed.action === "cancel") {
		const entry = c.assignments.get(item.id);
		if (ticket) {
			// The scope lets go of the work before the cancel is awaited: a result that comes meanwhile is the cancelled
			// work's, and finds no ticket to be adopted as a failure.
			c.tickets = c.tickets.filter((t) => t !== ticket);
			c.observed.delete(ticket.id);
			c.assignments.delete(item.id);
			try {
				await deps.store.write((db) =>
					state.cancelInTransaction(db, workRoot(c, ticket.id)),
				);
			} catch (error) {
				// Not cancelled: the work goes on as it was.
				c.tickets.push(ticket);
				if (entry) c.assignments.set(item.id, entry);
				return { content: `refused: ${toErrorCode(error, "cancel_failed")}` };
			}
		}
		c.assignments.delete(item.id);
		c.agent.assignmentEnded({ itemId: item.id, at, status: "dropped" });
		c.revision++;
		// Saved at once: a checkpoint from before the cancel would bring the request back after a crash.
		let saved = false;
		for (let attempt = 0; attempt < 5 && !saved; attempt++)
			saved = await input.save();
		if (!saved)
			getLogger("agency").warn("agency.cancel_checkpoint_failed", {
				subjectId: c.id,
			});
		c.kick();
		return { content: `cancelled: ${item.delegatedTo}への依頼をやめた` };
	}
	if (!parsed.text) return { content: "refused: text_required" };
	if (!ticket)
		return { content: "refused: not_started（担当はまだ始めていない）" };
	const { action, text } = parsed;
	try {
		await deps.store.write((db) =>
			state.controlAssignmentInTransaction(
				db,
				workRoot(c, ticket.id),
				{ action, text, question: item.question ?? null },
				input.messageId!,
			),
		);
	} catch (error) {
		// An answer the question cannot take is told the shape it needs, so it can be answered again.
		const schema = (error as { inputSchema?: unknown }).inputSchema;
		return {
			content: `refused: ${toErrorCode(error, "control_failed")}${
				schema ? `（回答の形: ${JSON.stringify(schema)}）` : ""
			}`,
		};
	}
	// What the assignee shows next (its next question, its progress) is told to the agent again.
	c.observed.delete(ticket.id);
	c.kick();
	return {
		content:
			action === "answer"
				? `answered: ${item.delegatedTo}に回答を渡した`
				: `amended: ${item.delegatedTo}に変更を渡した`,
	};
}

/**
 * A registered goal reported as the agent's assignment: the user's answer, change or call-off goes to the goal (its
 * question answered, its words revised, the goal withdrawn), in the user's words of `messageId`.
 */
async function controlGoal(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	parsed: z.infer<typeof args>;
	item: { id: string; text: string; question?: string | null };
	/** Absent while the agent has not issued the item yet (or after a restart, until it does). */
	ticket: AgendaResearchTicket | undefined;
	messageId: string | undefined;
	at: number;
	save(): Promise<boolean>;
}): Promise<{ content: string }> {
	const { deps, c, parsed, item, ticket } = input;
	const work = deps.goalWork;
	if (!work) return { content: "refused: agency_unavailable" };
	if (!input.messageId) return { content: "refused: utterance_required" };
	if (parsed.action !== "cancel" && !parsed.text)
		return { content: "refused: text_required" };
	// The goal is the ticket's; before the agent issued the item, the one its words name in this conversation.
	const view = deps.store
		.read((db) => work.viewsInTransaction(db))
		.find((candidate) =>
			ticket?.goal
				? candidate.goalId === ticket.goal.goalId &&
					candidate.revision === ticket.goal.revision
				: candidate.conversationId === c.id &&
					candidate.text.trim() === item.text.trim(),
		);
	if (!view) return { content: "refused: assignment_ended" };
	// The answer is to the question the user was asked: one the goal no longer asks is not answered by it.
	if (
		parsed.action === "answer" &&
		(!view.question || view.question.prompt !== item.question)
	)
		return { content: "refused: goal_question_not_current" };
	let content: string;
	try {
		content = await work.control({
			conversationId: c.id,
			view,
			action: parsed.action,
			text: parsed.text ?? null,
			messageId: input.messageId,
			signal: c.closed.signal,
		});
	} catch (error) {
		return { content: `refused: ${toErrorCode(error, "control_failed")}` };
	}
	if (parsed.action === "cancel") {
		c.tickets = c.tickets.filter((t) => t !== ticket);
		if (ticket) c.observed.delete(ticket.id);
		c.agent.assignmentEnded({
			itemId: item.id,
			at: input.at,
			status: "dropped",
		});
		c.revision++;
		let saved = false;
		for (let attempt = 0; attempt < 5 && !saved; attempt++)
			saved = await input.save();
	} else if (ticket) c.observed.delete(ticket.id);
	c.kick();
	return { content };
}
