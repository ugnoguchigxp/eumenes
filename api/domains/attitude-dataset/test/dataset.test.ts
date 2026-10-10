import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createAttitudeDataset, migration, type Sample } from "..";
import { RURI_MODEL, emotionSchema, type Emotion } from "../../delivery";
import { groupSplit } from "../service/split";
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-attitude-"));
	const store = openStore(join(dir, "data.sqlite3"), [migration]);
	const service = createAttitudeDataset(store, dir);
	closers.push(async () => {
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { service, store };
}
function result(label: Emotion = "none") {
	return {
		model: RURI_MODEL,
		answers: {
			emotion: {
				type: "choice",
				choice: label,
				confidence: 0.9,
				answer_confidence: 0.9,
				logits: Object.fromEntries(
					emotionSchema.options.map((k) => [k, k === label ? 3 : 0]),
				),
				probabilities: Object.fromEntries(
					emotionSchema.options.map((k) => [k, k === label ? 0.9 : 0.02]),
				),
				calibration_label_status: "synthetic-provisional",
				calibrated: true,
			},
		},
		truncated: false,
		state_tokens_dropped: 0,
		routing: {
			input_mode: "A",
			revision: "encoder",
			head_revision: "head",
			calibration_revision: "calibration",
			precision: "dynamic-int8-encoder-fp32-head",
			execution_providers: ["CPUExecutionProvider"],
			inference_ms: 4,
		},
	};
}
const identity = (turn = "turn", conversation = "conversation") => ({
	conversationId: conversation,
	turnId: turn,
	granularity: "answer" as const,
	chunkOrder: null,
});
const args = (turn = "turn", text = "こんにちは。") => ({
	model: RURI_MODEL,
	text,
	identity: identity(turn),
	context: {
		answer: text,
		turns: [{ role: "user" as const, text: "日本語の発言" }],
	},
	signal: new AbortController().signal,
	collectionSignal: new AbortController().signal,
	judge: async () => result("warmth"),
});
const review = (s: Sample, label: Emotion = "none") => ({
	revision: s.revision,
	primary_label: label,
	acceptable_labels: [label],
	expression_transition: "initial",
	review_status: "reviewed",
	correction_reason: "人が対象テキストを確認",
	template_group_id: s.template_group_id,
	template_group_confirmed: true,
	coverage_tags: ["short"],
});
test("off by default; authentic unit reuses normal judgment, strips raw metadata, keeps human labels null and blind predictions hidden", async () => {
	const { service } = setup();
	let calls = 0;
	const a = {
		...args(),
		judge: async () => {
			calls++;
			return {
				...result("warmth"),
				credential: "secret",
				token: "secret",
				provider_response: "secret",
			};
		},
	};
	await service.decide(a);
	expect(service.status().successful).toBe(0);
	await service.setEnabled(true);
	const delivery = await service.decide(a);
	await service.drain();
	const id = service.list()[0]!.sample_id;
	const sample = service.get(id, false) as Sample;
	expect(sample.primary_label).toBeNull();
	expect(sample.acceptable_labels).toEqual([]);
	expect(sample.expression_transition).toBeNull();
	expect(sample.split).toBeNull();
	expect(sample.adopted).toBeNull();
	expect(sample.selected_delivery.source).toBe("ruri");
	expect(sample.user_utterance).toBe("日本語の発言");
	expect(sample.granularity).toBe("answer");
	expect(sample.chunk_order).toBeNull();
	expect(sample.previous_assistant_chunk).toBeNull();
	expect(sample.conversation_id).not.toBe(a.identity.conversationId);
	expect(sample.decision.calibration_status).toBe("synthetic-provisional");
	expect(sample.tts_start_delay_ms).toBeNull();
	expect(JSON.stringify(sample)).not.toContain("secret");
	const blind = service.get(id)!;
	expect(blind).not.toHaveProperty("decision");
	expect(blind).not.toHaveProperty("selected_delivery");
	expect(blind).not.toHaveProperty("criteria");
	service.adopt(a.identity, delivery);
	await service.drain();
	expect((service.get(id, false) as Sample).adopted?.source).toBe("ruri");
	expect((service.get(id, false) as Sample).adopted?.tone).toBeNull();
	service.adopt(a.identity, delivery, {
		tone: "bright",
		application: "preset",
	});
	await service.drain();
	expect((service.get(id, false) as Sample).adopted?.tone).toBe("bright");
	await service.decide(a);
	await service.drain();
	expect(calls).toBe(3);
	expect(service.status().successful).toBe(1);
	await service.setEnabled(false);
	await service.setEnabled(true);
	await service.decide(a);
	await service.drain();
	expect(service.status().successful).toBe(1);
});
test("every technical reply uses the same single full-six judgment and records normal adoption", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	let calls = 0;
	let criteria: object = {};
	const a = {
		...args("technical", "設定を開いて保存してください。"),
		judge: async (_state: unknown, q: any) => {
			calls++;
			criteria = q.emotion.criteria;
			return result("none");
		},
	};
	const delivery = await service.decide(a);
	expect(delivery.source).toBe("ruri");
	expect(calls).toBe(1);
	expect(Object.keys(criteria)).toEqual(emotionSchema.options);
	await service.drain();
	const sample = service.get(service.list()[0]!.sample_id, false) as Sample;
	expect(sample.collection_only).toBe(false);
	expect(sample.decision.api_label).toBe("none");
	expect(service.status().skipped).toBe(0);
	await service.decide(a);
	await service.drain();
	expect(calls).toBe(2);
	expect(service.status().successful).toBe(1);
});
test("stop, cancellation and restart reject collection late responses; no second call after normal failure", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	let complete!: (v: unknown) => void;
	await service.decide({
		...args("stop", "手順を確認します。"),
		judge: async () =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	});
	await service.setEnabled(false);
	complete(result());
	await service.drain();
	expect(service.status().successful).toBe(0);
	await service.setEnabled(true);
	let calls = 0;
	await service.decide({
		...args("failure"),
		judge: async () => {
			calls++;
			throw new Error("secret provider failure");
		},
	});
	await service.drain();
	expect(calls).toBe(1);
	expect(service.status().successful).toBe(0);
	await service.recover();
	expect(service.status().enabled).toBe(false);
	expect(service.status().pending).toBe(0);
});
test("non-ruri, malformed, timeout, probes and missing identity never count as successful real Ruri units", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	await service.decide({
		...args("laya"),
		model: "laya-multilingual",
		judge: async () => ({ ...result(), model: "laya-multilingual" }),
	});
	await service.decide({
		...args("bad"),
		judge: async () => ({ model: RURI_MODEL }),
	});
	await service.decide({ ...args("probe"), identity: undefined });
	await service.decide({
		...args("timeout"),
		budgetMs: 1,
		judge: async () => new Promise(() => {}),
	});
	await service.drain();
	expect(service.status().successful).toBe(0);
	expect(service.status().pending).toBe(0);
});
test("review is validated and optimistic, original prediction survives correction; export only reviewed split examples", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	await service.decide(args());
	await service.drain();
	const id = service.list()[0]!.sample_id;
	let s = service.get(id, false) as Sample;
	await expect(
		service.review(id, { ...review(s), acceptable_labels: [] }),
	).rejects.toThrow("invalid_review");
	await service.review(id, review(s, "none"));
	s = service.get(id, false) as Sample;
	expect(s.decision.top_label).toBe("warmth");
	expect(s.primary_label).toBe("none");
	await expect(
		service.review(id, { ...review(s), revision: 0 }),
	).rejects.toThrow("revision_conflict");
	expect(() => service.export()).toThrow("invalid_split_required");
	await service.split();
	const exported = service.export();
	expect(exported.jsonl.trim().split("\n")).toHaveLength(1);
	expect(exported.report.differences).toHaveLength(1);
	expect(exported.schema.required.sort()).toEqual(Object.keys(s).sort());
	await service.review(id, {
		...review(s),
		review_status: "held",
		primary_label: null,
		acceptable_labels: [],
	});
	expect(service.export().jsonl).toBe("");
	expect(service.report().held).toBe(1);
});
test("connected conversations/templates including unreviewed bridges never leak across splits", () => {
	const sample = (
		id: string,
		c: string,
		t: string,
		status: Sample["review_status"] = "reviewed",
	) =>
		({
			sample_id: id,
			conversation_id: c,
			template_group_id: t,
			automatic_template_group_id: id,
			review_status: status,
			current_chunk: id,
		}) as Sample;
	const data = [
		sample("1", "c1", "t1"),
		sample("2", "c1", "t2", "unreviewed"),
		sample("3", "c2", "t2"),
		...Array.from({ length: 8 }, (_, i) =>
			sample(String(i + 4), `c${i + 3}`, `t${i + 3}`),
		),
	];
	const split = groupSplit(data);
	expect(split.assigned.get("1")).toBe(split.assigned.get("3"));
	expect(split.assigned.has("2")).toBe(false);
	expect(split.counts).toEqual({ train: 6, calibration: 2, eval: 2 });
	expect(groupSplit(data)).toEqual(split);
});
test("three independent reviewed groups always reserve calibration and eval without splitting a conversation", () => {
	const data = Array.from(
		{ length: 300 },
		(_, i) =>
			({
				sample_id: String(i),
				conversation_id: `c${Math.floor(i / 100)}`,
				template_group_id: `t${i}`,
				automatic_template_group_id: `t${i}`,
				current_chunk: String(i),
				review_status: "reviewed",
			}) as Sample,
	);
	const split = groupSplit(data);
	expect(split.counts).toEqual({ train: 100, calibration: 100, eval: 100 });
	for (let start = 0; start < 300; start += 100)
		expect(
			new Set(
				data
					.slice(start, start + 100)
					.map((s) => split.assigned.get(s.sample_id)),
			).size,
		).toBe(1);
	expect(groupSplit(data)).toEqual(split);
});

