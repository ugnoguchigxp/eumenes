import { expect, test } from "bun:test";
import sharp from "sharp";
import { imageFixture, imageQuestion, png } from "./image.fixture";
import { imageLarmFixture } from "../../domains/larm/test/chat-input.fixture";
import {
	choiceByScript,
	choiceRound,
} from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { replyWith } from "../agency/always-on.fixture";
import {
	assignmentAgenda,
	ended,
	plannedBy,
	reportLine,
	resources,
	until,
	works,
	type Fixture,
} from "./assignment.fixture";

const observation = "左上の画素は RGB 235, 130, 110。";
const followUp = "受け取った画像の特徴は？";
const answered = "見ています。";

type Observation = {
	state: string;
	reason?: string;
	images: Array<{ uri: string }>;
};
/** What the model saw of the images the assignment made, kept under the assignment's work root. */
const observed = (a: Fixture): Array<Observation & { rootId: string }> =>
	a.h.store
		.read((db) =>
			db.query("SELECT root_id, record FROM dialogue_assignment_images").all(),
		)
		.map((row) => {
			const { root_id, record } = row as { root_id: string; record: string };
			return { rootId: root_id, ...JSON.parse(record) };
		});

for (const scenario of [
	"observed",
	"replaced",
	"unsupported",
	"withdrawn",
] as const)
	test(`generated image of the agent's own work and native inference input: ${scenario}`, async () => {
		const f = imageFixture("success");
		const gate = Promise.withResolvers<void>();
		const transport = imageLarmFixture({
			response: observation,
			vision: scenario !== "unsupported",
			generationGate: scenario === "withdrawn" ? gate.promise : undefined,
		});
		const planned = plannedBy({ image: f });
		const followUps: string[] = [];
		let observedModelCalls = 0;
		const a = await assignmentAgenda({
			media: f,
			harness: {
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
						if (
							messages.some((message) => message.content.includes(followUp))
						) {
							const round = options?.jsonSchema ? choiceRound(messages) : null;
							if (round)
								return choiceByScript(messages, round, () => ({
									text: answered,
								}));
							followUps.push(messages.map(({ content }) => content).join("\n"));
							return answered;
						}
						return planned.answer(messages, signal, options);
					},
				},
			},
		});
		const turn = async () => {
			const run = await (
				await a.h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "ao",
					text: followUp,
				})
			).json();
			expect(
				(await a.h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
		};
		const watched = () =>
			a.h.queue.list({ kind: "dialogue.generated-image" }).items[0];
		try {
			await a.start();
			// The user's words, and the preparation the reply asked of the agent (its own work, under its own root).
			await a.user("user-a", "ao", imageQuestion);
			await replyWith(
				a,
				[
					{
						name: "start_preparation",
						arguments: { request: imageQuestion, askedByUser: true },
					},
				],
				{ messageIds: ["user-a"] },
			);
			await until(a, () => ended(a));
			expect(a.h.image!.list("ao")[0]?.state).toBe("completed");
			// The agent reports the image, and the observation is not made until the conversation's next turn.
			await until(a, () => !!reportLine(a));
			expect((await resources(a)).resources.map((r) => r.kind)).toContain(
				"image",
			);
			expect(observed(a)).toEqual([]);
			expect(observedModelCalls).toBe(0);
			// The next turn takes the new image to be looked at once, keyed by the assignment's work root.
			await turn();
			expect(observed(a)).toMatchObject([
				{
					rootId: works(a)[0]!.root_id,
					images: [{ uri: "eumenes://image/new-image" }],
				},
			]);
			if (scenario === "withdrawn") {
				await waitFor(() =>
					transport.requests.some(({ operation }) => operation === "generate"),
				);
				// While it is looked at, the user takes their words back: the assignment is forgotten.
				await a.h.conversation.retract({ messageId: "user-a" });
				gate.resolve();
				await waitFor(
					() => !["queued", "running"].includes(watched()?.state ?? "queued"),
				);
				await turn();
				expect(followUps.at(-1)).not.toContain(observation);
				expect(followUps.at(-1)).not.toContain("画像を確認");
				expect(observed(a)).toEqual([]);
				expect(
					transport.requests.filter(
						({ operation }) => operation === "generate",
					),
				).toHaveLength(1);
				return;
			}
			await waitFor(
				() => !["queued", "running"].includes(watched()?.state ?? "queued"),
			);
			await turn();
			const expected = {
				observed: "画像を確認済み",
				replaced: "原本を確認できません",
				unsupported: "現在の接続では画像入力を利用できません",
			}[scenario];
			expect(followUps.at(-1)).toContain(expected);
			const history = await (await a.h.request("/api/conversations/ao")).json();
			expect(JSON.stringify(history)).not.toContain(observation);
			const modelRequests = transport.requests.filter(
				({ operation }) => operation === "generate",
			);
			expect(observedModelCalls).toBe(scenario === "replaced" ? 0 : 1);
			expect(modelRequests).toHaveLength(scenario === "observed" ? 1 : 0);
			if (scenario !== "observed") return;
			expect(observed(a)[0]).toMatchObject({ state: "observed" });
			expect(followUps.at(-1)).toContain(observation);
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
			expect(observedModelCalls).toBe(1);
			// The observation was made once: the third turn reads it again, and the model is not called again.
			await turn();
			expect(followUps.at(-1)).toContain(observation);
			expect(observedModelCalls).toBe(1);
		} finally {
			gate.resolve();
			await a.close();
		}
	}, 30_000);
