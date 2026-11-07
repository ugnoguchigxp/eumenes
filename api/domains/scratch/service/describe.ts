import { estimateTextTokens, headWithin } from "../../../infrastructure/context-budget";
import { jstDisplay } from "../../../infrastructure/jst-time";
import { isScratchImage, isScratchText, type ScratchItem } from "../contracts";

/** Under the resources' 600-token read bound, with room for the header and the closing line. */
export const READ_PAGE_TOKENS = 560;

const kindWords: Record<string, string> = {
	"text/markdown": "Markdown",
	"text/plain": "テキスト",
	"text/csv": "CSV",
	"application/json": "JSON",
	"application/pdf": "PDF",
	"model/gltf-binary": "3Dモデル",
};
export const kindText = (mime: string) =>
	isScratchImage(mime) ? "画像" : (kindWords[mime] ?? mime);

export function sizeText(bytes: number) {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const originWords = { attached: "添付", pasted: "貼付", written: "作成" };

/** Who made it and what it is, as the conversation reads it after the label: 「利用者が添付、画像 1600×1200」. */
export function noteOf(item: ScratchItem) {
	const what =
		isScratchImage(item.mime) && item.width && item.height
			? `画像 ${item.width}×${item.height}`
			: `${kindText(item.mime)} ${sizeText(item.bytes)}`;
	return `${item.maker}が${originWords[item.origin]}、${what}`;
}

/** What a non-text item is (an image, a PDF, a 3D model): the read of it. */
function described(item: ScratchItem) {
	const dims =
		item.width && item.height ? `、${item.width}×${item.height}` : "";
	const lines = [
		`一時ファイル「${item.name}」`,
		`種類: ${kindText(item.mime)}（${item.mime}${dims}、${sizeText(item.bytes)}）`,
		`作成: ${jstDisplay(item.createdAt).slice(0, 16)} ${item.maker}が${originWords[item.origin]}`,
	];
	if (item.annotation)
		lines.push(
			`注記（${item.annotation.source}）: ${JSON.stringify(item.annotation.data)}`,
		);
	lines.push("サーバーの再起動で消えます。");
	return headWithin(lines.join("\n"), READ_PAGE_TOKENS, "…").text;
}

/**
 * One page of the item for `resource.read` (§9.2): a text item from `offset` (characters) within the read bound,
 * with the offset of the rest on the last line; any other item is described.
 */
export function readPage(item: ScratchItem, text: string | null, offset = 0) {
	if (!isScratchText(item.mime) || text === null) return described(item);
	const chars = [...text];
	const start = Math.min(Math.max(0, Math.floor(offset)), chars.length);
	const head = (end: number) =>
		`一時ファイル「${item.name}」（${kindText(item.mime)} ${sizeText(item.bytes)}、${start.toLocaleString("en-US")}〜${end.toLocaleString("en-US")}字／全${chars.length.toLocaleString("en-US")}字）`;
	if (start >= chars.length) return `${head(start)}\n（ここで終わりです）`;
	const footer = "\n続き: offset 0000000";
	const budget =
		READ_PAGE_TOKENS -
		estimateTextTokens(head(chars.length)) -
		estimateTextTokens(footer);
	const body = headWithin(chars.slice(start).join(""), budget, "").text;
	const end = start + [...body].length;
	return end < chars.length
		? `${head(end)}\n${body}\n続き: offset ${end}`
		: `${head(end)}\n${body}`;
}
