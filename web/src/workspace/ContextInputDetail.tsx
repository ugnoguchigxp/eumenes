import type { ContextCapture } from "../../../api/domains/dialogue/contracts";

type Message = ContextCapture["input"]["messages"][number];
type Origin = Message["origins"][number];

const clock = new Intl.DateTimeFormat("ja-JP", {
	timeZone: "Asia/Tokyo",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});
export const inputTime = (at: number) =>
	Number.isFinite(at) ? clock.format(at) : "時刻不明";
export const inputBoundary = {
	larm: "LARM",
	"cloud-http": "クラウド HTTP",
	"codex-sdk": "Codex SDK",
	"claude-agent-sdk": "Claude Agent SDK",
} satisfies Record<ContextCapture["input"]["boundary"], string>;

const originLabel: Record<Origin["kind"], string> = {
	system: "指示",
	history: "会話履歴",
	memory: "記憶",
	summary: "圧縮要約",
	state: "状態",
	agency: "Agency",
	user: "今回の発言",
	notice: "ホストの通知",
	tool: "ツール結果",
};

export function ContextInputDetail({ capture }: { capture: ContextCapture }) {
	const { input, cut } = capture;
	const firstTurn = input.messages.findIndex(
		(message) => message.role !== "system",
	);
	// Claude's session store merges adjacent turns and can move pending turns into the prompt.
	const carriedUntil =
		firstTurn +
		(input.boundary === "codex-sdk" ? (input.sdk?.carried ?? 0) : 0);
	return (
		<section aria-label="送信時点の入力" className="context-input-detail">
			{cut && (
				<p>
					履歴の区切り <code>{cut}</code>
				</p>
			)}
			{!!input.omittedMessages && (
				<p>送信前に除外されたメッセージ {input.omittedMessages}件</p>
			)}
			{input.maxOutputTokens !== undefined && (
				<p>出力上限 {input.maxOutputTokens} トークン</p>
			)}
			{input.sdk && (
				<details>
					<summary>
						SDK に渡した入力 · {input.sdk.mode}
						{input.sdk.carried ? ` · 持ち越し ${input.sdk.carried}件` : ""}
					</summary>
					<p>適用された指示</p>
					<pre>{input.sdk.instructions}</pre>
					<p>今回渡した文面</p>
					<pre>{input.sdk.prompt}</pre>
					{input.sdk.images.map(({ mime, width, height, bytes }, i) => (
						<p key={i}>
							添付 {mime} · {width}×{height} · {bytes} bytes
						</p>
					))}
				</details>
			)}
			<ol
				className="context-input-messages"
				aria-label={input.sdk ? "SDK 変換前のメッセージ" : "送信順のメッセージ"}
			>
				{input.messages.map((message, i) => (
					<li key={i}>
						<details
							open={
								i === input.messages.length - 1 ||
								message.role === "tool" ||
								message.origins.some(({ kind }) => kind === "agency")
									? true
									: undefined
							}
						>
							<summary>
								<code className="context-message-role" data-role={message.role}>
									{message.role}
								</code>{" "}
								{Array.from(
									new Set(message.origins.map(({ kind }) => originLabel[kind])),
								).join("・") || "出典未特定"}
								{firstTurn >= 0 &&
									i >= firstTurn &&
									i < carriedUntil &&
									" · 持ち越し"}
							</summary>
							<pre>{message.content}</pre>
							{message.origins.length > 0 && (
								<ul className="context-input-origins">
									{message.origins.map((origin, index) => (
										<li key={index}>
											{originLabel[origin.kind]}
											{origin.at && ` · ${inputTime(Date.parse(origin.at))}`}
											{origin.revision && ` · 版 ${origin.revision}`}
											{origin.id && (
												<>
													{" "}
													· <code>{origin.id}</code>
												</>
											)}
											{message.origins.length > 1 && (
												<small>
													{message.content
														.slice(origin.from, origin.to)
														.slice(0, 80)}
												</small>
											)}
										</li>
									))}
								</ul>
							)}
							{message.toolCallId && (
								<p>
									ツール呼び出し <code>{message.toolCallId}</code>
								</p>
							)}
							{message.toolCalls !== undefined && (
								<pre>{JSON.stringify(message.toolCalls, null, 2)}</pre>
							)}
							{message.images?.map(({ mime, width, height, bytes }, index) => (
								<p key={index}>
									添付 {mime} · {width}×{height} · {bytes} bytes
								</p>
							))}
						</details>
					</li>
				))}
			</ol>
			{input.tools !== undefined && (
				<details>
					<summary>ツール定義</summary>
					<pre>{JSON.stringify(input.tools, null, 2)}</pre>
				</details>
			)}
			{input.format !== undefined && (
				<details>
					<summary>出力形式</summary>
					<pre>{JSON.stringify(input.format, null, 2)}</pre>
				</details>
			)}
		</section>
	);
}

