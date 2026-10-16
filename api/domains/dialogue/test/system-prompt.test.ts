import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildSystemPrompt } from "../service/system-prompt";

// Reviewed TTS instruction fingerprints: preserve persona, names and literal
// placeholder-like input through the TOML compiler.
const cases = [
	{
		input: {
			persona: "butler",
			agentName: "",
			userName: "",
		},
		sha256: "cf585da33a524964c8e60fadd10fd7235bbbf9c63a4c921c94faa6527c4b7de3",
	},
	{
		input: {
			persona: "butler",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "0556b0b2959ed38fbaff7d7eb149e00f6b052b9b88d10133d0a5f0fe054bb5ad",
	},
	{
		input: {
			persona: "butler",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "301706792585fdf09b3b34f5dd9583dad2674a971aa4bb1c3531ab108a0fc1e4",
	},
	{
		input: {
			persona: "maid",
			agentName: "",
			userName: "",
		},
		sha256: "2ad528a753d3e4b849e11c278e1215a880618692ca76abaf89acf81e68f3955e",
	},
	{
		input: {
			persona: "maid",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "305bd86ac285d45073672d1fe789c37e7952057bde884456ef96f01093278c57",
	},
	{
		input: {
			persona: "maid",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "67f9f21368ec54e4f6b6aba2a381d02e70c63c9beb6871e7a0c6c920d6729730",
	},
	{
		input: {
			persona: "strategist",
			agentName: "",
			userName: "",
		},
		sha256: "69731ec01b6a61b522d623cec6e7d72df5f13f74d77a4eb5235694697c3fb24b",
	},
	{
		input: {
			persona: "strategist",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "b37f1aa3f9e7f38c5b885efd776d58a11d1cb2e4ad0cd4d4eda5d3820737344a",
	},
	{
		input: {
			persona: "strategist",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "326d6f8aca9b382ec940f618cac6d8def236807b7fd03e62006c0fce1515255c",
	},
	{
		input: {
			persona: "sage",
			agentName: "",
			userName: "",
		},
		sha256: "747843133baf7365ee3fe06e5706cf15ef1c3ee25117abfa9af2efd8763fdf17",
	},
	{
		input: {
			persona: "sage",
			agentName: "エウメネス",
			userName: "野口",
		},
		sha256: "385a0f7524cfc368fa68d0f47b841faad03d421219bb5b5346f8ea7f644d7813",
	},
	{
		input: {
			persona: "sage",
			agentName: "<x>\n[[role]]",
			userName: "「<y>」&",
		},
		sha256: "e0a60375dd8b51935dd2f6365fe99c86af99080ea9c598c2d26d4c923ba9d7a0",
	},
] as const;

test("TOML preserves the conversation instruction bytes for every persona", () => {
	for (const { input, sha256 } of cases) {
		const text = buildSystemPrompt(input);
		expect(createHash("sha256").update(text).digest("hex")).toBe(sha256);
	}
});
