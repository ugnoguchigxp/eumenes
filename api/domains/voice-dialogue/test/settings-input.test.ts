import { expect, test } from "bun:test";
import {
	createSettingsVoiceFixture,
	ready,
	until,
	wav,
} from "./settings-voice.fixture";
const { setup } = createSettingsVoiceFixture();

const controlRequests = (h: Awaited<ReturnType<typeof setup>>) =>
	h.store.read((db) =>
		db
			.query(
				"SELECT COUNT(*) AS n FROM inference_requests WHERE mode='control'",
			)
			.get(),
	);

test("cancelling during ASR rejects the late transcript before dialogue or speech", async () => {
	let finish!: (value: string) => void;
	const h = await setup(undefined, {
		status: ready,
		transcribe: () =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => !!finish);
	await h.voice.cancel(id);
	finish("遅れて届いた文字起こし");
	await Bun.sleep(30);
	expect(h.voice.get(id)?.status).toBe("cancelled");
	expect(h.voice.get(id)?.text).toBeNull();
	expect(h.dialogue.list("main")).toHaveLength(0);
	expect(h.voice.takeAudio(id)).toBeNull();
});

test("a transcript is ready as heard, with no language or endpoint control", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "Hello, 今日の予定は？",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "input_ready");
	expect(h.voice.get(id)?.text).toBe("Hello, 今日の予定は？");
	expect(controlRequests(h)).toEqual({ n: 0 });
});

test("kana settles Japanese without a control call", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "今日の予定は？",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "input_ready");
	expect(controlRequests(h)).toEqual({ n: 0 });
});

test("a short transcript without kana is adopted as heard", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "了解",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status === "input_ready");
	expect(h.voice.get(id)?.text).toBe("了解");
});

for (const [settingsLanguages, expected] of [
	[["en", "ja"], "ja"],
	[["en", "ko"], "en"],
] as const)
	test(`ASR is fixed to ${expected} when ${settingsLanguages.join("+")} are allowed`, async () => {
		const languages: (string | undefined)[] = [];
		let accepted: string[] | undefined;
		const h = await setup(undefined, {
			status: ready,
			transcribe: async (_wav, _signal, options) => {
				languages.push(options?.asrLanguage);
				accepted = options?.asrAcceptedLanguages;
				return "";
			},
		});
		const value = h.settings.get();
		value.general.asrLanguages = [...settingsLanguages];
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: value.revision,
			settings: value,
			keys: [],
		});
		const session = crypto.randomUUID(),
			id = crypto.randomUUID();
		h.voice.start(session, 1);
		await h.voice.accept(session, 1, 1, id, wav());
		await until(() => h.voice.get(id)?.status === "completed");
		expect(languages).toEqual([expected]);
		expect(accepted).toEqual(
			settingsLanguages.flatMap((code) => [
				code,
				{ ja: "japanese", en: "english", ko: "korean" }[code],
			]),
		);
	});

test("empty final ASR creates no dialogue", async () => {
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => "",
	});
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() =>
		["completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
	);
	expect(h.voice.get(id)?.status, JSON.stringify(h.voice.get(id))).toBe(
		"completed",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("ASR permission revocation after staging rejects commit", async () => {
	const h = await setup();
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)!.status === "input_ready");
	const value = h.settings.get();
	value.routes.asr.cloudAllowed = false;
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: value.revision,
		settings: value,
		keys: [],
	});
	await expect(h.voice.commit(id, h.voice.get(id)!.revision)).rejects.toThrow(
		"permission_revoked",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("an answered input forms a boundary: the next segment starts a new input", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => ["人口を教えて", "ありがとう"][count++]!,
		answer: async () => "人口の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		ids = [crypto.randomUUID(), crypto.randomUUID()];
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, ids[0]!, wav());
	await until(() => h.voice.get(ids[0]!)!.status === "input_ready");
	await h.voice.commit(ids[0]!, h.voice.get(ids[0]!)!.revision);
	await until(() => h.voice.get(ids[0]!)!.status === "ready");
	await h.voice.accept(session, 1, 2, ids[1]!, wav());
	await until(() => h.voice.get(ids[1]!)!.status === "input_ready");
	expect(h.voice.get(ids[1]!)!.text).toBe("ありがとう");
});

