import { createServer } from "node:http";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { SdkService } from "./sdk-service";

export async function serveSdk(service: SdkService) {
	const socket = join(service.config.root, "sdk.sock");
	if (existsSync(socket)) {
		const s = lstatSync(socket);
		if (!s.isSocket() || s.uid !== process.getuid?.())
			throw new Error("sdk_socket_unsafe");
		unlinkSync(socket);
	}
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method !== "POST" || req.url !== "/sdk") {
			res.writeHead(404).end('{"code":"sdk_endpoint_missing"}');
			return;
		}
		try {
			let body = "";
			for await (const chunk of req) {
				body += chunk.toString();
				if (Buffer.byteLength(body) > 512 * 1024)
					throw new Error("sdk_request_limit");
			}
			res.end(JSON.stringify(service.request(JSON.parse(body))));
		} catch (error) {
			const code =
				error instanceof Error && /^sdk_[a-z_]+$/.test(error.message)
					? error.message
					: "sdk_request_invalid";
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
