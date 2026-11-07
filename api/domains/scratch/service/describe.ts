import {
	estimateTextTokens,
	headWithin,
} from "../../../infrastructure/context-budget";
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

/** The most bytes one page decodes: more than the read bound holds in any script. */
export const PAGE_WINDOW_BYTES = 8 * 1024;

/** The first character boundary at or after `at` (a UTF-8 continuation byte is `10xxxxxx`). */
function boundary(bytes: Uint8Array, at: number) {
	let i = at;
	while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
	return i;
}

/**
 * One page of the item for `resource.read` (§9.2). A text item is read from `page`: its bytes from byte `start`
 * (at most `PAGE_WINDOW_BYTES`, never the whole file), cut to the read bound, with the byte position of the rest on
 * the last line. Any other item is described.
 */
export function readPage(
	item: ScratchItem,
	page: { start: number; bytes: Uint8Array } | null,
) {
	if (!isScratchText(item.mime) || !page) return described(item);
	// A position inside a character moves on to the next one.
	const skip = boundary(page.bytes, 0);
	const start = Math.min(page.start + skip, item.bytes);
	const window = page.bytes.subarray(skip);
	const head = (end: number) =>
		`一時ファイル「${item.name}」（${kindText(item.mime)} ${sizeText(item.bytes)}、位置 ${start}〜${end}／全 ${item.bytes}）`;
	if (start >= item.bytes || !window.length)
		return `${head(start)}\n（ここで終わりです）`;
	const footer = `\n続き: offset ${item.bytes}`;
	const budget =
		READ_PAGE_TOKENS -
		estimateTextTokens(head(item.bytes)) -
		estimateTextTokens(footer);
	// `stream` keeps a character cut at the window's end out of the text instead of a replacement mark.
	const text = new TextDecoder().decode(window, { stream: true });
	const body = headWithin(text, budget, "").text;
	const used = Math.min(
		window.length,
		boundary(window, new TextEncoder().encode(body).length),
	);
	const end = start + used;
	return end < item.bytes
		? `${head(end)}\n${body}\n続き: offset ${end}`
		: `${head(end)}\n${body}`;
}
