/**
 * Fake `@playwright/mcp` 0.0.83 for adapter tests: newline-delimited JSON-RPC on stdio that
 * answers with the recorded response shapes (see adapters-mcp-driver.test.ts). Behaviour is
 * read from `<dirname(output-dir)>/fake-config.json` on every call; every start and call is
 * appended to `<dirname(output-dir)>/fake-calls.jsonl`. Files are written into the output dir
 * the way MCP does, so tests can check they are removed. Never connects to a browser.
 */
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type Config = {
	initialUrl?: string;
	/** Delay the first tools/call (the connect page). */
	connectDelayMs?: number;
	/** First tools/call answers with an error result. */
	connectError?: string;
	exitOnCall?: string;
	hangOn?: string;
	snapshotMode?: "inline" | "file";
	errors?: Record<string, string>;
	images?: boolean;
	pageMetrics?: Record<string, unknown>;
	elementMetrics?: Record<string, unknown>;
	evaluateRaw?: string;
	/** What the host's fixed inspection function reports. */
	targetInfo?: Record<string, unknown>;
};

const argv = process.argv.slice(2);
const outDir = argv[argv.indexOf("--output-dir") + 1] as string;
const root = dirname(outDir);
const logFile = join(root, "fake-calls.jsonl");
const log = (entry: unknown) =>
	appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
