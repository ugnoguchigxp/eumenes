import { expect, test } from "bun:test";
import { hash } from "../../domains/capabilities";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { agendaFixture, composeSay, type CallKind } from "./always-on.fixture";

/**
 * Work asked in a conversation that is not the one on screen (a CLI conversation, or one the user left): it starts
 * there, and its report is said there; nothing else is planned or said there.
 */
type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

async function userWords(f: Fixture, conversationId: string, text: string) {
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

const assistantLines = (f: Fixture, conversationId: string) =>
	f.h.store.read(
		(db) =>
			db
				.query(
					"SELECT text FROM messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY rowid",
				)
				.all(conversationId) as { text: string }[],
	);

test("an assignment asked in a conversation not on screen starts there and its report is said there", async () => {
	const gate = Promise.withResolvers<void>();
	const f = await agendaFixture({
		media: imageFixture("success", gate.promise),
		script: (kind: CallKind) =>
			kind === "compose"
				? composeSay("夕焼けの海の絵ができました。")
				: undefined,
	});
	try {
		await f.start();
		const source = await userWords(f, "bo", "夕焼けの海の絵を描いて");
		const found = f.h.store
			.read((db) => f.port.catalogInTransaction(db))
			.find((c) => c.revisionId.startsWith("toolchain:image.create@"))!;
		expect(
			f.host.dialoguePort.assign!({
				toolchainId: "image.create",
				revisionId: found.revisionId,
				title: found.title,
				request: source.request,
				references: [],
				source,
			}),
		).toMatchObject({ status: "accepted" });
		// The user goes on in another conversation: that one is now on screen.
		await userWords(f, "ao", "ところで今日の予定は？");
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.status("bo").activeConversationId === "ao";
		});
		const before = assistantLines(f, "bo").length;
		gate.resolve();
		await waitFor(
			async () => {
				await f.advance(5000);
				return assistantLines(f, "bo")
					.slice(before)
					.some((l) => l.text.includes("夕焼けの海の絵ができました"));
			},
			{ timeout: 20_000 },
		);
	} finally {
		gate.resolve();
		await f.close();
	}
}, 30_000);
