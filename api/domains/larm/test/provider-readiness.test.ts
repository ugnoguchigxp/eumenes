import { expect, test, spyOn } from "bun:test";
import { freshSignal, question } from "./larm.fixture";
import { independent } from "./provider-readiness.fixture";

test.each(["probing", "failed"])(
	"ready ASR and TTS run while Connection is %s and LLM is pending/failed",
	async (status) => {
		const f = independent();
		f.status(status);
		if (status === "failed") f.readiness.llm = "failed";
		try {
			await f.larm.prepareVoice!(freshSignal());
			expect(f.claims).toEqual([["asr"]]);
			expect(await f.larm.transcribe(new Uint8Array(44), freshSignal())).toBe(
				"こんにちは",
			);
			expect((await f.larm.speak("確認", freshSignal())).length).toBe(44);
			expect(f.claims).toEqual([["asr"], ["tts"]]);
			expect(f.deleted).toEqual([]);
		} finally {
			await f.larm.close();
		}
	},
);

test("audio acquisition neither waits for nor deletes the existing primary LLM scope", async () => {
	const f = independent();
	try {
		await f.larm.answer(question, freshSignal());
		await f.larm.transcribe(new Uint8Array(44), freshSignal());
		expect(f.scopes.size).toBe(2);
		expect(f.deleted).toEqual([]);
		expect(f.larm.status().capabilities).toContain("llm");
		expect(f.larm.status().capabilities).toContain("asr");
	} finally {
		await f.larm.close({ keepConnection: true });
	}
	expect(f.deleted).toEqual([]);
});

test("ASR failure and cancellation do not stop ready TTS or discard the buffered WAV", async () => {
	const f = independent();
	try {
		f.readiness.asr = "failed";
		await expect(
			f.larm.transcribe(new Uint8Array(44), freshSignal()),
		).rejects.toThrow("larm_provider_failed");
		expect((await f.larm.speak("確認", freshSignal())).length).toBe(44);
		f.readiness.asr = "probing";
		const cancel = new AbortController();
		const buffered = new Uint8Array(44);
		buffered[43] = 7;
		const work = f.larm.transcribe(buffered, cancel.signal);
		cancel.abort();
		await expect(work).rejects.toThrow();
		expect(buffered[43]).toBe(7);
		expect(f.deleted).toEqual([]);
	} finally {
		await f.larm.close();
	}
});

test("a stalled ASR has its own deadline while a concurrent TTS succeeds", async () => {
	const f = independent();
	f.readiness.asr = "probing";
	const abort = new AbortController();
	try {
		const asr = f.larm.transcribe(new Uint8Array(44), abort.signal);
		expect((await f.larm.speak("確認", freshSignal())).length).toBe(44);
		abort.abort(new DOMException("deadline", "TimeoutError"));
		await expect(asr).rejects.toThrow("deadline");
		expect(f.claims).toEqual([["tts"]]);
		expect(f.deleted).toEqual([]);
	} finally {
		await f.larm.close();
	}
});

test("released/expired stop only that Connection and never claim a terminal record", async () => {
	for (const state of ["released", "expired"]) {
		const f = independent();
		f.status(state);
		try {
			await expect(
				f.larm.transcribe(new Uint8Array(44), freshSignal()),
			).rejects.toThrow(`larm_connection_${state}`);
			expect(f.claims).toEqual([]);
		} finally {
			await f.larm.close();
		}
	}
});

test("credential reacquisition selects ASR alone while siblings remain unready", async () => {
	const f = independent();
	const now = Date.now.bind(Date);
	let skew = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => now() + skew);
	try {
		await f.larm.prepareVoice!(freshSignal());
		await f.larm.speak("確認", freshSignal());
		f.status("failed");
		f.readiness.tts = "probing";
		skew = 750_000;
		await f.larm.transcribe(new Uint8Array(44), freshSignal());
		expect(f.claims).toEqual([["asr"], ["tts"], ["asr"]]);
		f.readiness.tts = "ready";
		expect((await f.larm.speak("確認", freshSignal())).length).toBe(44);
		expect(f.claims).toEqual([["asr"], ["tts"], ["asr"], ["tts"]]);
		expect(f.deleted).toEqual([]);
	} finally {
		clock.mockRestore();
		await f.larm.close();
	}
});
