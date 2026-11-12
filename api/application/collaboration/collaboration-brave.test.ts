import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowser, type BrowserService } from "../../domains/browser";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import type { Run } from "../../domains/dialogue/contracts";
import {
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeBrave,
	fakeResolver,
} from "../../domains/browser/test/fakes";
import { waitFor } from "../../infrastructure/wait-for";
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

const origin = "https://example.com";
const excerpt = "準備ができたら、設定画面で接続先を保存します。";
const script = {
	expectedRevision: 0,
	title: "画面の表示を確認",
	summary: "指定の範囲を確認します。",
	steps: [
		{
			label: "対象を確認",
			expectation: "依頼の箇所を確認する",
			state: "running",
		},
	],
};
const complete = (
	published: { revision: number; steps: object[] },
	messages: Message[],
) =>
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

test.each(["browser request", "bare URL request", "dedicated"] as const)(
	"switching from %s to Collaboration keeps the original Brave tab and delivers its quotation",
	async (entry) => {
		const fromConversation = entry !== "dedicated";
		const request = {
			"browser request": `ブラウザで ${origin}/list を開いて`,
			"bare URL request": `${origin}/list これ開いて`,
			dedicated: "このタブでプロジェクトの一覧を開いてください",
		}[entry];
		const continuation = "今度は設定のページに移って、準備の節を読み上げて";
		const switchRequest =
			"ここからCollaborationに切り替えて、さっき開いたタブで続けて。";
		const driver = new (class extends FakeDriver {
			readPlaces: string[] = [];
			async readText() {
				const url = this.tabs.find((tab) => tab.current)!.url;
				this.readPlaces.push(url);
				const text = `準備 ${excerpt} 次の項目`;
				return {
					url,
					title: "設定",
					text,
					charCount: text.length,
					truncated: false,
					root: "main" as const,
				};
			}
		})();
		driver.tabs[0]!.url = `${origin}/home`;
		let published: { revision: number; steps: object[] };
		const model = fakeInference([
			invoke("browser.page.script", script),
			(messages) => {
				published = lastResult(messages).script;
				return fromConversation
					? invoke("browser.page.connect", {})
					: invoke("browser.page.navigate", { url: `${origin}/list` });
			},
			...(fromConversation
				? [
						(messages: Message[]) => {
							expect(messages[0]?.content).toContain(
								"接続状態やタブ一覧はevidenceRefにならない。",
							);
							expect(lastResult(messages)).toMatchObject({
								ok: true,
								connection: { availability: { available: true } },
							});
							expect(lastResult(messages).observation).toBeUndefined();
							return invoke("browser.page.tab_new", { url: `${origin}/list` });
						},
					]
				: []),
			(messages) => complete(published, messages),
			finish("一覧を開きました。"),
			() => {
				throw new Error("cloud_agent_empty_output");
			},
			invoke("browser.page.script", script),
			(messages) => {
				published = lastResult(messages).script;
				expect(messages.at(2)?.content).toContain(continuation);
				return invoke("browser.page.navigate", { url: `${origin}/setup` });
			},
			onPage("browser.page.text", () => ({ quote: "ページに存在しない文" })),
			(messages) => {
				expect(lastResult(messages)).toMatchObject({
					ok: false,
					error: "excerpt_not_observed",
				});
				return onPage("browser.page.text", () => ({}))(messages, 0);
			},
			(messages) => {
				expect(lastResult(messages)).toMatchObject({
					ok: true,
					text: expect.stringContaining(excerpt),
				});
				return onPage("browser.page.text", () => ({ quote: excerpt }))(
					messages,
					0,
				);
			},
			(messages) => complete(published, messages),
			finish("読み上げ対象の原文を取得しました。"),
		]);
		let service!: BrowserService;
		let originalTab: string | undefined;
		const h = await harness({
			pipelines: true,
			webResearch: true,
			discoveryTarget: (query) =>
				query.includes("Collaboration")
					? "collaborate_task"
					: fromConversation
						? "browser_operate"
						: "collaborate_brave",
			browser: (store, queue, capabilities) => {
				service = createBrowser({
					store,
					queue,
					driver,
					files: new FakeFiles(),
					encoder: new FakeEncoder(),
					resolveHost: fakeResolver(),
					webOrigins: [],
					canAutoConnect: () => fromConversation,
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
			firstRound: (_tools, question, messages) =>
				question.includes(switchRequest)
					? searchThenDelegate(
							(card) => card.id === "collaboration.task",
							switchRequest,
							{
								announcement: "Braveで進めます。",
								impact: "create",
							},
						)(messages)
					: question.includes(request)
						? searchThenDelegate(
								(card) =>
									card.id ===
									(fromConversation
										? "browser.operate"
										: "collaboration.brave"),
								request,
								{
									announcement: "ブラウザで開きます。",
									impact: "create",
								},
							)(messages)
						: { text: "一覧を開きました。" },
			command: () =>
				JSON.stringify({
					action: "invoke",
					tool: "browser.task.start",
					arguments: { request, url: `${origin}/list` },
				}),
			specialist(messages) {
				const work = JSON.parse(
					messages[1]!.content
						.split("\n")
						.find((line) => line.startsWith("REFERENCE="))!
						.slice("REFERENCE=".length),
				).currentWork;
				if (work.hostEvent) {
					expect(work.hostEvent.excerpt).toBeUndefined();
					return { action: "reply", text: "一覧を開きました。" };
				}
				const utterance = messages.at(-1)!.content;
				if (work.kind === "brave") {
					if (utterance.includes(switchRequest))
						return { action: "return", forward: true };
					return {
						action: "invoke",
						tool: "collaboration.brave.start",
						arguments: {
							expectedRevision: work.revision,
							request,
							tabRef: originalTab,
						},
						text: "ブラウザで開きます。",
					};
				}
				const context = messages.find((message) =>
					message.content.startsWith("CONVERSATION_HANDOFF="),
				)?.content;
				expect(context).toContain(request);
				if (utterance.includes(switchRequest)) {
					expect(context).toContain('"arrivedThisTurn":true');
					return { action: "reply", text: "引き継ぎました。" };
				}
				expect(utterance).toContain(continuation);
				const available = work.available.brave;
				const inherited = available.recentTasks.find(
					(task: { request: string }) => task.request === request,
				);
				expect(inherited).toMatchObject({
					state: "completed",
					tabRef: originalTab,
				});
				expect(
					available.tabs.some(
						(tab: { tabRef: string; active: boolean }) =>
							tab.active && tab.tabRef !== originalTab,
					),
				).toBe(true);
				return {
					action: "invoke",
					tool: "collaboration.brave.start",
					arguments: {
						expectedRevision: work.revision,
						request: continuation,
						tabRef: inherited.tabRef,
					},
					text: "Braveで確認します。",
				};
			},
		});
		const dir = mkdtempSync(join(tmpdir(), "eumenes-collaboration-brave-"));
		const say = async (text: string) => {
			const response = await h.request("/api/runs", {
				conversationId: "main",
				requestId: crypto.randomUUID(),
				text,
			});
			expect(response.status).toBe(202);
			const run = await response.json();
			const done = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 7000,
			});
			expect(done?.status, JSON.stringify(done)).toBe("completed");
		};
		const waitForAnswer = (text: string) =>
			waitFor(
				() =>
					h.conversation
						.get("main")
						.messages.some((message) => message.text === text),
				{
					timeout: 7000,
				},
			).catch(() => {
				throw new Error(
					JSON.stringify({
						messages: h.conversation
							.get("main")
							.messages.map((message) => message.text),
						calls: model.state.calls.length,
						session: h.dialogue.specialistSession("main")?.toolchainId,
						available: service.availability(),
					}),
				);
			});
		try {
			await service.setting.save(fakeBrave(dir));
			if (!fromConversation) {
				await service.connect();
				await service.settled();
				originalTab = service.tabs()[0]!.tabRef;
			}
			await say(request);
			if (fromConversation) {
				await waitFor(
					() =>
						service
							.listTasks(CONVERSATION_DEFAULT_PRINCIPAL, "main")
							.some((task) => task.state === "completed"),
					{ timeout: 7000 },
				);
				originalTab = service
					.tabs()
					.find((tab) => tab.url === `${origin}/list`)!.tabRef;
				expect(driver.connectCount).toBe(1);
			} else await waitForAnswer("一覧を開きました。");
			if (!originalTab) throw new Error("opened_browser_tab_missing");
			const dedicated = h.dialogue.specialistSession("main");
			if (fromConversation) expect(dedicated).toBeNull();
			else expect(dedicated?.toolchainId).toBe("collaboration.brave");
			expect(
				service.tabs().find((tab) => tab.tabRef === originalTab)?.url,
			).toBe(`${origin}/list`);
			await service.openTab("self", null, `${origin}/unrelated`);
			await say(switchRequest);
			const common = h.dialogue.specialistSession("main");
			expect(common?.toolchainId).toBe("collaboration.task");
			expect(common?.id).not.toBe(dedicated?.id);
			expect(
				service.listTasks(CONVERSATION_DEFAULT_PRINCIPAL, "main"),
			).toHaveLength(1);
			await say(continuation);
			await waitForAnswer(excerpt);
			expect(h.dialogue.specialistSession("main")?.id).toBe(common?.id);
			expect(
				service.tabs().find((tab) => tab.tabRef === originalTab)?.url,
			).toBe(`${origin}/setup`);
			expect(driver.readPlaces).toEqual(Array(3).fill(`${origin}/setup`));
			expect(h.acquisitions).toBe(0);
			const runs: Run[] = await (
				await h.request("/api/conversations/main/runs")
			).json();
			const read = runs.findLast((run) => run.sourceKind === "notice");
			expect(read).toMatchObject({
				status: "completed",
				specialistSessionId: common?.id,
			});
			const { sentences } = (await (
				await h.request("/api/voice/replay/sentences", { text: excerpt })
			).json()) as { sentences: string[] };
			expect(sentences.join("")).toBe(excerpt);
			for (const text of sentences) {
				const audio = await h.request("/api/voice/replay/audio", {
					text,
					runId: read!.id,
				});
				expect(audio.status, audio.ok ? undefined : await audio.text()).toBe(
					200,
				);
				expect(audio.headers.get("content-type")).toBe("audio/wav");
			}
			expect(h.spoken).toEqual(sentences);
			expect(
				service
					.listTasks(CONVERSATION_DEFAULT_PRINCIPAL, "main")
					.map(({ state, tabRef }) => ({ state, tabRef })),
			).toEqual([
				{ state: "completed", tabRef: originalTab },
				{ state: "completed", tabRef: fromConversation ? null : originalTab },
			]);
			expect(model.state.cancelled).toHaveLength(1);
		} finally {
			await h.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
	20_000,
);
