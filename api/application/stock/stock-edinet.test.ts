import { expect, test } from "bun:test";
import { codeListCsv, zipOf } from "./stock.fixture";
import { parseCompanies, unzipCsv } from "./stock-edinet";

test("the zip is opened whether its entry is deflated or stored", () => {
	const csv = codeListCsv();
	expect(unzipCsv(zipOf("EdinetcodeDlInfo.csv", csv))).toEqual(csv);
	expect(unzipCsv(zipOf("EdinetcodeDlInfo.csv", csv, 0))).toEqual(csv);
});

test("a file that is not a zip, or holds no CSV, is refused", () => {
	expect(() =>
		unzipCsv(new TextEncoder().encode("<html>error</html>")),
	).toThrow("stock_codelist_invalid");
	expect(() => unzipCsv(zipOf("readme.txt", new Uint8Array([1])))).toThrow(
		"stock_codelist_invalid",
	);
	const truncated = zipOf("a.csv", codeListCsv()).slice(0, 100);
	expect(() => unzipCsv(truncated)).toThrow("stock_codelist_invalid");
});

test("only listed companies with a securities code are kept, with their names made comparable", () => {
	const companies = parseCompanies(codeListCsv());
	// the sample holds one unlisted submitter (no code) and one row twice
	expect(companies.map((c) => c.code)).toEqual([
		"9434",
		"9984",
		"7203",
		"3116",
		"7974",
		"6758",
		"130A",
		"9432",
		"9983",
	]);
	const softbank = companies[0]!;
	expect(softbank.name).toBe("ソフトバンク株式会社");
	// the kanji name and the reading; this company has no English name
	expect(softbank.keys).toEqual(["ソフトバンク"]);
	// 資本金 is kept to tell apart companies that fit a name equally well
	expect(softbank.capital).toBe(205985);
	const nintendo = companies.find((c) => c.code === "7974")!;
	expect(nintendo.keys).toEqual(["任天堂", "nintendo", "ニンテンドウ"]);
	// full-width letters and the space inside a name are made plain
	expect(companies.find((c) => c.code === "130A")!.name).toBe(
		"株式会社ＶｅｒｉｔａｓＩｎＳｉｌｉｃｏ",
	);
});

test("a document that is not the code list is refused as a whole", () => {
	expect(() => parseCompanies(new TextEncoder().encode("a,b\n1,2\n"))).toThrow(
		"stock_codelist_invalid",
	);
	expect(() => parseCompanies(new Uint8Array([0xff, 0xff, 0xff]))).toThrow(
		"stock_codelist_invalid",
	);
	const header =
		"証券コード,提出者名,提出者名（英字）,提出者名（ヨミ）,上場区分\n";
	expect(() => parseCompanies(new TextEncoder().encode(header))).toThrow(
		"stock_codelist_invalid",
	);
});
