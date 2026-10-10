import { describe, expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "./digest";

/*
 * Golden values were computed from the pre-ARC-9 implementations:
 *  - "locale"         : tasks/service canonical (localeCompare, undefined kept as null)
 *  - "codeUnit"       : timers/scheduler/queue canonical (code-unit order, undefined omitted)
 *  - "researchRoutes" : research-routes canonicalJson (code-unit order, undefined omitted,
 *                       JS integer-like keys first)
 * Persisted digests depend on these exact strings; never edit the expectations.
 */
const inputs: Record<string, unknown> = {
	spec: { b: 1, a: [1, { d: undefined, c: "x" }], Z: null, é: 2 },
	empty: {},
	nestedArrays: [[1, [2, [3, []]]], [{}], []],
	numbers: { negZero: -0, big: 1e21, small: 1e-7, frac: 0.1, int: 42 },
	intKeys: { "10": "a", "9": "b", b: 1, "1": 2, a: 3 },
	caseAndAccents: {
		a: 1,
		B: 2,
		é: 3,
		e: 4,
		Z: 5,
		z: 6,
		ä: 7,
		_: 8,
		"-": 9,
	},
	unicode: { s: '日本語\u0000\n"\\', emoji: "😀", lone: "\ud800x" },
	undefInArray: [undefined, null, { a: undefined }],
	scalars: "str",
	nullTop: null,
	boolTop: true,
	numberTop: 12,
	undefTop: undefined,
	dateNested: { d: new Date(0) },
};

type Golden = {
	locale: string;
	localeHex: string;
	codeUnit: string;
	codeUnitHex: string;
	researchRoutes: string | null;
	researchRoutesHex: string | null;
};
const expected: Record<string, Golden> = {
	spec: {
		locale: '{"a":[1,{"c":"x","d":null}],"b":1,"é":2,"Z":null}',
		localeHex:
			"f9316cb39bf0566cc4ef5906da1b41c36a05a46e820c0b988af896a2eb276d3b",
		codeUnit: '{"Z":null,"a":[1,{"c":"x"}],"b":1,"é":2}',
		codeUnitHex:
			"37f6b004103fb599e4416de7da9b536fc285591bdf5e14bf933c708bfc93f69a",
		researchRoutes: '{"Z":null,"a":[1,{"c":"x"}],"b":1,"é":2}',
		researchRoutesHex:
			"37f6b004103fb599e4416de7da9b536fc285591bdf5e14bf933c708bfc93f69a",
	},
	empty: {
		locale: "{}",
		localeHex:
			"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		codeUnit: "{}",
		codeUnitHex:
			"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
		researchRoutes: "{}",
		researchRoutesHex:
			"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
	},
	nestedArrays: {
		locale: "[[1,[2,[3,[]]]],[{}],[]]",
		localeHex:
			"202585bd36b9de8a5e456e2478a91c9cdcad6dc938fb1f1ee5607ae7fe932b96",
		codeUnit: "[[1,[2,[3,[]]]],[{}],[]]",
		codeUnitHex:
			"202585bd36b9de8a5e456e2478a91c9cdcad6dc938fb1f1ee5607ae7fe932b96",
		researchRoutes: "[[1,[2,[3,[]]]],[{}],[]]",
		researchRoutesHex:
			"202585bd36b9de8a5e456e2478a91c9cdcad6dc938fb1f1ee5607ae7fe932b96",
	},
	numbers: {
		locale: '{"big":1e+21,"frac":0.1,"int":42,"negZero":0,"small":1e-7}',
		localeHex:
			"2fbba985e962c661eae89221a74680c42f91ead4f0797d856e79d086e656661a",
		codeUnit: '{"big":1e+21,"frac":0.1,"int":42,"negZero":0,"small":1e-7}',
		codeUnitHex:
			"2fbba985e962c661eae89221a74680c42f91ead4f0797d856e79d086e656661a",
		researchRoutes:
			'{"big":1e+21,"frac":0.1,"int":42,"negZero":0,"small":1e-7}',
		researchRoutesHex:
			"2fbba985e962c661eae89221a74680c42f91ead4f0797d856e79d086e656661a",
	},
	intKeys: {
		locale: '{"1":2,"10":"a","9":"b","a":3,"b":1}',
		localeHex:
			"f22569753e9d7a7a84929c61fb020fae0fe57dc8cdfbfb7c1059022b14bb0cc2",
		codeUnit: '{"1":2,"10":"a","9":"b","a":3,"b":1}',
		codeUnitHex:
			"f22569753e9d7a7a84929c61fb020fae0fe57dc8cdfbfb7c1059022b14bb0cc2",
		researchRoutes: '{"1":2,"9":"b","10":"a","a":3,"b":1}',
		researchRoutesHex:
			"ce5d06707f67fdb1d8d3c7ad5a8db8b7b67cb7419805c68f2c45ae3bcffb7e98",
	},
	caseAndAccents: {
		locale: '{"_":8,"-":9,"a":1,"ä":7,"B":2,"e":4,"é":3,"z":6,"Z":5}',
		localeHex:
			"b3142755396e170deb1ec5a2029d7309067bf667066adfadabd9c297eb11b2e4",
		codeUnit: '{"-":9,"B":2,"Z":5,"_":8,"a":1,"e":4,"z":6,"ä":7,"é":3}',
		codeUnitHex:
			"209911593c3711474335b18aeb5e0ee31207a05f7f5ba51e7b7efde919be85f4",
		researchRoutes: '{"-":9,"B":2,"Z":5,"_":8,"a":1,"e":4,"z":6,"ä":7,"é":3}',
		researchRoutesHex:
			"209911593c3711474335b18aeb5e0ee31207a05f7f5ba51e7b7efde919be85f4",
	},
	unicode: {
		locale: '{"emoji":"😀","lone":"\\ud800x","s":"日本語\\u0000\\n\\"\\\\"}',
		localeHex:
			"13389d7aafae19c255a5495221df9aacef344a186c047b77b1588d131bd9acfe",
		codeUnit: '{"emoji":"😀","lone":"\\ud800x","s":"日本語\\u0000\\n\\"\\\\"}',
		codeUnitHex:
			"13389d7aafae19c255a5495221df9aacef344a186c047b77b1588d131bd9acfe",
		researchRoutes:
			'{"emoji":"😀","lone":"\\ud800x","s":"日本語\\u0000\\n\\"\\\\"}',
		researchRoutesHex:
			"13389d7aafae19c255a5495221df9aacef344a186c047b77b1588d131bd9acfe",
	},
	undefInArray: {
		locale: '[null,null,{"a":null}]',
		localeHex:
			"cfe7b84b7ef3c7bd1cc227f789f9f8c75889af2a1806b95cba72366e53284f45",
		codeUnit: "[null,null,{}]",
		codeUnitHex:
			"96ed5e609afabf992a4dac183e49741bc67f036669dc03ccb7ac934e16330b32",
		researchRoutes: "[null,null,{}]",
		researchRoutesHex:
			"96ed5e609afabf992a4dac183e49741bc67f036669dc03ccb7ac934e16330b32",
	},
	scalars: {
		locale: '"str"',
		localeHex:
			"72495b0e1f3c6c961f46d3f249ce968ac758c43b88e50d32aa138681f8a38804",
		codeUnit: '"str"',
		codeUnitHex:
			"72495b0e1f3c6c961f46d3f249ce968ac758c43b88e50d32aa138681f8a38804",
		researchRoutes: '"str"',
		researchRoutesHex:
			"72495b0e1f3c6c961f46d3f249ce968ac758c43b88e50d32aa138681f8a38804",
	},
	nullTop: {
		locale: "null",
		localeHex:
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		codeUnit: "null",
		codeUnitHex:
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		researchRoutes: "null",
		researchRoutesHex:
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
	},
	boolTop: {
		locale: "true",
		localeHex:
			"b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
		codeUnit: "true",
		codeUnitHex:
			"b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
		researchRoutes: "true",
		researchRoutesHex:
			"b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b",
	},
	numberTop: {
		locale: "12",
		localeHex:
			"6b51d431df5d7f141cbececcf79edf3dd861c3b4069f0b11661a3eefacbba918",
		codeUnit: "12",
		codeUnitHex:
			"6b51d431df5d7f141cbececcf79edf3dd861c3b4069f0b11661a3eefacbba918",
		researchRoutes: "12",
		researchRoutesHex:
			"6b51d431df5d7f141cbececcf79edf3dd861c3b4069f0b11661a3eefacbba918",
	},
	undefTop: {
		locale: "null",
		localeHex:
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		codeUnit: "null",
		codeUnitHex:
			"74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
		researchRoutes: null,
		researchRoutesHex: null,
	},
	dateNested: {
		locale: '{"d":{}}',
		localeHex:
			"3b00cec27361af5a2e70eaf003bdbc0c8574bdc29802685d1ec7335bbdf9fc87",
		codeUnit: '{"d":{}}',
		codeUnitHex:
			"3b00cec27361af5a2e70eaf003bdbc0c8574bdc29802685d1ec7335bbdf9fc87",
		researchRoutes: '{"d":{}}',
		researchRoutesHex:
			"3b00cec27361af5a2e70eaf003bdbc0c8574bdc29802685d1ec7335bbdf9fc87",
	},
};

describe("canonicalJson golden (bit-identical to pre-ARC-9 output)", () => {
	for (const [name, input] of Object.entries(inputs)) {
		const g = expected[name]!;
		test(`${name}: locale (tasks)`, () => {
			const out = canonicalJson(input, {
				omitUndefined: false,
				keyOrder: "locale",
			});
			expect(out).toBe(g.locale);
			expect(sha256Hex(out)).toBe(g.localeHex);
		});
		test(`${name}: codeUnit (timers/scheduler/queue)`, () => {
			const out = canonicalJson(input, {
				omitUndefined: true,
				keyOrder: "codeUnit",
			});
			expect(out).toBe(g.codeUnit);
			expect(sha256Hex(out)).toBe(g.codeUnitHex);
		});
		if (g.researchRoutes !== null) {
			test(`${name}: research-routes`, () => {
				const out = canonicalJson(input, {
					omitUndefined: true,
					keyOrder: "codeUnit",
					integerKeysFirst: true,
				});
				expect(out).toBe(g.researchRoutes!);
				expect(sha256Hex(out)).toBe(g.researchRoutesHex!);
			});
		}
	}
});

describe("sha256Hex", () => {
	const cases: [string, string][] = [
		["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
		["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
		[
			"日本語",
			"77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5",
		],
		[
			"\ud800x",
			"a87ce46793cc659b79bd187e998f8488635f707d5be0957e1d565981efd2b04b",
		],
		["😀", "f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9"],
	];
	for (const [text, hex] of cases)
		test(JSON.stringify(text), () => {
			expect(sha256Hex(text)).toBe(hex);
			expect(sha256Hex(new TextEncoder().encode(text))).toBe(sha256Hex(text));
		});
});
