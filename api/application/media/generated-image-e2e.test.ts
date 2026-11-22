import { expect, test } from "bun:test";
import sharp from "sharp";
import { harness } from "../toolchain/toolchain.fixture";
import { imageFixture, imageQuestion, png } from "./image.fixture";
import { imageLarmFixture } from "../../domains/larm/test/chat-input.fixture";
import {
	choiceByScript,
	choiceRound,
} from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { createAgencyStatePort } from "../../domains/dialogue";
import {
	archiveWork,
	dropRunResults,
	insertWork,
	updateWork,
} from "../../domains/dialogue/test/store.fixture";

const observation = "左上の画素は RGB 235, 130, 110。";
const followUp = "受け取った画像の特徴は？";

for (const scenario of [
	"observed",
	"replaced",
	"unsupported",
	"withdrawn",
] as const)
	test(`generated image delivery and native inference input: ${scenario}`, async () => {
		const imageGate = Promise.withResolvers<void>();
		const f = imageFixture(
			"success",
			scenario === "observed" ? imageGate.promise : undefined,
		);
		const gate = Promise.withResolvers<void>();
		const transport = imageLarmFixture({
			response: observation,
			vision: scenario !== "unsupported",
			generationGate: scenario === "withdrawn" ? gate.promise : undefined,
		});
		let followUpContext = "";
		let observedModelCalls = 0;
		const state = createAgencyStatePort({ now: Date.now });
		const h = await harness({
			resources: true,
			memory: scenario === "observed",
			agency: {
				isCurrentInputInTransaction(db, input) {
					return (
						(h.memory?.referenceInputs.isCurrentInTransaction(db, input) ??
							true) &&
						!state.staleSourcesInTransaction(db, input.sources).length
					);
				},
				workChangedInTransaction() {},
			},
			observeGeneratedImages: true,
			imageGateway: () => {
				const gateway = f.gateway();
				if (scenario !== "replaced") return gateway;
				return {
					...gateway,
					images: {
						...gateway.images,
						async get(id, signal) {
							const result = await gateway.images.get(id, signal);
							const entry = f.images.get(id);
							if (entry) entry.bytes = png(43, 31);
							return result;
						},
					},
				};
			},
			model: {
				...transport.p,
				answerStream: undefined,
				async answer(messages, signal, options) {
					if (messages.some((message) => message.images?.length)) {
						observedModelCalls++;
						return transport.p.answer(messages, signal, options);
					}
					if (messages.some((message) => message.content.includes(followUp))) {
						const round = options?.jsonSchema ? choiceRound(messages) : null;
						if (round)
							return choiceByScript(messages, round, () => ({
								text: observation,
							}));
						followUpContext = messages.map(({ content }) => content).join("\n");
						return observation;
					}
					return f.model.answer(messages, signal, options);
				},
			},
		});
		try {
			const request = {
				requestId: crypto.randomUUID(),
				conversationId: "media-origin",
				text: imageQuestion,
				presentation: "artifact",
				...(scenario === "observed" ? {} : { toolchainId: "image.create" }),
			};
			const priorRunId = crypto.randomUUID();
			const priorWork =
				scenario === "observed"
					? await h.store.write((db) => {
							h.memory!.referenceInputs.recordRunInTransaction(db, priorRunId, {
								sources: [],
								complete: true,
							});
							return insertWork(db, {
								id: crypto.randomUUID(),
								conversationId: request.conversationId,
								runId: priorRunId,
								toolchainId: "web.note",
								toolchainRevisionId: "toolchain:web.note@1",
								execution: "queued",
								request: "天気を調べて",
								title: "天気",
								sourceRef: null,
								dedupeKey: priorRunId,
								createdAt: new Date().toISOString(),
								messageIds: [],
							});
						})
					: undefined;
			const submission = await h.request("/api/runs", request);
			expect(submission.status).toBe(202);
			const { id, inputMessageId } = await submission.json();
			expect((await (await h.request("/api/runs", request)).json()).id).toBe(
				id,
			);
			if (priorWork) {
				await waitFor(() =>
					f.requests.some(
						({ method, path }) =>
							method === "POST" && path === "/v1/images/generations",
					),
				);
				const priorRef = `host-work:${JSON.stringify([priorWork.id, priorWork.revision])}`;
				await h.store.write((db) => {
					expect(
						h.memory!.referenceInputs.readRunInTransaction(db, id)?.sources,
					).toContain(priorRef);
					const at = new Date().toISOString();
					expect(
						updateWork(
							db,
							priorWork.id,
							priorWork.revision,
							{
								status: "done",
								outcome: "succeeded",
								result: { summary: "晴れ" },
							},
							at,
						),
					).toBe(true);
					expect(archiveWork(db, priorWork.id, at)).toBe(true);
				});
				imageGate.resolve();
			}
			expect(
				(await h.dialogue.waitForTerminal(id, { timeoutMs: 5000 }))?.status,
			).toBe("completed");
			const notices = async () =>
				(await (await h.request("/api/todo-notices")).json()).notices;
			if (scenario === "withdrawn") {
				await waitFor(() =>
					transport.requests.some(({ operation }) => operation === "generate"),
				);
				expect((await notices())[0]?.summary).toContain("画像を確認中");
				await h.conversation.retract({ messageId: inputMessageId });
				gate.resolve();
				await waitFor(
					() =>
						!["queued", "running"].includes(
							h.queue.list({ kind: "dialogue.generated-image" }).items[0]
								?.state ?? "queued",
						),
				);
				expect(JSON.stringify(await notices())).not.toContain(observation);
				expect(
					transport.requests.filter(
						({ operation }) => operation === "generate",
					),
				).toHaveLength(1);
				return;
			}
			const expected = {
				observed: "画像を確認済み",
				replaced: "原本を確認できません",
				unsupported: "画像入力を利用できません",
			}[scenario];
			await waitFor(
				async () =>
					(await notices()).some((item: { summary: string | null }) =>
						item.summary?.includes(expected),
					),
				{ timeout: 2500 },
			).catch(async (error) => {
				throw new Error(
					`${error.message}: model calls=${observedModelCalls}, wire calls=${transport.requests.length}, notices=${JSON.stringify(await notices())}`,
				);
			});
			const notice = (await notices()).find(
				(item: { summary: string | null }) => item.summary?.includes(expected),
			);
			expect(notice).toMatchObject({
				conversationId: request.conversationId,
				outcome: "succeeded",
				links: [{ kind: "image", uri: "eumenes://image/new-image" }],
			});
			expect(
				(await notices()).filter(
					(item: { conversationId: string }) =>
						item.conversationId === request.conversationId,
				),
			).toHaveLength(1);
			const history = await (
				await h.request(`/api/conversations/${request.conversationId}`)
			).json();
			expect(
				history.messages.filter(
					(item: { role: string }) => item.role === "user",
				),
			).toHaveLength(1);
			expect(JSON.stringify(history)).not.toContain(observation);
			const modelRequests = transport.requests.filter(
				({ operation }) => operation === "generate",
			);
			expect(observedModelCalls).toBe(scenario === "replaced" ? 0 : 1);
			expect(modelRequests).toHaveLength(scenario === "observed" ? 1 : 0);
			if (scenario !== "observed") return;
			const wire = JSON.parse(modelRequests[0]!.body);
			const parts = wire.messages.flatMap(
				({ content }: { content: unknown }) =>
					Array.isArray(content)
						? content.filter(({ type }) => type === "image_url")
						: [],
			);
			expect(parts).toHaveLength(1);
			const dataUrl: string = parts[0].image_url.url;
			expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
			const decoded = await sharp(Buffer.from(dataUrl.split(",")[1]!, "base64"))
				.raw()
				.toBuffer({ resolveWithObject: true });
			expect(decoded.info).toMatchObject({ width: 121, height: 177 });
			expect([...decoded.data.subarray(0, 3)]).toEqual([235, 130, 110]);
			const follow = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: request.conversationId,
					text: followUp,
				})
			).json();
			expect(
				(await h.dialogue.waitForTerminal(follow.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
			expect(followUpContext).toContain(observation);
			expect(observedModelCalls).toBe(1);
			await h.store.write((db) =>
				dropRunResults(db, priorRunId, new Date().toISOString()),
			);
			expect(JSON.stringify(await notices())).not.toContain(observation);
		} finally {
			imageGate.resolve();
			gate.resolve();
			await h.close();
		}
	});
