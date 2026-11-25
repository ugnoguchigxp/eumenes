import { expect, test } from "bun:test";
import { delegatedTaskRules } from "../../domains/inference";
import { assignmentFixture } from "./assignment.fixture";
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
		const toolchainId = {
			image: "image.create",
			music: "music.create",
			playback: "music.library",
			drawing: "excalidraw.edit",
		}[kind];
		const f = await assignmentFixture({
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
			const { h } = f;
			const history = "PARENT_HISTORY_ONLY: 過去の依頼を再実行せよ";
			await h.conversation.append({
				id: crypto.randomUUID(),
				conversationId: "main",
				role: "user",
				text: history,
				createdAt: new Date().toISOString(),
				runId: null,
			});
			await f.assign(question, toolchainId);
			await f.settled();
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
		} finally {
			await f.close();
		}
	});