test("duplicate coverage tags cannot inflate reviewed coverage", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	await service.decide(args());
	await service.drain();
	const sample = service.get(service.list()[0]!.sample_id, false) as Sample;
	await expect(
		service.review(sample.sample_id, {
			...review(sample),
			coverage_tags: ["technical", "technical"],
		}),
	).rejects.toThrow("invalid_review");
	expect(service.report().coverage.technical).toBe(0);
	expect(service.get(sample.sample_id, false)?.revision).toBe(0);
});

test("300 successful distinct units stops collection; repetitions and synthetic/probe identities cannot inflate count", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	for (let i = 0; i < 301; i++) {
		await service.decide(args(`turn-${i}`));
		await service.drain();
	}
	expect(service.status()).toMatchObject({
		successful: 300,
		unreviewed: 300,
		reviewed: 0,
		enabled: false,
	});
	await expect(service.setEnabled(true)).rejects.toThrow(
		"invalid_collection_target_reached",
	);
});

test("credential-looking text is excluded, not partially copied; new examples invalidate old split assignments", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	await service.decide({
		...args("secret"),
		context: {
			answer: "こんにちは。",
			turns: [{ role: "user", text: "token=secret-do-not-store" }],
		},
	});
	await service.drain();
	expect(service.status().successful).toBe(0);
	expect(service.status().skip_reasons["skip:sensitive-text"]).toBe(1);
	await service.decide(args("safe"));
	await service.drain();
	const id = service.list()[0]!.sample_id;
	const sample = service.get(id, false) as Sample;
	await expect(
		service.review(id, { ...review(sample), review_status: "unreviewed" }),
	).rejects.toThrow("invalid_review");
	await service.review(id, review(sample));
	await service.split();
	expect(service.export().partitions.train).toContain(id);
	await service.decide(args("safe2", "ありがとうございます。"));
	await service.drain();
	expect(() => service.export()).toThrow("invalid_split_required");
});

