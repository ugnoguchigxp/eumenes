/** Live acceptance driver: only Eumenes API writes; the actual dot must fetch, claim and reply. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
const texts = [
	"非機密の連携試験1/3です。架空の予定として『日曜の午後、場所は図書館』を受け取って短く返答してください。この試験会話で渡した情報だけを使い、返答と今回までの累積要約をMCPへ保存してください。外部への連絡や作業用Sessionの作成は不要です。",
	"連携試験2/3です。架空の予定の場所を、図書館から公園へ変更します。日曜の午後は維持します。前の要約と今回の変更を踏まえて短く返答し、更新した累積要約と一緒にMCPへ保存してください。",
	"連携試験3/3です。架空の予定の持ち物に、青いノートを追加します。この試験会話で決まった曜日・時間帯・場所・持ち物を短く確認し、返答と累積要約をMCPへ保存してください。連携前や他の会話の履歴は要約に含めないでください。",
];
type Exchange = {
	requestId: string;
	text: string;
	messageId?: string;
	commandId?: string;
	lastState?: string;
	delivery?: unknown;
	reply?: {
		id: string;
		replyText: string | null;
		summary: string | null;
		limitations: string[];
	};
	receivedAt?: string;
};
type Acceptance = {
	mode: "live";
	connectionRef: string;
	conversationId: string;
	openRequestId: string;
	threadId?: string;
	startedAt: string;
	finishedAt?: string;
	exchanges: Exchange[];
	result: "prepared" | "running" | "passed" | "incomplete";
	failure?: string;
};
const [connectionRef, outputArg, mode] = process.argv.slice(2);
if (
	!connectionRef ||
	!outputArg ||
	!["--prepare", "--run"].includes(mode ?? "")
)
	throw new Error(
		"usage: bun scripts/dots-messaging-live.ts CONNECTION_REF OUTPUT_JSON --prepare|--run",
	);
const output = resolve(outputArg),
	client = createClient(
		process.env.EUMENES_URL ?? "http://127.0.0.1:8787",
		readApiToken(process.env),
	);
const record: Acceptance = existsSync(output)
	? JSON.parse(readFileSync(output, "utf8"))
	: {
			mode: "live",
			connectionRef,
			conversationId: "main",
			openRequestId: crypto.randomUUID(),
			startedAt: new Date().toISOString(),
			exchanges: texts.map((text) => ({
				requestId: crypto.randomUUID(),
				text,
			})),
			result: "prepared",
		};
if (
	record.connectionRef !== connectionRef ||
	record.mode !== "live" ||
	record.exchanges.length !== 3 ||
	record.exchanges.some((e, i) => e.text !== texts[i])
)
	throw new Error("acceptance_record_mismatch");
function save() {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, JSON.stringify(record, null, 2) + "\n", {
		mode: 0o600,
	});
}
function status(index: number, e: Exchange) {
	console.log(
		JSON.stringify({
			exchange: index + 1,
			messageId: e.messageId,
			commandId: e.commandId,
			state: e.lastState,
			hasReply: !!e.reply?.replyText,
			hasSummary: !!e.reply?.summary,
		}),
	);
}
save();
if (mode === "--prepare")
	console.log(JSON.stringify({ prepared: true, exchanges: 3, output }));
else
	try {
		const config = await client.dotsConfiguration(),
			connection = config.connections.find((c) => c.id === connectionRef),
			event = config.events.find((e) => e.connectionRef === connectionRef);
		if (
			!connection?.enabled ||
			!connection.oauth ||
			!event?.messaging?.enabled ||
			!event.subscribed ||
			!event.expiresAt ||
			event.expiresAt <= Date.now()
		)
			throw new Error("dots_connection_not_ready");
		record.result = "running";
		record.failure = undefined;
		save();
		if (!record.threadId) {
			record.threadId = (
				await client.openDotsMessageConversation({
					requestId: record.openRequestId,
					connectionRef,
					conversationId: record.conversationId,
				})
			).id;
			save();
		}
		for (const [index, e] of record.exchanges.entries()) {
			if (e.receivedAt && e.reply?.replyText && e.reply.summary) continue;
			if (!e.messageId) {
				const m = await client.sendDotsMessage(record.threadId, {
					requestId: e.requestId,
					text: e.text,
				});
				e.messageId = m.id;
				e.commandId = m.commandId;
				save();
			}
			const deadline = Date.now() + 600000;
			while (true) {
				const view = await client.dotsMessageConversation(
						record.threadId,
						0,
						100,
					),
					m = view.items.find((m) => m.id === e.messageId);
				if (!m) throw new Error("acceptance_message_missing");
				if (e.lastState !== m.state) {
					e.lastState = m.state;
					status(index, e);
				}
				e.delivery = m.delivery;
				e.reply = m.reply ?? undefined;
				save();
				if (m.state === "answered") {
					if (!m.reply?.replyText || !m.reply.summary)
						throw new Error("acceptance_reply_or_summary_missing");
					e.receivedAt = new Date().toISOString();
					save();
					status(index, e);
					break;
				}
				if (["failed", "cancelled", "expired"].includes(m.state))
					throw new Error("acceptance_terminal_without_answer");
				if (Date.now() >= deadline) throw new Error("acceptance_reply_timeout");
				await Bun.sleep(2000);
			}
		}
		record.result = "passed";
		record.finishedAt = new Date().toISOString();
		save();
		console.log(
			JSON.stringify({
				result: "passed",
				exchanges: 3,
				threadId: record.threadId,
			}),
		);
	} catch (error) {
		record.result = "incomplete";
		record.failure =
			error instanceof Error &&
			/^(dots_connection_not_ready|acceptance_[a-z_]+)$/.test(error.message)
				? error.message
				: "acceptance_request_failed";
		save();
		console.error(
			JSON.stringify({ result: record.result, reason: record.failure }),
		);
		process.exitCode = 1;
	}
