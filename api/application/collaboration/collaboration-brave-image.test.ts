import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
	createBrowser,
	createWebpEncoder,
	type BrowserService,
} from "../../domains/browser";
import {
	FakeDriver,
	FakeFiles,
	fakeBrave,
	fakeResolver,
} from "../../domains/browser/test/fakes";
import { waitFor } from "../../infrastructure/wait-for";
import type { ChatImage } from "../../domains/inference";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { registerBrowserEffects } from "../browser/browser-effects";
import {
	fakeInference,
	finish,
	invoke,
	lastResult,
	observation,
	onPage,
	type Message,
} from "../browser/browser-task.fixture";
import { createTaskRunner } from "../browser/browser-task-runner";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";

test("Collaboration rereads a corrected region and takes a fresh image only when asked", async () => {
	const url = "https://example.com/diagram";
	const request = `${url} を開いて、図をスクショして説明して`;
	const correction = "位置を訂正します。前の図の右下を見てください";
	const recapture = "同じタブで撮り直して、そのラベルをもう一度読んで";
	const description = "緑の区画は未割り当てです。";
	const detail = "右下のラベルは REGISTRARS です。";
	const verified = "撮り直した図でも REGISTRARS と読めます。";
	const script = {
		expectedRevision: 0,
		title: "図の撮影",
		summary: "図を撮影して確認",
		steps: [
			{ label: "図を確認", expectation: "画像を確認する", state: "running" },
		],
	};
	const png = await sharp({
		create: { width: 1000, height: 800, channels: 3, background: "#38a044" },
	})
		.composite([
			{
				input: {
					create: {
						width: 500,
						height: 400,
						channels: 3,
						background: "#205ad0",
					},
				},
				left: 500,
				top: 400,
			},
		])
		.png()
		.toBuffer();
	const driver = new FakeDriver();
	driver.snapshotText = '- img "Diagram" [ref=e1]';
	const captured: Array<{ url?: string; range: string; ref?: string }> = [];
	driver.screenshot = async (range, ref) => {
		captured.push({
			url: driver.tabs.find((tab) => tab.current)?.url,
			range,
			ref,
		});
		return png;
	};
	let published: { revision: number; steps: object[] };
	let firstCaptureId: string;
	const images = (messages: Message[]) =>
		(messages.at(-1) as Message & { images?: ChatImage[] }).images;
	const verifyImage = (messages: Message[]) => {
		const image = images(messages)?.[0];
		expect(image).toMatchObject({
			mime: "image/jpeg",
			width: 1000,
			height: 800,
		});
		expect(image?.bytes.subarray(0, 3)).toEqual(
			new Uint8Array([255, 216, 255]),
		);
		const capture = lastResult(messages.slice(0, -1));
		expect(capture.ok).toBe(true);
		expect(capture.observationRef).toBe(observation(messages).observationRef);
		expect(messages.at(-1)?.content).toContain(capture.captureId);
		return capture.captureId as string;
	};
	const closeScript = (messages: Message[]) =>
		invoke("browser.page.script", {
			...script,
			expectedRevision: published.revision,
			steps: [
				{
					...published.steps[0],
					state: "completed",
					evidenceRef: observation(messages).observationRef,
				},
			],
		});
	const capture = onPage("browser.page.capture_image", () => ({
		range: "element",
		ref: "e1",
	}));
	const model = fakeInference([
		invoke("browser.page.script", script),
		(messages) => {
			published = lastResult(messages).script;
			return invoke("browser.page.tab_new", { url });
		},
		capture,
		(messages) => {
			firstCaptureId = verifyImage(messages);
			return closeScript(messages.slice(0, -1));
		},
		() => finish(description),
		(messages) => {
			expect(messages[2]?.content).toBe(correction);
			expect(messages.at(-1)?.content).toContain(firstCaptureId);
			expect(images(messages)).toHaveLength(1);
			return finish("完了");
		},
		invoke("browser.page.image_regions", {
			regions: [{ left: 550, top: 590, right: 970, bottom: 960 }],
		}),
		(messages) => {
			expect(images(messages)).toHaveLength(2);
			expect(messages.at(-1)?.content).toContain(firstCaptureId);
			return finish(detail, [firstCaptureId]);
		},
		(messages) => {
			expect(messages[2]?.content).toBe(recapture);
			expect(images(messages)).toBeUndefined();
			return capture(messages, 0);
		},
		(messages) => {
			const ref = verifyImage(messages);
			expect(ref).not.toBe(firstCaptureId);
			return finish(verified, [ref]);
		},
	]);

	let service!: BrowserService;
	let routed = 0;
	const h = await harness({
		pipelines: true,
		webResearch: true,
		discoveryTarget: () => "collaborate_task",
		browser: (store, queue, capabilities) => {
			service = createBrowser({
				store,
				queue,
				driver,
				files: new FakeFiles(),
				encoder: createWebpEncoder(),
				resolveHost: fakeResolver(),
				webOrigins: [],
				runTaskStep: createTaskRunner({
					store,
					capabilities,
					inference: model.ports,
				}),
			});
			return {
				service,
				effects: registerBrowserEffects({ queue, service }),
				requests: { userMessageInTransaction: () => null },
			};
		},
		firstRound: (_tools, question, messages) => {
			routed++;
			expect(question).toContain(request);
			return searchThenDelegate(
				(card) => card.id === "collaboration.task",
				request,
				{
					announcement: "Collaborationで確認します。",
					impact: "create",
				},
			)(messages);
		},
		specialist(messages) {
			const { currentWork } = JSON.parse(
				messages[1]!.content
					.split("\n")
					.find((line) => line.startsWith("REFERENCE="))!
					.slice("REFERENCE=".length),
			);
			if (currentWork.hostEvent)
				return { action: "reply", text: currentWork.hostEvent.summary };
			const next = messages.at(-1)!.content;
			return {
				action: "invoke",
				tool: "collaboration.brave.image",
				arguments: {
					expectedRevision: currentWork.revision,
					request: next,
					mode:
						next === correction
							? "reuse"
							: next === recapture
								? "recapture"
								: "capture",
					...(next === request
						? { url }
						: next === correction
							? {
									captureId:
										currentWork.available.brave.recentTasks[0].visualCaptureId,
								}
							: {}),
				},
				text: "図を確認します。",
			};
		},
	});
	const dir = mkdtempSync(join(tmpdir(), "eumenes-collaboration-vision-"));
	const say = async (text: string) => {
		const response = await h.request("/api/runs", {
			conversationId: "main",
			requestId: crypto.randomUUID(),
			text,
		});
		expect(response.status).toBe(202);
		const { id } = await response.json();
		const done = await h.dialogue.waitForTerminal(id, { timeoutMs: 7000 });
		expect(done?.status).toBe("completed");
		return done;
	};
	const waitAnswer = (text: string) =>
		waitFor(
			() => h.conversation.get("main").messages.some((m) => m.text === text),
			{ timeout: 7000 },
		).catch(() => {
			throw new Error(
				JSON.stringify({
					messages: h.conversation.get("main").messages.map((m) => m.text),
					tasks: service.listTasks(CONVERSATION_DEFAULT_PRINCIPAL, "main"),
					modelCalls: model.state.calls.length,
				}),
			);
		});
	try {
		await service.setting.save(fakeBrave(dir));
		await service.connect();
		await service.settled();
		await say(request);
		await waitAnswer(description);
		const session = h.dialogue.specialistSession("main");
		expect(session?.toolchainId).toBe("collaboration.task");
		const tab = service.tabs().find((candidate) => candidate.url === url);
		expect(tab).toBeDefined();
		await service.openTab("self", null, "https://example.com/unrelated");
		const routedBeforeFollowUp = routed;
		const driverCalls = [...driver.calls];
		const next = await say(correction);
		await waitAnswer(detail);
		expect(driver.calls).toEqual(driverCalls);
		expect(captured).toHaveLength(1);
		const crop = model.state.calls
			.map(images)
			.find((set) => set?.length === 2)?.[1];
		const [red, green, blue] = await sharp(crop!.bytes).raw().toBuffer();
		expect(blue!).toBeGreaterThan(green!);
		expect(blue!).toBeGreaterThan(red!);
		expect(next?.specialistSessionId).toBe(session?.id);
		const fresh = await say(recapture);
		await waitAnswer(verified);
		expect(fresh?.specialistSessionId).toBe(session?.id);
		expect(h.dialogue.specialistSession("main")?.id).toBe(session?.id);
		expect(routed).toBe(routedBeforeFollowUp);
		expect(h.acquisitions).toBe(0);
		expect(captured).toEqual(
			Array(2).fill({ url, range: "element", ref: "e1" }),
		);
		expect(
			service.tabs().find((candidate) => candidate.tabRef === tab?.tabRef)?.url,
		).toBe(url);
	} finally {
		await h.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);
