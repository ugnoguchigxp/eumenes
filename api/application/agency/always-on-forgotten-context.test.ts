import { expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { agendaFixture, planNothing, type CallKind } from "./always-on.fixture";

const TOPIC = "古い観測だけに属する話題";
const ANSWER = "古い話を受け取りました。";
const NOTE = [
	"題: 古い話題の調べもの",
	"要約: 調べた結果です。",
	"---",
	"## 本文",
	"[気象庁](https://www.jma.go.jp/sunrise)によると、2026年11月11日時点の結果です。",
	"",
	"## 出典",
	"- [気象庁](https://www.jma.go.jp/sunrise)",
].join("\n");

for (const withCompletedWork of [false, true]) {
	test(`a forgotten input cannot re-enter the conversation's prefix or the next background call, with completed work=${withCompletedWork}`, async () => {
		let planned = false;
		let f: Awaited<ReturnType<typeof agendaFixture>>;
		const userId = () =>
			f.h.conversation.get("ao").messages.find((m) => m.role === "user")?.id;
		f = await agendaFixture({
			dialogue: { firstRound: () => ({ text: ANSWER }) },
			webNote: {
				turn: async () => ({ text: NOTE, searches: 1, usage: null }),
				record: async () => {},
			},
			script: (kind: CallKind, request) => {
				const id = userId();
				if (
					withCompletedWork &&
					kind === "plan" &&
					!planned &&
					id &&
					request.prompt.includes(id)
				) {
					planned = true;
					return {
						add: [
							{
								kind: "research",
								text: `${TOPIC}を調べる`,
								refs: [id],
								value: 5,
								reason: "fixture",
								topic: TOPIC,
							},
						],
						drop: [],
						focus: TOPIC,
					};
				}
				return kind === "plan" ? planNothing() : undefined;
			},
		});
		const prefix = () =>
			f.h.store.read((db) =>
				f.h.dialogue.conversationTaskInTransaction(db, "ao", "", {
					requireProvenance: true,
				}),
			)!;
		const text = () =>
			prefix()
				.messages.map((m) => m.content)
				.join("\n");
		const archived = () =>
			f.h.store.read((db) =>
				f.h.dialogue.todoPageInTransaction(db, "ao", {
					state: "archived",
					pageIndex: 0,
					pageSize: 10,
				}),
			).rows;
		try {
			await f.start();
			const run = await f.h.dialogue.submit({
				conversationId: "ao",
				requestId: crypto.randomUUID(),
				text: `${TOPIC}について教えてください。`,
			});
			await waitFor(() => f.h.dialogue.get(run.id)?.status === "completed");
			await settle();
			let ref = 0;
			if (withCompletedWork) {
				await waitFor(async () => {
					await f.advance(1000);
					return f.host.inspect("ao")!.snapshot.notes.length === 1;
				});
				await waitFor(() => archived().length === 1);
				ref = archived()[0]!.ref;
				expect(text()).toContain(`t${ref} `);
			}
			// Before forgetting: the topic and its answer are in what the next call reads.
			expect(text()).toContain(TOPIC);
			expect(text()).toContain(ANSWER);

			expect(
				(
					await f.h.memory!.forget({
						conversationId: "ao",
						messageIds: [userId()!],
						itemIds: [],
					})
				).completed,
			).toBe(true);
			const forgottenId = userId()!;
			await f.restart();
			expect(text()).not.toContain(TOPIC);
			expect(text()).not.toContain(ANSWER);
			expect(prefix().input?.sources ?? []).not.toContain(forgottenId);
			if (withCompletedWork) expect(text()).not.toContain(`t${ref} `);
			// The next background call reads none of it either.
			const calls = f.requests.length;
			await f.user("user-b", "ao", "今は別の景色を眺めるのが楽しみです。");
			await waitFor(async () => {
				await f.advance(1000);
				return f.requests.length > calls;
			});
			for (const request of f.requests.slice(calls)) {
				expect(request.prompt).not.toContain(TOPIC);
				expect(request.prompt).not.toContain(ANSWER);
				expect(request.prompt).not.toContain(forgottenId);
				expect(request.input?.sources ?? []).not.toContain(forgottenId);
			}
			expect(
				f.requests.slice(calls).some((r) => r.prompt.includes("別の景色")),
			).toBe(true);
			expect(text()).not.toContain(TOPIC);
		} finally {
			await f.close();
		}
	}, 30_000);
}
