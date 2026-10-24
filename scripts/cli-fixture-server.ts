import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createShell } from "../api/domains/shell";

// Isolated browser fixture: real PTYs, fixed model, disposable database. Run only with server permission.
const h = await harness({
	shell: (store) => createShell({ store, shell: "/bin/sh", sweepMs: 20 }),
	routeTool: "cli_command",
	command: () =>
		JSON.stringify({
			action: "invoke",
			tool: "cli.run",
			arguments: {
				command: "printf 'CLI fixture output\\n'",
				task: "端末の動作確認",
			},
		}),
	parent: (messages) =>
		JSON.stringify(messages).includes("【通知】")
			? "端末の動作確認が終わりました。CLI fixture output と表示されました。"
			: "実行を始めました。終わったらお知らせします。",
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
