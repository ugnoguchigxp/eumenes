import { expect, spyOn, test } from "bun:test";
import { fixture, makeLarm, freshSignal, result } from "./larm.fixture";

test("a failed readiness check retires only the previously cached target binding", async () => {
	const fake = fixture();
	let failed = false,
		skew = 0;
	const realNow = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
	const port = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			failed &&
			init?.method === "GET" &&
			new URL(String(input)).pathname.endsWith("/connection1")
		) {
			const body = await response.json();
			body.status = "failed";
			body.providers.find((p: { name: string }) => p.name === "asr").readiness =
				"failed";
			return result(body);
		}
		return response;
	}, 1_800_000);
	try {
		await port.prepareVoice!(freshSignal());
		await port.speak("確認", freshSignal());
		failed = true;
		skew = 750_000;
		await expect(port.prepareVoice!(freshSignal())).rejects.toThrow(
			"larm_provider_failed",
		);
		expect(port.status().capabilities).not.toContain("asr");
		expect(port.status().capabilities).toContain("tts");
		expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	} finally {
		clock.mockRestore();
		await port.close();
	}
});

test("late failed readiness cannot invalidate a newer recovered target claim", async () => {
	const fake = fixture();
	const entered = Promise.withResolvers<void>(),
		resume = Promise.withResolvers<void>();
	let check = false,
		held = false,
		skew = 0;
	const realNow = Date.now.bind(Date);
	const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
	const port = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			check &&
			!held &&
			init?.method === "GET" &&
			new URL(String(input)).pathname.endsWith("/connection1")
		) {
			held = true;
			const body = await response.json();
			body.providers.find((p: { name: string }) => p.name === "asr").readiness =
				"failed";
			entered.resolve();
			await resume.promise;
			return result(body);
		}
		return response;
	}, 1_800_000);
	try {
		await port.prepareVoice!(freshSignal());
		check = true;
		skew = 750_000;
		const failed = port.prepareVoice!(freshSignal()).catch((error) => error);
		await entered.promise;
		await port.prepareVoice!(freshSignal());
		resume.resolve();
		await failed;
		expect(port.status().capabilities).toContain("asr");
		expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	} finally {
		resume.resolve();
		clock.mockRestore();
		await port.close();
	}
});
