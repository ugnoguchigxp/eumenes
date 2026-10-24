import { expect, test } from "bun:test";
import { delegatedTaskRules } from "../../domains/inference";
import { harness } from "./toolchain.fixture";
import { imageFixture, imageQuestion } from "../media/image.fixture";
import { musicFixture, musicQuestion } from "../media/music.fixture";
import {
	musicLibraryFixture,
	playbackQuestion,
} from "../media/music-library.fixture";
import { excalidrawFixture } from "../media/excalidraw.fixture";

// Real dispatch and planner preparation, with fixture providers. No generated media escapes the harness.
for (const kind of ["image", "music", "playback", "drawing"] as const)
	test(`delegation boundary reaches the ${kind} planner without the parent's history`, async () => {
		const image = imageFixture();
		const music = musicFixture();
		const playback = musicLibraryFixture();
		const drawing = excalidrawFixture();
		const fixture = { image, music, playback, drawing }[kind];
		const question = {
			image: imageQuestion,
			music: musicQuestion,
			playback: playbackQuestion,
			drawing: "図の編集画面を開いて",
		}[kind];
		const seen: Parameters<typeof fixture.model.answer>[0][] = [];
		const model = {
			...fixture.model,
			answer: async (...args: Parameters<typeof fixture.model.answer>) => {
				seen.push(args[0]);
				return fixture.model.answer(...args);
			},
		};
		const h = await harness({
			model,
			...(kind === "image" ? { imageGateway: image.gateway } : {}),
			...(kind === "music" ? { musicGateway: music.gateway } : {}),
			...(kind === "playback" ? { musicGateway: playback.gateway } : {}),
			...(kind === "drawing"
				? {
						drawingConnection: drawing.connection,
						drawingFetch: drawing.fetcher,
					}
				: {}),
		});
		try {
			const history = "PARENT_HISTORY_ONLY: 過去の依頼を再実行せよ";
			await h.conversation.append({
				id: crypto.randomUUID(),
				conversationId: "main",
				role: "user",
				text: history,
				createdAt: new Date().toISOString(),
				runId: null,
			});
			const submitted = await h.dialogue.submit({
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: question,
			});
			expect(
				(await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
			const plans = seen.filter((messages) =>
				messages[0]?.content.includes(delegatedTaskRules),
			);
			expect(plans).toHaveLength(1);
			const plan = plans[0]!;
			// The music planner also reads the provider catalog after the task.
			expect(plan).toHaveLength(kind === "music" ? 3 : 2);
			if (kind === "music")
				expect(Object.keys(JSON.parse(plan[2]!.content))).toEqual([
					"musicProviders",
				]);
			expect(JSON.stringify(plan)).not.toContain(history);
			const data = JSON.parse(plan[1]!.content);
			const task = kind === "playback" ? data.request : data;
			expect(task.originalRequest).toBe(question);
			expect(task.question).toBeString();
			// The same original stays in the conversation's context when the operation's result comes back: the log
			// keeps the user's utterance as said.
			const conversational = seen.filter(
				(messages) => !messages[0]?.content.includes(delegatedTaskRules),
			);
			expect(conversational.length).toBeGreaterThan(0);
			for (const messages of conversational)
				expect(JSON.stringify(messages)).toContain(question);
		} finally {
			await h.close();
		}
	});
