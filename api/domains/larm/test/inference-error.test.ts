import { expect, test } from "bun:test";
import { providerError } from "../service/inference-error";
const signal = () => new AbortController().signal;
test("provider diagnostics retain the code and meaningful message, redact credentials and bound input", async () => {
	const details = await providerError(
		Response.json({
			error: {
				code: "connection_idle_released",
				message: "provider bearer token belongs to an idle-released connection",
			},
			credential: "control",
		}),
		signal(),
		["control"],
	);
	expect(details).toEqual({
		errorCode: "connection_idle_released",
		errorMessage:
			"provider bearer token belongs to an idle-released connection",
	});
	const redacted = await providerError(
		Response.json({
			error: {
				code: "oops",
				message:
					"control secret-llm-1 Bearer another-token\n" + "x".repeat(1000),
			},
		}),
		signal(),
		["control", "secret-llm-1"],
	);
	expect(redacted.errorMessage?.length).toBe(512);
	expect(redacted.errorMessage).not.toMatch(
		/control|secret-llm-1|another-token|\n/,
	);
	expect(
		await providerError(new Response("{" + "x".repeat(16384)), signal(), []),
	).toEqual({});
	expect(
		await providerError(new Response("invalid JSON"), signal(), []),
	).toEqual({});
});
test("cancelled error-body read cannot trigger recovery", async () => {
	const controller = new AbortController();
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true;
		},
	});
	const reading = providerError(new Response(body), controller.signal, []);
	controller.abort();
	expect(await reading).toEqual({});
	expect(cancelled).toBe(true);
});
