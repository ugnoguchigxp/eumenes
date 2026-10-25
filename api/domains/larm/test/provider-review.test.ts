import { expect, jest, test } from "bun:test";
import { fixture, freshSignal, makeLarm, result } from "./larm.fixture";

const flush = async () => {
	for (let i = 0; i < 20; i++)
		await new Promise((resolve) => setImmediate(resolve));
};

test("voice-only preparation reports connecting, its own failure and recovery", async () => {
	const fake = fixture();
	const entered = Promise.withResolvers<void>(),
		resume = Promise.withResolvers<void>();
	let fail = true;
	const port = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (new URL(String(input)).pathname.endsWith("/claim") && fail) {
			entered.resolve();
			await resume.promise;
			return result({ error: "unavailable" }, 503);
		}
		return response;
	});
	try {
		const preparing = port.prepareVoice!(freshSignal());
		const outcome = preparing.catch((error) => error);
		await entered.promise;
		expect(port.status().state).toBe("connecting");
		resume.resolve();
		await outcome;
		expect(port.status().state).toBe("failed");
		fail = false;
		await port.prepareVoice!(freshSignal());
		expect(port.status().state).toBe("ready");
	} finally {
		resume.resolve();
		await port.close();
	}
});

test("a failed ASR claim leaves ready TTS reported as available", async () => {
	const fake = fixture();
	const port = makeLarm(async (input, init) => {
		if (
			new URL(String(input)).pathname.endsWith("/claim") &&
			JSON.parse(String(init?.body)).providers?.includes("asr")
		)
			return result({}, 503);
		return fake.fetcher(input, init);
	});
	try {
		await port.speak("確認", freshSignal());
		await expect(port.prepareVoice!(freshSignal())).rejects.toThrow(
			"larm_control_503",
		);
		expect(port.status()).toMatchObject({
			state: "ready",
			capabilities: ["tts"],
		});
	} finally {
		await port.close();
	}
});

test("hiding after a failed main attempt stops every visible-screen retention loop", async () => {
	jest.useFakeTimers();
	const fake = fixture();
	const requests: string[] = [];
	const port = makeLarm(async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/v1/agent-connections" && init?.method === "POST") {
			const main = !!JSON.parse(String(init.body)).providers;
			requests.push(main ? "llm" : "voice");
			if (main) return result({}, 503);
		}
		return fake.fetcher(input, init);
	});
	try {
		port.retain!(true);
		await flush();
		await port.prepareVoice!(freshSignal());
		port.retain!(false);
		await flush();
		const before = requests.length;
		jest.advanceTimersByTime(30_000);
		await flush();
		expect(requests).toHaveLength(before);
	} finally {
		jest.useRealTimers();
		await port.close();
	}
});

test("closed ports reject first voice use without acquiring a new scope", async () => {
	const fake = fixture();
	const port = makeLarm(fake.fetcher);
	await port.close();
	const before = fake.calls.length;
	await expect(
		Promise.resolve().then(() => port.prepareVoice!(freshSignal())),
	).rejects.toThrow("larm_closed");
	await flush();
	expect(fake.calls).toHaveLength(before);
});

test("an expiring ASR credential never retires a Connection still used by TTS", async () => {
	const fake = fixture();
	const port = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (
			new URL(String(input)).pathname.endsWith("/claim") &&
			JSON.parse(String(init?.body)).providers?.includes("asr")
		) {
			const body = await response.json();
			body.expiresAt = new Date(Date.now() + 1000).toISOString();
			return result(body);
		}
		return response;
	});
	try {
		await port.speak("確認", freshSignal());
		await expect(port.prepareVoice!(freshSignal())).rejects.toThrow(
			"larm_credential_expired",
		);
		expect(port.status().capabilities).toContain("tts");
		expect(fake.requests).toHaveLength(1);
		expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	} finally {
		await port.close();
	}
});

test("a failed competing claim cannot remove a newer successful claim", async () => {
	const fake = fixture();
	const entered = Promise.withResolvers<void>(),
		resume = Promise.withResolvers<void>();
	let claims = 0;
	const port = makeLarm(async (input, init) => {
		if (new URL(String(input)).pathname.endsWith("/claim") && ++claims === 1) {
			entered.resolve();
			await resume.promise;
			return result({}, 503);
		}
		return fake.fetcher(input, init);
	});
	try {
		const first = port.prepareVoice!(freshSignal()).catch((error) => error);
		await entered.promise;
		await port.prepareVoice!(freshSignal());
		resume.resolve();
		await first;
		expect(port.status().capabilities).toContain("asr");
	} finally {
		resume.resolve();
		await port.close();
	}
});

