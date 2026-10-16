import { join } from "node:path";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createTerminals } from "../api/domains/terminals";

// A fake `claude` (shell script) on a real PTY; the conversation path is the registered toolchain.
const h = await harness({
	terminals: (store) =>
		createTerminals({
			store,
			command: [
				"/bin/sh",
				join(import.meta.dir, "../tests/browser/fixtures/fake-claude.sh"),
			],
			// The fake reports through the same hooks as Claude Code.
			hookBaseUrl: `http://127.0.0.1:${process.env.EUMENES_PORT}`,
		}),
	routeTool: "claude_code",
	command: (messages) => {
		const data = JSON.parse(messages.at(-1)!.content) as { request: string };
		return JSON.stringify({
			action: "invoke",
			tool: "claude-code.request",
			arguments: {
				prompt: data.request,
				task: data.request.includes("README")
					? "README の手順修正"
					: "テスト修正",
			},
		});
	},
	// The latest input decides: the hidden notice stays in the history of later turns.
	parent: (messages) =>
		messages
			.filter((m) => m.role === "user" && !m.content.startsWith("{"))
			.at(-1)
			?.content.includes("【通知】")
			? "README の手順修正が終わりました。変更をコミットしますか？"
			: "承知しました。終わったらお知らせします。",
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	idleTimeout: 60,
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
