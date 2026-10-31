import { expect, test } from "bun:test";
import { foldedLength, locateQuoteSpan, normalizeKey } from "../service/quote";

/** The exact substring of `text` the quote stands for, or null. */
function locateQuote(text: string, quote: string): string | null {
	const span = locateQuoteSpan(text, quote);
	return span ? text.slice(span.start, span.end) : null;
}

test("an exact quote is returned as it is", () => {
	expect(locateQuote("私はコーヒーが好きです", "コーヒーが好き")).toBe(
		"コーヒーが好き",
	);
});

test("whitespace differences are forgiven and the original slice is returned", () => {
	const text = "毎朝 5時に  起きて、\n走っています";
	expect(locateQuote(text, "毎朝5時に起きて")).toBe("毎朝 5時に  起きて");
	// A quote with spaces the text does not have.
	expect(locateQuote("毎朝5時に起きる", "毎朝 5時 に起きる")).toBe(
		"毎朝5時に起きる",
	);
	// Ideographic space on either side.
	expect(locateQuote("お茶　が好き", "お茶が好き")).toBe("お茶　が好き");
});

test("full-width and half-width forms match through NFKC", () => {
	expect(locateQuote("Ｚｅｄを使っています", "Zedを使って")).toBe(
		"Ｚｅｄを使って",
	);
	expect(locateQuote("Zedを使っています", "Ｚｅｄを使って")).toBe(
		"Zedを使って",
	);
	expect(locateQuote("５時に起きる", "5時に起きる")).toBe("５時に起きる");
});

test("a quote that is not in the text is null", () => {
	expect(locateQuote("私はお茶が好きです", "コーヒーが好き")).toBeNull();
	expect(locateQuote("私はお茶が好きです", "")).toBeNull();
	// Only whitespace folds to nothing: nothing to find.
	expect(locateQuote("a b", "  ")).toBeNull();
});

test("surrogate pairs are never cut", () => {
	const text = "好きな絵文字は 😀 と 𠮷野家 です";
	expect(locateQuote(text, "😀と𠮷野家")).toBe("😀 と 𠮷野家");
	const found = locateQuote(text, "𠮷野家です");
	expect(found).toBe("𠮷野家 です");
	// Every returned string is a literal slice of the text.
	expect(text.includes(found as string)).toBe(true);
});

test("punctuation differences are forgiven", () => {
	const text = "毎朝5時に起きて、走っています。";
	expect(locateQuote(text, "毎朝5時に起きて走っています")).toBe(
		"毎朝5時に起きて、走っています",
	);
	expect(locateQuote(text, "起きて，走って")).toBe("起きて、走って");
	// Only punctuation folds to nothing.
	expect(locateQuote(text, "、。")).toBeNull();
});

test("the span is where the text was found, not where the first copy of its words is", () => {
	const text = "辛いものが好き。辛いものが好きです";
	expect(locateQuoteSpan(text, "辛いものが好きです")).toEqual({
		start: 8,
		end: 17,
	});
	expect(locateQuoteSpan("a 一  二 b", "一二")).toEqual({ start: 2, end: 6 });
	expect(locateQuoteSpan("私はお茶", "コーヒー")).toBeNull();
});

test("folded length counts what is left after normalization", () => {
	expect(foldedLength("Ａ、 b")).toBe(2);
});

test("a key is lower case [a-z0-9._-] and at most 64 characters", () => {
	expect(normalizeKey("  Food.Spicy ")).toBe("food.spicy");
	expect(normalizeKey("a_b-c.1")).toBe("a_b-c.1");
	expect(normalizeKey("")).toBeNull();
	expect(normalizeKey("食べ物")).toBeNull();
	expect(normalizeKey("a b")).toBeNull();
	expect(normalizeKey("-x")).toBeNull();
	expect(normalizeKey("a".repeat(64))).toBe("a".repeat(64));
	expect(normalizeKey("a".repeat(65))).toBeNull();
});
