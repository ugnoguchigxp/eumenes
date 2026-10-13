import { expect, test } from "bun:test";
import { locateQuote } from "../service/quote";

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
