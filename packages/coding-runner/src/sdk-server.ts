import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SdkService } from "./sdk-service";

export const serveSdk = (service: SdkService) =>
	servePrivateRunner(
		join(service.config.root, "sdk.sock"),
		"/sdk",
		service,
		"sdk",
	);

export async function servePrivateRunner<T>(
	socket: string,
	endpoint: string,
	service: { request(input: T): unknown; close(): Promise<void> },
	namespace: "sdk" | "claude",
) {
	if (existsSync(socket)) {
		const s = lstatSync(socket);
		if (!s.isSocket() || s.uid !== process.getuid?.())
			throw new Error("sdk_socket_unsafe");
		unlinkSync(socket);
	}
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method !== "POST" || req.url !== endpoint) {
			res
				.writeHead(404)
				.end(JSON.stringify({ code: `${namespace}_endpoint_missing` }));
			return;
		}
		try {
			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
				if (Buffer.byteLength(body) > 512 * 1024)
					throw new Error(`${namespace}_request_limit`);
			}
			res.end(JSON.stringify(service.request(JSON.parse(body))));
		} catch (error) {
			const code =
				error instanceof Error &&
				error.message.startsWith(`${namespace}_`) &&
				/^[a-z_]+$/.test(error.message)
					? error.message
					: `${namespace}_request_invalid`;
			res.writeHead(400).end(JSON.stringify({ code }));
		}
	});
	server.requestTimeout = 5000;
	server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, resolve);
	});
	chmodSync(socket, 0o600);
	return {
		socket,
		close: async () => {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			await service.close();
			if (existsSync(socket)) unlinkSync(socket);
		},
	};
}