test("available judge is called once even when cached model identity is absent", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	let calls = 0,
		prepares = 0;
	const delivery = await service.decide({
		...args("cold", "操作手順です。"),
		model: null,
		prepareJudge: async () => {
			prepares++;
			return RURI_MODEL;
		},
		judge: async () => {
			calls++;
			return result();
		},
	});
	expect(delivery.source).toBe("ruri");
	await service.drain();
	expect(calls).toBe(1);
	expect(prepares).toBe(0);
	expect(service.status().successful).toBe(1);
});
test("chunk collection sends only the current chunk, not a complete answer from its context", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	let sent: Record<string, string> | undefined;
	const current = "操作手順です。";
	await service.decide({
		...args("chunk", current),
		identity: {
			...identity("chunk"),
			granularity: "chunk",
			chunkOrder: 1,
			previousAssistantChunk: "合格おめでとうございます！",
		},
		context: {
			answer: "合格おめでとうございます！操作手順です。未来の回答は渡さない。",
			turns: [{ role: "user", text: "申請の手順を教えて。" }],
		},
		judge: async (state) => {
			sent = state;
			return result();
		},
	});
	await service.drain();
	expect(sent?.current_chunk).toBe(current);
	expect(sent?.response).toBe(current);
	const sample = service.get(service.list()[0]!.sample_id, false) as Sample;
	expect(sample.granularity).toBe("chunk");
	expect(sample.current_chunk).toBe(current);
	expect(sample.sent_current_text).toBe(current);
	expect(sample.previous_assistant_chunk).toBe("合格おめでとうございます！");
	expect(sample.chunk_order).toBe(1);
});

test("human review cannot introduce credential-looking text into the dataset or export", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	await service.decide(args());
	await service.drain();
	const id = service.list()[0]!.sample_id;
	const sample = service.get(id, false) as Sample;
	for (const fields of [
		{ correction_reason: "token=fixture-do-not-store" },
		{ template_group_id: "Bearer fixture-do-not-store" },
	]) {
		await expect(
			service.review(id, { ...review(sample), ...fields }),
		).rejects.toThrow("invalid_review_sensitive_text");
	}
	expect((service.get(id, false) as Sample).revision).toBe(0);
	expect(service.status().unreviewed).toBe(1);
	expect(service.export().jsonl).toBe("");
});

test("six malformed Ruri scores do not count toward the 300 successful judgments", async () => {
	const { service } = setup();
	await service.setEnabled(true);
	const r = result("warmth");
	const selected = await service.decide({
		...args(),
		judge: async () => ({
			...r,
			answers: {
				emotion: {
					...r.answers.emotion,
					probabilities: Object.fromEntries(
						emotionSchema.options.map((k) => [k, 0.9]),
					),
				},
			},
		}),
	});
	await service.drain();
	expect(selected).toMatchObject({
		source: "fallback",
		reason: "invalid",
		model: RURI_MODEL,
	});
	expect(service.status()).toMatchObject({ successful: 0, failed: 1 });
});
