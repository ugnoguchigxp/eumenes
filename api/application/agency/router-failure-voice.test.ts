import { expect, test } from "bun:test";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaFixture, planNothing } from "./always-on.fixture";

test("a voice request reads a saved note and replies without starting work", async () => {
	const title = "コーディングエージェントのハーネス設計実証研究";
	const passage = "4つのモデルを使い、176の設定を比較しました。";
	const request = `では、${title}という項目を読み上げてみてください。`;
	const offered: string[][] = [];
	const modelInputs: Array<{
		question: string;
		system: string;
		results: string[];
	}> = [];
	let noteId: string;
	let planned = false;
	const f = await agendaFixture({
		script(kind) {
			if (kind !== "plan") return;
			if (planned) return planNothing();
			planned = true;
			return {
				add: [
					{
						kind: "research",
						text: "ハーネスの研究を調べる",
						refs: ["note-request"],
						value: 5,
						reason: "fixture",
						topic: "harness",
					},
				],
				drop: [],
				focus: "harness",
			};
		},
		webNote: {
			turn: async () => ({
				text: `題: ${title}\n要約: ハーネス構成を比較。\n---\n## ${title}\n${passage}`,
				searches: 1,
				usage: null,
			}),
		},
		dialogue: {
			voiceText: request,
			firstRound(tools, question, messages) {
				offered.push(tools.map((tool) => tool.function.name));
				const results = messages
					.filter((message) => message.role === "tool")
					.map((message) => message.content);
				modelInputs.push({ question, system: messages[0]!.content, results });
				if (!results.length) {
					return {
						calls: [{ name: "read_note", args: { id: noteId } }],
					};
				}
				return { text: passage };
			},
		},
	});
	try {
		await f.start();
		await f.host.attend("main");
		await f.user("note-request", "main", "ハーネスの研究を調べて");
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.inspect("main")!.snapshot.notes.length === 1;
		});
		noteId = f.host.inspect("main")!.snapshot.notes[0]!.id;
		const sessionId = crypto.randomUUID();
		const utteranceId = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		const { voice } = f.h;
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, utteranceId, wav);
		await waitFor(() => voice.get(utteranceId)?.status === "input_ready");
		await voice.commit(utteranceId, voice.get(utteranceId)!.revision);
		await waitFor(() => {
			const turn = voice.get(utteranceId);
			return turn?.audioComplete === true || turn?.status === "failed";
		});

		const turn = voice.get(utteranceId)!;
		expect(turn.error).toBeNull();
		expect(offered).toHaveLength(2);
		expect(offered[0]).toContain("read_note");
		expect(modelInputs[0]!.question).toBe(request);
		expect(modelInputs[1]!.results[0]).toContain(passage);
		expect(f.h.dialogue.answerText(turn.runId!)).toBe(passage);
		expect(f.h.spoken.join("")).toBe(passage);
		for (const chunk of turn.audioChunks) {
			expect(voice.takeAudio(utteranceId, chunk.index)?.byteLength).toBe(48);
			await voice.played(utteranceId, chunk.index);
		}
		expect(voice.get(utteranceId)?.status).toBe("played");
		expect(f.h.todos()).toEqual([]);
		expect(
			f.host
				.inspect("main")!
				.snapshot.agent.items.some((item) => item.text === "新規調査"),
		).toBe(false);
	} finally {
		await f.close();
	}
});

test("voice playback finishes when adoption removes a repeated tool preamble", async () => {
	const preamble = "実行の記録を確かめます。";
	const tail = "対象の実行は完了しました";
	const f = await agendaFixture({
		dialogue: {
			voiceText: "実行の結果を教えてください。",
			firstRound(tools, _question, messages) {
				if (messages.at(-1)?.role === "tool") return { text: preamble + tail };
				if (tools.some(({ function: tool }) => tool.name === "read_runs"))
					return {
						text: preamble,
						calls: [{ name: "read_runs", args: {} }],
					};
			},
		},
	});
	try {
		await f.start();
		await f.host.attend("main");
		const sessionId = crypto.randomUUID();
		const utteranceId = crypto.randomUUID();
		const wav = new Uint8Array(48);
		wav.set(new TextEncoder().encode("RIFF"));
		wav.set(new TextEncoder().encode("WAVE"), 8);
		const { voice, dialogue, spoken } = f.h;
		voice.start(sessionId, 1);
		await voice.accept(sessionId, 1, 1, utteranceId, wav);
		await waitFor(() => voice.get(utteranceId)?.status === "input_ready");
		await voice.commit(utteranceId, voice.get(utteranceId)!.revision);
		await waitFor(() => {
			const turn = voice.get(utteranceId);
			return turn?.status === "ready" || turn?.status === "failed";
		});

		const turn = voice.get(utteranceId)!;
		expect(dialogue.answerText(turn.runId!)).toBe(preamble + tail);
		expect(turn).toMatchObject({ status: "ready", error: null });
		expect(spoken).toEqual([preamble, preamble, tail]);
		for (const chunk of turn.audioChunks) {
			expect(voice.takeAudio(utteranceId, chunk.index)).toEqual(wav);
			await voice.played(utteranceId, chunk.index);
		}
		expect(voice.get(utteranceId)?.status).toBe("played");
	} finally {
		await f.close();
	}
});
