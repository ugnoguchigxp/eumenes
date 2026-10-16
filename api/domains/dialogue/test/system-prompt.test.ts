import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../service/system-prompt";

// Fingerprints captured before extraction: whitespace, persona, names and literal
// placeholder-like input must remain identical through the TOML compiler.
const cases = [
	{
		input: {
			persona: "butler",
			agentName: "",
			userName: "",
		},
		sha256: "704d3e484735e17df073a0390fc97a012a045e60fc19303bb8dda25850f6770d",
	},
	{
		input: {
			persona: "butler",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "52f219629d4108a3e82c49f1508c7a6f52dc565083c8c4b31c8365fdd76af935",
	},
	{
		input: {
			persona: "butler",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "41d1a17dd8893c87458bd4c3aa6c6cff7b09c5439d30aa7476367ce919d4cb7c",
	},
	{
		input: {
			persona: "maid",
			agentName: "",
			userName: "",
		},
		sha256: "734e45cd6eaad583dfaddb582ec9dd9e2186d54ed4a8ef1b6074cf1e2990ec0d",
	},
	{
		input: {
			persona: "maid",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "6e5c5e7a946daf0320045163e28d3c6e0206ea3ebc1188890747e7bf156666de",
	},
	{
		input: {
			persona: "maid",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "f20440666402e1be48fb2124343c500152d7731c1b738ff94480e55939aece3c",
	},
	{
		input: {
			persona: "strategist",
			agentName: "",
			userName: "",
		},
		sha256: "05682b08034869d08ef270b265e0ca0e10b6af358e2b748f4bd6a3956cf8b881",
	},
	{
		input: {
			persona: "strategist",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "6487292b2aad40747d8732a3c5bdf535c31b76c7a4a819e697c16d12de9742b4",
	},
	{
		input: {
			persona: "strategist",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "cdbe67083ca4c32a02a072771777172e46f46bffebbcadc1e3cfe595da27b5ac",
	},
	{
		input: {
			persona: "sage",
			agentName: "",
			userName: "",
		},
		sha256: "0b4e05782b79019eda361cda1443cc85eae55341c51c3392a2a6ad433be9ef93",
	},
	{
		input: {
			persona: "sage",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "d8d93a9f6adfaf6f92609a88303359f8669459dc156f12a62d07672afa99e060",
	},
	{
		input: {
			persona: "sage",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "5c1047a322b33373507f7418b4531cf4308b9ff2298e223101696cf6396cfd91",
	},
] as const;

test("TOML preserves the conversation instruction bytes for every persona", () => {
	for (const { input, sha256 } of cases) {
		const text = buildSystemPrompt(input);
		expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
	}
});