test("segments sent before commit merge into one input and create one answer", async () => {
	const fragments = [
		"じゃあ今日は。",
		"イラン側の。",
		"最新のニュースを教えてください。",
	];
	let recognized = 0,
		answers = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => fragments[recognized++]!,
		answer: async () => {
			answers++;
			return "まとめた依頼への回答です。";
		},
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		ids = fragments.map(() => crypto.randomUUID());
	h.voice.start(session, 1);
	for (let i = 0; i < ids.length; i++) {
		await h.voice.accept(session, 1, i + 1, ids[i]!, wav());
		await until(() => h.voice.get(ids[i]!)!.status === "input_ready");
		expect(h.dialogue.list("main")).toHaveLength(0);
	}
	const final = h.voice.get(ids[2]!)!;
	expect(final.text).toBe(fragments.join("\n"));
	expect(h.voice.get(ids[0]!)!.status).toBe("merged");
	expect(h.voice.get(ids[1]!)!.status).toBe("merged");
	await h.voice.commit(ids[2]!, final.revision);
	await h.voice.commit(ids[2]!, final.revision);
	await until(() => h.voice.get(ids[2]!)!.status === "ready");
	expect(answers).toBe(1);
	expect(controlRequests(h)).toEqual({ n: 0 });
	expect(h.dialogue.list("main")).toHaveLength(1);
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		fragments.join("\n"),
		"まとめた依頼への回答です。",
	]);
});

test("an empty segment after a pause carries the pending input forward", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => ["天気を教えて", ""][count++]!,
		answer: async () => "天気の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(first)!.status).toBe("merged");
	expect(h.voice.get(second)!.text).toBe("天気を教えて");
	await h.voice.commit(second, h.voice.get(second)!.revision);
	await until(() => h.voice.get(second)!.status === "ready");
	expect(h.conversation.get("main").messages[0]!.text).toBe("天気を教えて");
});

test("a failed segment after a pause fails alone and never answers the pending input", async () => {
	let count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () => {
			if (count++ === 0) return "天気を教えて";
			throw new Error("larm_timeout");
		},
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => h.voice.get(second)!.status === "failed");
	expect(h.voice.get(first)!.status).toBe("input_ready");
	expect(h.dialogue.list("main")).toHaveLength(0);
});

test("a later accepted fragment blocks an older ready input, including while its ASR is delayed", async () => {
	let release!: () => void,
		count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () =>
			++count === 1
				? "天気を教えて"
				: (await new Promise<void>((r) => {
						release = r;
					}),
					"明日の分も"),
		answer: async () => "天気の回答",
		speak: async () => wav(),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	const revision = h.voice.get(first)!.revision;
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => !!release);
	await expect(h.voice.commit(first, revision)).rejects.toThrow(
		"voice_input_stale",
	);
	expect(h.dialogue.list("main")).toHaveLength(0);
	release();
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(second)!.text).toBe("天気を教えて\n明日の分も");
});

test("a cancelled input is not merged into the next segment", async () => {
	let release!: () => void,
		count = 0;
	const h = await setup(undefined, {
		status: ready,
		transcribe: async () =>
			++count === 1
				? "ニュースの"
				: (await new Promise<void>((r) => {
						release = r;
					}),
					"続きです"),
	});
	const session = crypto.randomUUID(),
		first = crypto.randomUUID(),
		second = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, first, wav());
	await until(() => h.voice.get(first)!.status === "input_ready");
	await h.voice.accept(session, 1, 2, second, wav());
	await until(() => !!release);
	await h.voice.cancel(first);
	release();
	await until(() => h.voice.get(second)!.status === "input_ready");
	expect(h.voice.get(first)!.status).toBe("cancelled");
	expect(h.voice.get(second)!.text).toBe("続きです");
	expect(h.dialogue.list("main")).toHaveLength(0);
});
