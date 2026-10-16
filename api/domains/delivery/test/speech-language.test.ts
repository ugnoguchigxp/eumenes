import { expect, test } from "bun:test";
import { speechLanguage, speechSegments } from "../service/speech-language";

type Case = [
	clause: string,
	segments: Array<[language: "ja" | "en", text: string]>,
];

const cases: Case[] = [
	["今日は晴れです。", [["ja", "今日は晴れです。"]]],
	["Open the settings.", [["en", "Open the settings."]]],
	["Hello!", [["en", "Hello!"]]],
	["ty!", [["en", "ty!"]]],
	["API。", [["ja", "API。"]]],
	["OK", [["ja", "OK"]]],
	[
		"ここで Open the settings を押します。",
		[
			["ja", "ここで"],
			["en", "Open the settings"],
			["ja", "を押します。"],
		],
	],
	[
		"the men は来ました",
		[
			["en", "the men"],
			["ja", "は来ました"],
		],
	],
	["これは ty です", [["ja", "これは ty です"]]],
	["Docker を使います。", [["ja", "Docker を使います。"]]],
	["API キーを入れます", [["ja", "API キーを入れます"]]],
	["MP3 と H2O の話", [["ja", "MP3 と H2O の話"]]],
	[
		"Visual Studio Code を開きます。",
		[["ja", "Visual Studio Code を開きます。"]],
	],
	[
		"iPhone と JavaScript と GitHub",
		[["ja", "iPhone と JavaScript と GitHub"]],
	],
	[
		"example.com と snake_case と a/b を見る",
		[["ja", "example.com と snake_case と a/b を見る"]],
	],
	["Version 2 が出ました", [["ja", "Version 2 が出ました"]]],
	[
		"これは version 2.0 of the app です",
		[
			["ja", "これは"],
			["en", "version 2.0 of the app"],
			["ja", "です"],
		],
	],
	[
		"これは Docker と Open the settings です。",
		[
			["ja", "これは Docker と"],
			["en", "Open the settings"],
			["ja", "です。"],
		],
	],
	[
		"彼は「Thank you so much」と言った",
		[
			["ja", "彼は"],
			["en", "「Thank you so much」"],
			["ja", "と言った"],
		],
	],
	[
		"（see the docs）を参照",
		[
			["en", "（see the docs）"],
			["ja", "を参照"],
		],
	],
	[
		"日本語のあとにEnglish wordsが続く",
		[
			["ja", "日本語のあとに"],
			["en", "English words"],
			["ja", "が続く"],
		],
	],
	["ＡＢＣ は全角です", [["ja", "ＡＢＣ は全角です"]]],
	["2026年10月16日", [["ja", "2026年10月16日"]]],
	["…", [["ja", "…"]]],
	[
		"Visual Studio「Open the door」です",
		[
			["en", "Visual Studio「Open the door」"],
			["ja", "です"],
		],
	],
	[
		"Open the door「API」look at it です",
		[
			["en", "Open the door"],
			["ja", "「API」"],
			["en", "look at it"],
			["ja", "です"],
		],
	],
	[
		"Café au lait は好き",
		[
			["en", "Café au lait"],
			["ja", "は好き"],
		],
	],
	[
		"café au lait は好き",
		[
			["en", "café au lait"],
			["ja", "は好き"],
		],
	],
];

for (const [clause, expected] of cases)
	test(`segments: ${clause}`, () => {
		const segments = speechSegments(clause);
		expect(segments.map((s) => [s.language, s.text])).toEqual(expected);
		// Each segment routes the same way when it is synthesized on its own.
		for (const s of segments) expect(speechLanguage(s.text)).toBe(s.language);
		// Source order and every non-space character are preserved.
		expect(
			segments
				.map((s) => s.text)
				.join("")
				.replace(/\s/g, ""),
		).toBe(clause.replace(/\s/g, ""));
	});

test("a request is English only when every segment is English", () => {
	expect(speechLanguage("Open the settings.")).toBe("en");
	expect(speechLanguage("ここで Open the settings を押します。")).toBe("ja");
	expect(speechLanguage("今日は晴れです。")).toBe("ja");
	expect(speechLanguage("")).toBe("ja");
});
