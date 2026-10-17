import { expect, test } from "bun:test";
import { gzipFetch } from "../service/gzip-fetch";
import type { Fetcher } from "../service/profiles";

type CompressionOptions = RequestInit & {
	compress?: boolean | string;
	decompress?: boolean;
};

test("JSON requests delegate gzip to Bun without changing the counted body or request contract", async () => {
	const body = JSON.stringify({
		messages: [{ role: "user", content: "確認" }],
	});
	const signal = AbortSignal.timeout(1000);
	const response = Response.json({ ok: true });
	const request = gzipFetch(async (url, init: CompressionOptions = {}) => {
		expect(String(url)).toBe("http://127.0.0.1/infer");
		expect(init.body).toBe(body);
		expect(init.compress).toBe("gzip");
		expect(init.decompress).toBe(true);
		expect(init.signal).toBe(signal);
		expect(init.redirect).toBe("error");
		const headers = new Headers(init.headers);
		expect(headers.get("Accept-Encoding")).toBe("gzip");
		expect(headers.get("Authorization")).toBe("Bearer fixture");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("Idempotency-Key")).toBe("one-operation");
		return response;
	});
	expect(
		await request("http://127.0.0.1/infer", {
			method: "POST",
			body,
			headers: [
				["Authorization", "Bearer fixture"],
				["Content-Type", "application/json"],
				["Idempotency-Key", "one-operation"],
			],
			signal,
			redirect: "error",
		}),
	).toBe(response);
});

test("ASR compresses a buffered multipart with a matching boundary and intact audio and fields", async () => {
	const audio = Uint8Array.from([0, 255, 128, 1, 13, 10]);
	const form = new FormData();
	form.append("model", "fixture-model");
	form.append("response_format", "json");
	form.append("file", new Blob([audio], { type: "audio/wav" }), "input.wav");
	await gzipFetch(async (_url, init: CompressionOptions = {}) => {
		expect(init.body).toBeInstanceOf(Blob);
		expect(init.compress).toBe("gzip");
		expect(await (init.body as Blob).text()).toContain(
			"Content-Type: audio/wav\r\n",
		);
		const headers = new Headers(init.headers);
		expect(headers.get("Content-Type")).toStartWith(
			"multipart/form-data; boundary=",
		);
		const decoded = await new Response(init.body, { headers }).formData();
		expect(decoded.get("model")).toBe("fixture-model");
		expect(decoded.get("response_format")).toBe("json");
		const file = decoded.get("file") as File;
		expect(file.name).toBe("input.wav");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
		return Response.json({ text: "確認" });
	})("http://127.0.0.1/asr", { method: "POST", body: form });
});

test("ordinary reads negotiate gzip while Range reads retain the stored representation", async () => {
	for (const range of [undefined, "bytes=0-1023"]) {
		await gzipFetch(async (_url, init: CompressionOptions = {}) => {
			expect(init.compress).toBe(false);
			expect(init.body).toBeUndefined();
			const headers = new Headers(init.headers);
			expect(headers.get("Accept-Encoding")).toBe(range ? "identity" : "gzip");
			expect(headers.get("Range")).toBe(range ?? null);
			return new Response(null, { status: range ? 206 : 204 });
		})("http://127.0.0.1/audio", {
			headers: range ? { Range: range } : {},
		});
	}
});

test("response streams pass through without buffering and the caller can cancel them", async () => {
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: first\n\n"));
		},
		cancel() {
			cancelled = true;
		},
	});
	const response = new Response(stream, {
		headers: { "Content-Type": "text/event-stream" },
	});
	const received = await gzipFetch(async () => response)(
		"http://127.0.0.1/sse",
	);
	expect(received).toBe(response);
	expect(received.bodyUsed).toBe(false);
	const reader = received.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe(
		"data: first\n\n",
	);
	await reader.cancel();
	expect(cancelled).toBe(true);
});

test("aborted requests never send and network failures never replay a generation", async () => {
	let calls = 0;
	const failure = new TypeError("fixture network failure");
	const request: Fetcher = async () => {
		calls++;
		throw failure;
	};
	const send = gzipFetch(request);
	await expect(
		send("http://127.0.0.1/generate", { signal: AbortSignal.abort() }),
	).rejects.toThrow();
	expect(calls).toBe(0);
	await expect(
		send("http://127.0.0.1/generate", { method: "POST", body: "{}" }),
	).rejects.toBe(failure);
	expect(calls).toBe(1);
});
