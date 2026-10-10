import { describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
	isNetworkError,
	isTransientStoreError,
	toErrorCode,
} from "./error-code";
import { WriterBusyError } from "./sqlite";

async function thrown(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
	} catch (error) {
		return error;
	}
	throw new Error("expected_throw");
}

function listen(
	onConnection: (socket: Socket) => void,
): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((socket) => {
			socket.on("error", () => undefined);
			onConnection(socket);
		});
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, url: `http://127.0.0.1:${port}/` });
		});
	});
}

describe("toErrorCode", () => {
	test("keeps machine-readable codes and collapses free text", () => {
		expect(toErrorCode(new Error("larm_inference_401"), "x")).toBe(
			"larm_inference_401",
		);
		expect(
			toErrorCode(
				new Error("connect ECONNREFUSED 192.168.0.2:9810"),
				"voice_failed",
			),
		).toBe("voice_failed");
		expect(
			toErrorCode(
				new Error("UNIQUE constraint failed: voice_turns.id"),
				"voice_failed",
			),
		).toBe("voice_failed");
		expect(toErrorCode("plain_code", "x")).toBe("plain_code");
		expect(toErrorCode(42, "x")).toBe("x");
	});
});

describe("isTransientStoreError", () => {
	test("detects busy writer, shutdown and SQLite locks", () => {
		expect(isTransientStoreError(new Error("database_closing"))).toBe(true);
		expect(isTransientStoreError(new WriterBusyError())).toBe(true);
		expect(
			isTransientStoreError(
				Object.assign(new Error("x"), { code: "SQLITE_BUSY" }),
			),
		).toBe(true);
		expect(isTransientStoreError(new Error("invocation_changed"))).toBe(false);
		expect(isTransientStoreError(new Error("SQLITE_BUSY"))).toBe(false);
		expect(isTransientStoreError("database_closing")).toBe(false);
	});
});

describe("isNetworkError", () => {
	test("is true for a refused connection to a closed port", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const url = `http://127.0.0.1:${server.port}/`;
		await server.stop(true);
		expect(isNetworkError(await thrown(() => fetch(url)))).toBe(true);
	});

	test("is false for program bugs", async () => {
		const bug = await thrown(
			async () => (undefined as unknown as { x: number }).x,
		);
		expect(bug).toBeInstanceOf(TypeError);
		expect(isNetworkError(bug)).toBe(false);
		expect(
			isNetworkError(
				new TypeError("Cannot read properties of undefined (reading 'x')"),
			),
		).toBe(false);
		expect(isNetworkError("ECONNRESET")).toBe(false);
	});

	test("uses code, cause code and TypeError message prefixes", () => {
		expect(
			isNetworkError(Object.assign(new TypeError("x"), { code: "ENOTFOUND" })),
		).toBe(true);
		expect(
			isNetworkError(new Error("x", { cause: { code: "ECONNRESET" } })),
		).toBe(true);
		expect(isNetworkError(new TypeError("terminated"))).toBe(true);
		expect(isNetworkError(new Error("terminated"))).toBe(false);
	});

	test("is true when the peer drops the socket mid-body", async () => {
		const { server, url } = await listen((socket) => {
			socket.once("data", () => {
				socket.write(
					"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n5\r\nhello\r\n",
					() => socket.destroy(),
				);
			});
		});
		try {
			const error = await thrown(async () => (await fetch(url)).text());
			expect(isNetworkError(error)).toBe(true);
		} finally {
			server.close();
		}
	});

	test("is true when the peer drops the socket before responding", async () => {
		const { server, url } = await listen((socket) => {
			socket.once("data", () => socket.destroy());
		});
		try {
			const error = await thrown(async () => (await fetch(url)).text());
			expect(isNetworkError(error)).toBe(true);
		} finally {
			server.close();
		}
	});
});
