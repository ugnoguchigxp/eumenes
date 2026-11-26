import { expect, test } from "bun:test";
import { join } from "node:path";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { assignmentFixture } from "../toolchain/assignment.fixture";
import {
	candidatesOf,
	findToolchain,
	searchThenDelegate,
} from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import { canvasFixtureBody, canvasFixtureInstance } from "./canvas.fixture";
import { createCanvasRuntime } from "./runtime";

test("通常の会話とfind_toolchainでは起動せず、選択された検索から保存作品を読む", async () => {
	const searchOnly = "Canvasの検索担当を探して";
	const ask = "Canvasで保存した四角形を探して";
	let offered: string[] = [];
	let opens = 0;
	const search = searchThenDelegate(
		(card) => card.id === "canvas.find" && card.execution === "instant",
		ask,
		{ inputs: { query: "四角形" } },
	);
	const h = await harness({
		routeTool: "canvas_find",
		canvas: (config) =>
			createCanvasRuntime(config, async (options, access) => {
				opens++;
				const instance = canvasFixtureInstance(options.dataDir);
				instance.service.setCandidateAccess(access);
				return instance;
			}),
		firstRound: (_tools, question, messages) => {
			if (question === ask) return search(messages);
			if (question === searchOnly) {
				const list = candidatesOf(messages);
				if (!list) return { calls: [findToolchain(question)] };
				offered = list.map((card) => card.id);
			}
			return { text: "承知しました。" };
		},
	});
	try {
		const previous = canvasFixtureInstance(join(h.dir, "canvas"));
		try {
			await previous.save("保存済みの作品");
		} finally {
			await previous.close();
		}
		for (const text of ["こんにちは", searchOnly, ask]) {
			const run = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
			).toBe("completed");
			expect(opens).toBe(text === ask ? 1 : 0);
			if (text === searchOnly) expect(offered).toContain("canvas.find");
			if (text === ask)
				expect(h.dialogue.answerText(run.id)).toBe(
					`${canvasFixtureBody.title}（r1）`,
				);
		}
	} finally {
		await h.close();
	}
});

test.each([false, true])(
	"会話からの制作は初回ロード後に保存作品の版と依頼元を照合する（撤回=%s）",
	async (retract) => {
		const gate = Promise.withResolvers<void>();
		let opens = 0;
		const f = await assignmentFixture({
			canvas: (config) =>
				createCanvasRuntime(config, async (options, access) => {
					opens++;
					await gate.promise;
					const instance = canvasFixtureInstance(options.dataDir);
					instance.service.setCandidateAccess(access);
					return instance;
				}),
			command: (messages) => {
				const { snapshot } = JSON.parse(messages.at(-1)!.content);
				expect(snapshot.artworks[0]).toMatchObject({
					title: canvasFixtureBody.title,
					currentRevision: 1,
				});
				expect(typeof snapshot.artworks[0].targetRef).toBe("string");
				return JSON.stringify({
					action: "invoke",
					tool: "canvas.produce",
					arguments: { targetRef: snapshot.artworks[0].targetRef },
				});
			},
		});
		try {
			const previous = canvasFixtureInstance(join(f.h.dir, "canvas"));
			const saved = await previous.save("保存済みの作品");
			await previous.close();
			expect(opens).toBe(0);
			const { source } = await f.assign("この四角形の色を変えて", "canvas.app");
			await waitFor(() => opens === 1);
			expect(f.h.commandContexts).toHaveLength(0);
			// The initial load is paused, and the writer is already available to another call.
			expect(
				await f.h.store.write(
					(db) =>
						f.h.conversation.messageInTransaction(db, source.messageId)?.message
							.id,
				),
			).toBe(source.messageId);
			if (retract) {
				const step = f.h.queue
					.list({ kind: "agent.execution.child" })
					.items.find((job) => job.state === "running");
				expect(step).toBeDefined();
				await f.h.conversation.retract({ messageId: source.messageId });
				gate.resolve();
				await waitFor(() => f.h.canvas!.runtime.ready());
				await waitFor(() =>
					["cancelled", "interrupted"].includes(
						f.h.queue.get(step!.id)?.state ?? "",
					),
				);
				await settle();
				expect(f.h.commandContexts).toHaveLength(0);
				expect(f.h.canvas!.jobs.latest(f.conversationId)).toBeNull();
				return;
			}
			gate.resolve();
			await f.settled();
			const job = f.h.canvas!.jobs.latest(f.conversationId);
			expect(f.h.commandContexts).toHaveLength(1);
			expect(f.executions()[0]?.status).toBe("completed");
			expect(job?.state).toBe("completed");
			expect(JSON.parse(job!.payloadJson)).toMatchObject({
				artworkId: saved.artworkId,
				expectedBase: { revision: 1, digest: saved.digest },
			});
			expect(f.h.canvas!.jobs.visibleRun(job!.resultRef!).state).toBe(
				"presented",
			);
			expect(opens).toBe(1);
		} finally {
			gate.resolve();
			await f.close();
		}
	},
);