const config = (): Config => {
	const file = join(root, "fake-config.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};

// 1x1 PNG
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const INLINE_SNAPSHOT = [
	"- main [ref=e3]:",
	'  - button "アーティファクトを開く" [ref=e4] [cursor=pointer]',
	'  - textbox "検索" [ref=e5]',
].join("\n");

let tabs = [
	{ title: "Eumenes", url: config().initialUrl ?? "http://127.0.0.1:5173/" },
];
let selected = 0;
let calls = 0;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const tabList = () =>
	tabs
		.map(
			(t, i) =>
				`- ${i}:${i === selected ? " (current)" : ""} [${t.title}](${t.url})`,
		)
		.join("\n");

function writeOutputs() {
	const snapshotName = `page-${stamp()}.yml`;
	writeFileSync(join(outDir, snapshotName), INLINE_SNAPSHOT);
	writeFileSync(join(outDir, `console-${stamp()}.log`), "secret page text\n");
	return snapshotName;
}

function pageText(cfg: Config, opts: { result?: string; code?: string }) {
	const tab = tabs[selected];
	const snapshotName = writeOutputs();
	const lines: string[] = [];
	if (opts.result !== undefined) lines.push("### Result", opts.result);
	if (opts.code)
		lines.push("### Ran Playwright code", "```js", opts.code, "```");
	if (tabs.length > 1) lines.push("### Open tabs", tabList());
	lines.push(
		"### Page",
		`- Page URL: ${tab?.url}`,
		`- Page Title: ${tab?.title}`,
		"- Console: 2 errors, 0 warnings",
		"### Snapshot",
		`- [Snapshot](.playwright-mcp/${snapshotName})`,
		"### Events",
		"- New console entries: .playwright-mcp/console-x.log#L1-L2",
	);
	return lines.join("\n");
}

function respond(id: unknown, result: unknown) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
const text = (value: string, extra: object = {}) => ({
	content: [{ type: "text", text: value }],
	...extra,
});

async function call(id: unknown, name: string, args: Record<string, unknown>) {
	const cfg = config();
	calls += 1;
	log({ kind: "call", name, args });
	if (cfg.exitOnCall === name) process.exit(3);
	if (cfg.hangOn === name) return;
	if (calls === 1) {
		if (cfg.connectDelayMs)
			await new Promise((r) => setTimeout(r, cfg.connectDelayMs));
		if (cfg.connectError)
			return respond(
				id,
				text(`### Error\n${cfg.connectError}`, { isError: true }),
			);
	}
	const failure = cfg.errors?.[name];
	if (failure)
		return respond(id, text(`### Error\n${failure}`, { isError: true }));
	switch (name) {
		case "browser_tabs": {
			if (args.action === "new") {
				tabs.push({ title: "Example Domain", url: String(args.url) });
				selected = tabs.length - 1;
			} else if (args.action === "select") selected = Number(args.index);
			else if (args.action === "close") {
				tabs.splice(Number(args.index), 1);
				selected = 0;
			}
			if (tabs.length === 0)
				return respond(
					id,
					text("### Result\nNo open tabs. Navigate to a URL to create one."),
				);
			return respond(
				id,
				text(
					args.action === "list"
						? `### Result\n${tabList()}`
						: pageText(cfg, { result: tabList() }),
				),
			);
		}
		case "browser_snapshot": {
			const tab = tabs[selected];
			if (cfg.snapshotMode === "file") {
				const snapshotName = writeOutputs();
				return respond(
					id,
					text(
						`### Page\n- Page URL: ${tab?.url}\n- Page Title: ${tab?.title}\n### Snapshot\n- [Snapshot](.playwright-mcp/${snapshotName})`,
					),
				);
			}
			writeOutputs();
			return respond(
				id,
				text(
					`### Page\n- Page URL: ${tab?.url}\n- Page Title: ${tab?.title}\n- Console: 190 errors, 0 warnings\n### Snapshot\n\`\`\`yaml\n${INLINE_SNAPSHOT}\n\`\`\`\n### Events\n- New console entries: .playwright-mcp/console-x.log#L1-L190`,
				),
			);
		}
		case "browser_navigate":
			tabs[selected] = { title: "Example Domain", url: String(args.url) };
			return respond(
				id,
				text(pageText(cfg, { code: `await page.goto('${args.url}');` })),
			);
		case "browser_evaluate": {
			const fn = String(args.function);
			const value = fn.includes("isSubmitter")
				? (cfg.targetInfo ?? { tag: "button", inForm: false, submits: false })
				: fn.includes("viewportWidth")
					? (cfg.pageMetrics ?? {
							viewportWidth: 1500,
							viewportHeight: 685,
							scrollWidth: 1500,
							scrollHeight: 2100.4,
							devicePixelRatio: 2,
						})
					: (cfg.elementMetrics ?? {
							width: 320.2,
							height: 80,
							devicePixelRatio: 2,
						});
			writeOutputs();
			return respond(
				id,
				text(
					`### Result\n${cfg.evaluateRaw ?? JSON.stringify(value, null, 2)}`,
				),
			);
		}
		case "browser_take_screenshot": {
			const file = `${args.target ? "element" : "page"}-${stamp()}.png`;
			writeFileSync(join(outDir, file), Buffer.from(PNG, "base64"));
			const content: unknown[] = [
				{
					type: "text",
					text: `### Result\n- [Screenshot of viewport](./${file})\n### Ran Playwright code\n\`\`\`js\nawait page.screenshot();\n\`\`\``,
				},
			];
			if (cfg.images !== false)
				content.push({ type: "image", data: PNG, mimeType: "image/png" });
			return respond(id, { content });
		}
		default:
			return respond(id, text(pageText(cfg, { code: `// ${name}` })));
	}
}

log({
	kind: "start",
	pid: process.pid,
	argv,
	envKeys: Object.keys(process.env).sort(),
	executablePath: process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH,
	cwd: process.cwd(),
});

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		const message = JSON.parse(line);
		if (message.method === "initialize")
			respond(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "Playwright", version: "fake" },
			});
		else if (message.method === "tools/call")
			void call(
				message.id,
				message.params.name,
				message.params.arguments ?? {},
			);
		else if (message.method === "notifications/cancelled")
			log({ kind: "cancelled" });
		else if (message.id !== undefined)
			process.stdout.write(
				`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown" } })}\n`,
			);
	}
});
process.stdin.on("end", () => process.exit(0));
