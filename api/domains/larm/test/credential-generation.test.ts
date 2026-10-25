import { expect, spyOn, test } from "bun:test";
import { fixture, makeLarm, freshSignal } from "./larm.fixture";

test("a claim delivered after a concurrent renew never adopts an older credential generation", async () => {
	const fake = fixture();
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let held = false,
		renewed = false;
	const realNow = Date.now.bind(Date);
	let skew = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
	const port = makeLarm(async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path.endsWith("/audio/speech") && renewed)
			expect(new Headers(init?.headers).get("Authorization")).toBe(
				"Bearer secret-tts-2",
			);
		const response = await fake.fetcher(input, init);
		if (path.endsWith("/renew")) renewed = true;
		if (
			path.endsWith("/claim") &&
			JSON.parse(String(init?.body)).providers?.includes("tts") &&
			!held
		) {
			held = true;
			entered.resolve();
			await release.promise;
		}
		return response;
	}, 1_800_000);
	try {
		await port.prepareVoice!(freshSignal());
		skew = 750_000;
		const speech = port.speak("確認", freshSignal());
		const outcome = speech.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		await entered.promise;
		await port.transcribe(new Uint8Array(44), freshSignal());
		release.resolve();
		expect(await outcome).toHaveProperty("value");
	} finally {
		release.resolve();
		clock.mockRestore();
		await port.close();
	}
});
