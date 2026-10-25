import { qualityCases, type QualityCase } from "./correction-quality.fixture";

function prose(
	id: string,
	pairs: Array<[string, string]>,
	groups: number[][],
	protectedText: string[],
): QualityCase {
	const lines = pairs.map(([image, observed], i) => ({
		image,
		observed,
		x: 25,
		y: 55 + i * 60,
		width: 755,
	}));
	const paragraphs = groups.map((indices) => ({
		lines: indices,
		text: indices
			.map((i) => pairs[i]![0])
			.join(id === "english" && indices.length > 1 ? " " : ""),
	}));
	return {
		id,
		expected: paragraphs.map((p) => p.text).join("\n"),
		protected: protectedText,
		uncertain: false,
		table: false,
		lines,
		paragraphs,
	};
}

/** Independent wording and identifiers; none repeats the instruction's teaching example. */
export const editQualityCases: QualityCase[] = [
	...qualityCases.map((c): QualityCase => ({
		...c,
		...(c.id === "prose-identifiers"
			? {
					paragraphs: [
						{ lines: [0, 1, 2], text: c.expected.split("\n")[0]! },
						{ lines: [3], text: c.lines[3]!.observed },
						{ lines: [4], text: c.lines[4]!.observed },
					],
				}
			: {}),
		...(c.uncertain
			? { protected: ["AB-100", ...c.lines.slice(1).map((l) => l.observed)] }
			: {}),
	})),
	prose(
		"manual",
		[
			["本商品の詳細は", "本商品の詳紬は"],
			["次の説明書をご参照ください。", "次の説明書をご参照くだざい。"],
			["品番: PX-7O2", "品番: PX-7O2"],
			["質量: 0.75 kg / AC 100 V", "質量: 0.75 kg / AC 100 V"],
		],
		[[0, 1], [2], [3]],
		["PX-7O2", "0.75 kg", "100 V"],
	),
	prose(
		"correct-polite",
		[
			["修理をご希望の場合は", "修理をご希望の場合は"],
			["販売店にご連絡ください。", "販売店にご連絡ください。"],
			["製品番号: MS-00O0", "製品番号: MS-00O0"],
		],
		[[0, 1], [2]],
		["MS-00O0"],
	),
	prose(
		"missing-character",
		[
			["使用後は必ず", "使用後は必ず"],
			["電源を切ってください。", "電源を切てください。"],
			["識別番号: QX-24O-7", "識別番号: QX-24O-7"],
			["入力: DC 24 V / 0.8 A", "入力: DC 24 V / 0.8 A"],
		],
		[[0, 1], [2], [3]],
		["QX-24O-7", "24 V", "0.8 A"],
	),
	prose(
		"heading-name",
		[
			["保管上の注意", "保管上の注意"],
			["直射日光を避けて涼しい場所に", "直射日光を避けて凉しい場所に"],
			["保管してください。", "保管してくだざい。"],
			["製造: 青葉精工 / ST-6O0", "製造: 青葉精工 / ST-6O0"],
		],
		[[0], [1, 2], [3]],
		["青葉精工", "ST-6O0"],
	),
	prose(
		"english",
		[
			["Please disconnect the power", "Please disconnect the power"],
			["before cleaning the device.", "before cleaning the devlce."],
			["Model: RX-10O", "Model: RX-10O"],
			["Rating: 5 V / 250 mA", "Rating: 5 V / 250 mA"],
		],
		[[0, 1], [2], [3]],
		["RX-10O", "5 V", "250 mA"],
	),
	{
		id: "table-variant",
		table: true,
		uncertain: false,
		expected: "部品\t指定値\n形式\tLM-3O8\n温度\t-10 °C\n長さ\t0.25 mm",
		protected: ["LM-3O8", "-10 °C", "0.25 mm"],
		lines: [
			["部品", "部品"],
			["指定値", "指定値"],
			["形式", "形弐"],
			["LM-3O8", "LM-3O8"],
			["温度", "温渡"],
			["-10 °C", "-10 °C"],
			["長さ", "長さ"],
			["0.25 mm", "0.25 mm"],
		].map(([image, observed], i) => ({
			image: image!,
			observed: observed!,
			x: i % 2 ? 360 : 35,
			y: 70 + Math.floor(i / 2) * 70,
			width: i % 2 ? 230 : 120,
		})),
	},
];