test.each(["probing", "failed", undefined])(
	"a partial claim must confirm its selected set ready (%s)",
	async (status) => {
		const fake = fixture();
		const port = makeLarm(async (input, init) => {
			const response = await fake.fetcher(input, init);
			if (
				new URL(String(input)).pathname.endsWith("/claim") &&
				JSON.parse(String(init?.body)).providers?.includes("asr")
			) {
				const body = await response.json();
				body.status = status;
				return result(body);
			}
			return response;
		});
		try {
			await port.speak("確認", freshSignal());
			await expect(port.prepareVoice!(freshSignal())).rejects.toThrow(
				"larm_invalid_claim",
			);
			expect(port.status().capabilities).toContain("tts");
			expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
		} finally {
			await port.close();
		}
	},
);

test("a different Connection's terminal GET never retires this port's speech", async () => {
	const fake = fixture();
	let wrong = false;
	const port = makeLarm(async (input, init) => {
		if (
			wrong &&
			init?.method === "GET" &&
			new URL(String(input)).pathname.endsWith("/connection1")
		)
			return result({ id: "foreign", status: "released" });
		return fake.fetcher(input, init);
	});
	try {
		await port.speak("確認", freshSignal());
		wrong = true;
		await expect(port.prepareVoice!(freshSignal())).rejects.toThrow(
			"larm_invalid_connection",
		);
		expect(port.status().capabilities).toContain("tts");
		expect(fake.requests).toHaveLength(1);
	} finally {
		await port.close();
	}
});

test("an audio Provider's idle release never deletes a parent still serving its sibling", async () => {
	const fake = fixture();
	let asr = 0;
	const port = makeLarm(async (input, init) => {
		if (
			new URL(String(input)).pathname.endsWith("/audio/transcriptions") &&
			asr++ === 0
		)
			return result({ error: { code: "connection_idle_released" } }, 409);
		return fake.fetcher(input, init);
	});
	try {
		await port.speak("確認", freshSignal());
		expect(await port.transcribe(new Uint8Array(44), freshSignal())).toBe(
			"こんにちは",
		);
		expect(port.status().capabilities).toContain("tts");
		expect(fake.requests).toHaveLength(1);
		expect(fake.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	} finally {
		await port.close();
	}
});

test("a throwing status subscriber does not block the remaining subscribers", async () => {
	const fake = fixture();
	const port = makeLarm(fake.fetcher);
	let calls = 0;
	port.onChange!(() => {
		throw new Error("subscriber_failed");
	});
	port.onChange!(() => {
		calls++;
	});
	try {
		await port.prepareVoice!(freshSignal());
		expect(calls).toBeGreaterThan(0);
	} finally {
		await port.close();
	}
});

test("malformed optional decision metadata never becomes a public model value", async () => {
	const fake = fixture(false, "test-profile", 900_000, "model-tts", true);
	const port = makeLarm(async (input, init) => {
		const response = await fake.fetcher(input, init);
		if (new URL(String(input)).pathname === "/v3/agent-profiles") {
			const body = await response.json();
			body.profiles[0].providers.find(
				(p: { name: string }) => p.name === "system-one",
			).model = { invalid: true };
			return result(body);
		}
		return response;
	});
	try {
		await port.prepareVoice!(freshSignal());
		expect(port.decisionModel?.()).toBeNull();
	} finally {
		await port.close();
	}
});

test("catalog-selected optional names do not inherit Object prototype bindings", async () => {
	const fake = fixture(
		false,
		"test-profile",
		900_000,
		"model-tts",
		false,
		true,
	);
	const port = makeLarm(async (input, init) => {
		const path = new URL(String(input)).pathname;
		if (path === "/v1/audio/voices")
			return result({
				default_voice: "fixture-voice",
				voices: [
					{ id: "fixture-voice", voice_presentation: "feminine" },
					{ id: "Rosie", voice_presentation: "feminine" },
				],
			});
		if (path === "/tts-english/v1/audio/speech") {
			const wav = new Uint8Array(44);
			wav.set(new TextEncoder().encode("RIFF"));
			wav.set(new TextEncoder().encode("WAVE"), 8);
			return new Response(wav);
		}
		const response = await fake.fetcher(input, init);
		if (
			path === "/v3/agent-profiles" ||
			(path.startsWith("/v1/agent-connections") && response.status !== 204)
		) {
			const body = await response.json();
			for (const providers of [
				body.providers,
				...(body.profiles ?? []).map(
					(p: { providers: unknown[] }) => p.providers,
				),
			]) {
				if (Array.isArray(providers))
					for (const p of providers)
						if (p.name === "tts-english") p.name = "constructor";
			}
			return result(body, response.status);
		}
		return response;
	});
	try {
		expect(
			(await port.speak("test", freshSignal(), { speechLanguage: "en" }))
				.length,
		).toBe(44);
	} finally {
		await port.close();
	}
});