type Change = { before: Message[]; after: Message[] };
const messageKey = ({
	role,
	content,
	images,
	toolCalls,
	toolCallId,
}: Message) => JSON.stringify([role, content, images, toolCalls, toolCallId]);

function diffMessage({
	role,
	content,
	images,
	toolCalls,
	toolCallId,
}: Message) {
	const metadata = { toolCallId, toolCalls, images };
	return (
		`[${role}] ${content}` +
		(toolCallId || toolCalls !== undefined || images?.length
			? `\n${JSON.stringify(metadata, null, 2)}`
			: "")
	);
}

/** Match unchanged messages first, so adding one item does not mark the rest of the input as changed. */
export function compareInputMessages(
	before: Message[],
	after: Message[],
): Change[] {
	const left = before.map(messageKey);
	const right = after.map(messageKey);
	if (left.length * right.length > 100_000) return [{ before, after }];
	const stride = right.length + 1;
	const ranks = new Uint32Array((left.length + 1) * stride);
	for (let i = left.length - 1; i >= 0; i--)
		for (let j = right.length - 1; j >= 0; j--) {
			const p = i * stride + j;
			ranks[p] =
				left[i] === right[j]
					? 1 + ranks[p + stride + 1]!
					: Math.max(ranks[p + stride]!, ranks[p + 1]!);
		}
	const changes: Change[] = [];
	let i = 0;
	let j = 0;
	let startLeft = 0;
	let startRight = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			if (i > startLeft || j > startRight)
				changes.push({
					before: before.slice(startLeft, i),
					after: after.slice(startRight, j),
				});
			startLeft = ++i;
			startRight = ++j;
		} else if (ranks[(i + 1) * stride + j]! >= ranks[i * stride + j + 1]!) i++;
		else j++;
	}
	if (startLeft < left.length || startRight < right.length)
		changes.push({
			before: before.slice(startLeft),
			after: after.slice(startRight),
		});
	return changes;
}

export function ContextInputDiff({
	previous,
	current,
}: {
	previous: ContextCapture;
	current: ContextCapture;
}) {
	const changes = compareInputMessages(
		previous.input.messages,
		current.input.messages,
	);
	const beforeTools = JSON.stringify(
		[previous.input.tools, previous.input.format],
		null,
		2,
	);
	const afterTools = JSON.stringify(
		[current.input.tools, current.input.format],
		null,
		2,
	);
	const beforeSdk = previous.input.sdk;
	const afterSdk = current.input.sdk;
	const fields = [
		[
			"接続経路",
			inputBoundary[previous.input.boundary],
			inputBoundary[current.input.boundary],
		],
		["出力上限", previous.input.maxOutputTokens, current.input.maxOutputTokens],
		["ツール定義・出力形式", beforeTools, afterTools],
		["SDK に渡した指示", beforeSdk?.instructions, afterSdk?.instructions],
		["SDK に渡した文面", beforeSdk?.prompt, afterSdk?.prompt],
		[
			"SDK に渡した添付",
			JSON.stringify(beforeSdk?.images),
			JSON.stringify(afterSdk?.images),
		],
		[
			"SDK の送信方式と持ち越し",
			beforeSdk && `${beforeSdk.mode} · 持ち越し ${beforeSdk.carried}件`,
			afterSdk && `${afterSdk.mode} · 持ち越し ${afterSdk.carried}件`,
		],
	].filter(([, before, after]) => before !== after);
	return (
		<section aria-label="入力の差分" className="context-input-diff">
			<p>
				比較元 {inputTime(previous.summary.at)} · 送信 {previous.summary.number}{" "}
				· {inputBoundary[previous.input.boundary]}
			</p>
			{changes.map(({ before, after }, i) => (
				<details key={i}>
					<summary>
						{before.length && after.length
							? "変更"
							: before.length
								? "削除"
								: "追加"}{" "}
						· {before.length} → {after.length}件
					</summary>
					{before.map((message, index) => (
						<pre
							key={`before-${index}`}
							data-change="removed"
						>{`− ${diffMessage(message)}`}</pre>
					))}
					{after.map((message, index) => (
						<pre
							key={`after-${index}`}
							data-change="added"
						>{`+ ${diffMessage(message)}`}</pre>
					))}
				</details>
			))}
			{fields.map(([label, before, after]) => (
				<details key={label}>
					<summary>{label}の変更</summary>
					<pre data-change="removed">{before ?? "入力なし"}</pre>
					<pre data-change="added">{after ?? "入力なし"}</pre>
				</details>
			))}
			{!changes.length && !fields.length && <p>送信内容に差分はありません。</p>}
		</section>
	);
}
