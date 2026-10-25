import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { request, type RequestOptions } from "node:https";
import { resolveSafeOutboundUrl } from "llm-fetch";
import { createPublicHttpsTransport, publicHttpsPost } from "../src/webhook";
function fixture(
	addresses: Array<{ address: string; family: 4 | 6 }>,
	status = 200,
	body = "ok",
) {
	const calls: Array<{ url: URL; options: RequestOptions }> = [];
	const transport = createPublicHttpsTransport({
		resolve: (raw) => resolveSafeOutboundUrl(raw, async () => addresses),
		request: ((
			url: URL,
			options: RequestOptions,
			callback: (
				res: EventEmitter & {
					statusCode: number;
					headers: Record<string, string>;
				},
			) => void,
		) => {
			calls.push({ url, options });
			const req = Object.assign(new EventEmitter(), {
				end() {
					queueMicrotask(() => {
						const response = Object.assign(new EventEmitter(), {
							statusCode: status,
							headers: { location: "https://127.0.0.1/secret" },
						});
						callback(response);
						response.emit("data", Buffer.from(body));
						response.emit("end");
					});
				},
				destroy(error: Error) {
					req.emit("error", error);
				},
			});
			return req;
		}) as unknown as typeof request,
	});
	return { transport, calls };
}
test("production webhook rejects private targets, credentials, fragments and mixed DNS before opening a socket", async () => {
	for (const url of [
		"http://receiver.example",
		"https://user:pass@receiver.example",
		"https://receiver.example/#fragment",
		"https://127.0.0.1/",
		"https://[::1]/",
		"https://169.254.169.254/",
	]) {
		await expect(
			publicHttpsPost(url, "", {}, AbortSignal.timeout(1000)),
		).rejects.toBeTruthy();
	}
	const f = fixture([
		{ address: "8.8.8.8", family: 4 },
		{ address: "127.0.0.1", family: 4 },
	]);
	await expect(
		f.transport.post(
			"https://receiver.example/",
			"",
			{},
			AbortSignal.timeout(1000),
		),
	).rejects.toBeTruthy();
	expect(f.calls).toHaveLength(0);
});
test("TLS keeps the validated hostname while lookup pins the checked IP, and redirects are never followed", async () => {
	const f = fixture([{ address: "8.8.8.8", family: 4 }], 302);
	expect(
		(
			await f.transport.post(
				"https://receiver.example/",
				"本文",
				{},
				AbortSignal.timeout(1000),
			)
		).status,
	).toBe(302);
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]!.url.hostname).toBe("receiver.example");
	expect(f.calls[0]!.options.headers).toMatchObject({ "Content-Length": "6" });
	const lookup = f.calls[0]!.options.lookup!;
	const one = await new Promise((resolve) =>
		lookup("rebound.example", {}, (err, address, family) =>
			resolve([err, address, family]),
		),
	);
	expect(one).toEqual([null, "8.8.8.8", 4]);
	const all = await new Promise((resolve) =>
		lookup("rebound.example", { all: true }, (err, addresses) =>
			resolve([err, addresses]),
		),
	);
	expect(all).toEqual([null, [{ address: "8.8.8.8", family: 4 }]]);
});
test("an oversized callback body fails within the production limit", async () => {
	const f = fixture([{ address: "8.8.8.8", family: 4 }], 200, "a".repeat(4097));
	await expect(
		f.transport.post(
			"https://receiver.example/",
			"",
			{},
			AbortSignal.timeout(1000),
		),
	).rejects.toThrow("callback_response_too_large");
});
