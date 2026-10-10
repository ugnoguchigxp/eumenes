import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { startServer } from "./server";
import { textSchema, type RequestRecord } from "./contracts";
import { startBridge } from "./bridge";

async function* streamChunks(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	try {
		for (;;) {
			const r = await reader.read();
			if (r.done) return;
			yield r.value;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function main(argv = process.argv.slice(2)) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			"state-dir": { type: "string" },
			port: { type: "string" },
			url: { type: "string" },
			"input-file": { type: "string" },
			"request-id": { type: "string" },
			"deadline-ms": { type: "string" },
			"timeout-ms": { type: "string" },
			wait: { type: "boolean" },
			"private-tunnel": { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	const [command, id] = positionals;
	if (values.help || !command) {
		console.log(
			"dots MVP: serve | bridge | status | send --input-file PATH [--wait] | get ID | wait ID | cancel ID\nOptions: --state-dir DIR --port 8797 --url http://127.0.0.1:8797 --request-id UUID --timeout-ms 120000\nbridge --port 8798: expose MCP only using a private capability URL (synthetic-text smoke test, not OAuth).\nserve --private-tunnel: synthetic-text smoke test behind an owner-only Secure MCP Tunnel; no OAuth principal guarantee.",
		);
		return;
	}
	const directory = resolve(
		values["state-dir"] ??
			join(homedir(), ".local", "state", "eumenes-dots-mvp"),
	);
	const port = Number(values.port ?? 8797);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("invalid_port");
	if (command === "bridge") {
		const bridge = startBridge(
			directory,
			values.url ?? "http://127.0.0.1:8797",
			Number(values.port ?? 8798),
		);
		console.log(
			JSON.stringify({
				state: "bridge_listening",
				url: bridge.url,
				pathFile: join(directory, "bridge.token"),
			}),
		);
		for (const signal of ["SIGINT", "SIGTERM"] as const)
			process.once(signal, () => {
				bridge.server.stop(true);
				process.exit(0);
			});
		return;
	}
	if (command === "serve") {
		const app = startServer({
			directory,
			port,
			privateTunnel: values["private-tunnel"],
		});
		console.log(
			JSON.stringify({
				state: "listening",
				url: app.url,
				mcp: app.url + "/mcp",
				auth: values["private-tunnel"]
					? "private-tunnel-smoke"
					: "bearer-local",
				directory,
			}),
		);
		for (const signal of ["SIGINT", "SIGTERM"] as const)
			process.once(signal, () => void app.close().then(() => process.exit(0)));
		return;
	}
	const url = new URL(values.url ?? `http://127.0.0.1:${port}`);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "localhost"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("CLI requires a loopback HTTP origin");
	const token = readFileSync(join(directory, "admin.token"), "utf8");
	const call = async (path: string, body?: unknown) => {
		const response = await fetch(new URL(path, url), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(150000),
			redirect: "error",
		});
		if (!response.ok)
			throw new Error(`server_${response.status}: ${await response.text()}`);
		return response;
	};
	const wait = async (requestId: string) => {
		const timeout = Number(values["timeout-ms"] ?? 120000);
		if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000)
			throw new Error("invalid_timeout");
		const response = await call(
			`/local/requests/${requestId}/wait?timeoutMs=${timeout}`,
		);
		let buffer = "";
		let latest: RequestRecord | undefined;
		const decoder = new TextDecoder();
		for await (const chunk of streamChunks(response.body!)) {
			buffer += decoder.decode(chunk, { stream: true });
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (frame.startsWith("data: ")) latest = JSON.parse(frame.slice(6));
			}
		}
		if (!latest) throw new Error("empty_wait_response");
		console.log(JSON.stringify(latest, null, 2));
		if (latest.state === "pending") process.exitCode = 2;
	};
	if (command === "status")
		console.log(await (await call("/local/status")).text());
	else if (command === "send") {
		let text: string;
		if (values["input-file"])
			text = await Bun.file(values["input-file"]).text();
		else {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const c of streamChunks(Bun.stdin.stream())) {
				size += c.length;
				if (size > 32768) throw new Error("input_too_large");
				chunks.push(c);
			}
			text = Buffer.concat(chunks).toString();
		}
		textSchema.parse(text);
		const record = (await (
			await call("/local/requests", {
				requestId: values["request-id"] ?? randomUUID(),
				text,
				deadlineMs: Number(values["deadline-ms"] ?? 600000),
			})
		).json()) as RequestRecord;
		console.error(
			JSON.stringify({
				requestId: record.requestId,
				eventId: record.delivery.eventId,
			}),
		);
		if (values.wait) await wait(record.requestId);
		else console.log(JSON.stringify(record, null, 2));
	} else if (id && command === "wait") await wait(id);
	else if (id && ["get", "cancel"].includes(command))
		console.log(
			await (
				await call(
					`/local/requests/${id}${command === "cancel" ? "/cancel" : ""}`,
					command === "cancel" ? {} : undefined,
				)
			).text(),
		);
	else throw new Error("unknown_command");
}
if (import.meta.main)
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : "command_failed");
		process.exitCode = 1;
	});
