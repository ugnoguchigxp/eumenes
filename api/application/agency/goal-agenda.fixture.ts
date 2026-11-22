import { expect } from "bun:test";
import { request, type Profile } from "eumenes-memory-host";
import { PROFILE_SCOPE } from "../../domains/memory/contracts";
import { waitFor } from "../../infrastructure/wait-for";
import type { agendaFixture } from "./always-on.fixture";

type GoalFixture = Awaited<ReturnType<typeof agendaFixture>>;
type GoalToolCall = { name: string; args: Record<string, unknown> };
type GoalDialogue = NonNullable<
	Parameters<typeof agendaFixture>[0]
>["dialogue"];

export function goalConversation(): {
	say: (
		f: GoalFixture,
		text: string,
		calls: GoalToolCall[],
	) => Promise<string[]>;
	dialogue: NonNullable<GoalDialogue>;
} {
	let commands: GoalToolCall[] = [];
	let toolResults: string[] = [];
	const say = async (f: GoalFixture, text: string, calls: GoalToolCall[]) => {
		commands = calls;
		toolResults = [];
		try {
			const run = await f.h.dialogue.submit({
				conversationId: "ao",
				requestId: crypto.randomUUID(),
				text,
			});
			await waitFor(() =>
				["completed", "failed"].includes(
					f.h.dialogue.get(run.id)?.status ?? "",
				),
			);
			expect(f.h.dialogue.get(run.id)?.status).toBe("completed");
			return toolResults;
		} finally {
			commands = [];
		}
	};

	return {
		say,
		dialogue: {
			firstRound(tools, _question, messages) {
				if (
					!commands.length ||
					!commands.every((call) =>
						tools.some(({ function: tool }) => tool.name === call.name),
					)
				)
					return;
				if (messages.at(-1)?.role !== "tool") return { calls: commands };
				toolResults = messages
					.filter((message) => message.role === "tool")
					.slice(-commands.length)
					.map((message) => message.content);
				return { text: "確認しました。" };
			},
		},
	};
}
export const agendaText =
	"README の実行例は `bun run sample -- --dry-run` で書いてください。";
export async function saveAgendaItem(
	profile: Profile,
	options: { text?: string; deadline?: string } = {},
): Promise<string> {
	const text = options.text ?? agendaText;
	const operationId = crypto.randomUUID();
	const source = await request(profile, "source", {
		scopeKey: PROFILE_SCOPE,
		submissionId: operationId,
		provenance: "user_message",
		content: text,
	});
	const context = await request(profile, "context", {
		scopeKeys: [PROFILE_SCOPE],
		agenda: true,
	});
	const plan = await request(profile, "plan", {
		scopeKey: PROFILE_SCOPE,
		snapshotId: context["snapshotId"],
		proposal: {
			decision: {
				clarification: null,
				actions: [
					{
						type: "remember_agenda",
						kind: "temporary_instruction",
						text,
						certainty: "confirmed",
						time: options.deadline
							? {
									original: options.deadline,
									scheduledFor: null,
									deadline: options.deadline,
									validUntil: null,
								}
							: null,
						trigger: null,
						quote: text,
						replacesItemId: null,
					},
				],
			},
			relations: [{ relation: "new", relatedItemIds: [], actionIndex: 0 }],
			groups: [[0]],
		},
		evidence: [
			{
				sourceHandle: source["sourceHandle"],
				actionIndex: 0,
				startByte: 0,
				endByte: Buffer.byteLength(text),
			},
		],
	});
	expect(plan.status, JSON.stringify(plan)).toBe("planned");
	expect(
		await request(profile, "apply", {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId,
		}),
	).toMatchObject({ status: "completed", groups: ["applied"] });
	const current = await request(profile, "context", {
		scopeKeys: [PROFILE_SCOPE],
		agenda: true,
	});
	const item = (
		current["agendaItems"] as { itemId: string; text: string }[]
	).find((item) => item.text === text);
	expect(item?.itemId).toStartWith("agenda:");
	return item!.itemId;
}
