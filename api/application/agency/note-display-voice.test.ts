import { expect, test } from "bun:test";
import { SHOW_NOTE } from "eumenes-agency/agenda";
import { systemContext } from "../../infrastructure/system-context";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaFixture } from "./always-on.fixture";

test.each([
	"saved",
	"pending",
	"save failed",
	"link failed",
	"cancelled",
] as const)(
	"an empty voice reply after show_note follows the document's result (%s)",
	async (documentState) => {
		let planned = false;
		let noteId: string;
		const pending =
			documentState === "pending" || documentState === "cancelled";
		const f = await agendaFixture({
			noteSavingPolls: pending ? 2 : 0,
			script(kind) {
				if (kind !== "plan" || planned) return;
				planned = true;
				return {
					add: [
						{
							kind: "research",
							text: "調査メモの資料を調べる",
							refs: ["user-a"],
							value: 5,
							reason: "fixture",
							topic: "research",
						},
					],
					drop: [],
					focus: "research",
				};
			},
			webNote: {
				turn: async () => ({
					text: "題: 調査メモ\n要約: 調査結果です。\n---\n調査結果の本文。",
					searches: 1,
					usage: null,
				}),
			},
			dialogue: {
				voiceText: "うん、表示して。",
				firstRound(tools, _question, messages) {
					if (!tools.some(({ function: tool }) => tool.name === SHOW_NOTE))
						return;
					if (messages.at(-1)?.role === "tool")
						throw new Error("cloud_agent_empty_output");
					return { calls: [{ name: SHOW_NOTE, args: { id: noteId } }] };
				},
			},
		});
		try {
			await f.start();
			await f.host.attend("main");
			await f.user("user-a", "main");
			await waitFor(async () => {
				await f.advance(1000);
				return f.documents.started.length === 1;
			});
			noteId = f.host.inspect("main")!.snapshot.notes[0]!.id;
			if (documentState === "save failed")
				f.documents.failing = "markdown_not_saved";
			if (documentState === "link failed")
				f.deps.noteDocuments.linkInTransaction = () => {
					throw new Error("resources_unavailable");
				};

			const sessionId = crypto.randomUUID();
			const utteranceId = crypto.randomUUID();
			const wav = new Uint8Array(48);
			wav.set(new TextEncoder().encode("RIFF"));
			wav.set(new TextEncoder().encode("WAVE"), 8);
			const { voice, dialogue, spoken } = f.h;
			voice.start(sessionId, 1);
			await voice.accept(sessionId, 1, 1, utteranceId, wav);
			await waitFor(() => voice.get(utteranceId)?.status === "input_ready");
			await voice.commit(utteranceId, voice.get(utteranceId)!.revision);
			const hasNoteMessage = () =>
				f.h.conversation
					.get("main")
					.messages.some(({ id }) => id.startsWith("agency-note:"));
			if (pending) {
				const documentId = `doc-${noteId}`;
				await waitFor(() => f.documents.polls.get(documentId) === 1);
				expect(hasNoteMessage()).toBe(false);
				if (documentState === "cancelled") {
					const turn = await voice.cancel(utteranceId);
					f.documents.polls.set(documentId, 0);
					await f.advance(500);
					expect(turn?.status).toBe("cancelled");
					expect(dialogue.get(turn!.runId!)?.status).toBe("cancelled");
					expect(spoken).toEqual([]);
					expect(f.documents.links).toEqual([]);
					expect(hasNoteMessage()).toBe(false);
					return;
				}
				await f.advance(500);
				await waitFor(() => f.documents.polls.get(documentId) === 0);
				await f.advance(500);
			}
			await waitFor(() => {
				const turn = voice.get(utteranceId);
				return (
					turn?.audioComplete === true ||
					["played", "completed", "failed"].includes(turn?.status ?? "")
				);
			});

			const turn = voice.get(utteranceId)!;
			const run = dialogue.get(turn.runId!)!;
			expect(turn.error).toBeNull();
			expect(run.status).toBe("completed");
			if (documentState === "saved" || documentState === "pending") {
				expect(spoken).toEqual([]);
				expect(run.answerMessageId).toBeNull();
				expect(f.documents.links).toEqual([
					expect.objectContaining({
						messageId: expect.stringContaining(`:${run.id}:${noteId}`),
					}),
				]);
				expect(f.h.conversation.get("main").messages).toContainEqual(
					expect.objectContaining({ id: f.documents.links[0]!.messageId }),
				);
			} else {
				const failure = systemContext(
					"dialogue.contexts.local.turn-failed",
					{},
				);
				expect(dialogue.answerText(run.id)).toBe(failure);
				expect(spoken.join("")).toBe(failure);
				expect(f.documents.links).toEqual([]);
				expect(hasNoteMessage()).toBe(false);
			}
		} finally {
			await f.close();
		}
	},
);
