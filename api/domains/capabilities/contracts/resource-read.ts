import { z } from "zod";

/**
 * Input of the `resource.read` tool: the URI of a resource handed to the execution or returned by one of its
 * tools. `format: "eumenes-uri"` makes the sub-agent host check the value before the tool runs. Capabilities
 * cannot import the resources domain, which owns the URI grammar (`parseResourceUri`) and is the one that reads.
 */
export const resourceRead = z.strictObject({
	uri: z
		.string()
		.min(1)
		.max(512)
		.meta({ format: "eumenes-uri" })
		.describe("読むリソースのURI。提示されたものをそのまま写す。"),
	offset: z
		.number()
		.int()
		.min(0)
		.max(100_000_000)
		.optional()
		.describe(
			"続きを読む位置（文字数）。前に読んだ結果の最後の行「続き: offset N」のNをそのまま写す。最初から読むときは省略する。",
		),
});

/**
 * Input of the `scratch.write` tool (spec/server-scratch-cache-design-2026-11-07.md §9.1): a text the sub-agent
 * shares as a server-lifetime file. The host checks the size in bytes; capabilities cannot import scratch.
 */
export const scratchWrite = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.describe("ファイルの表示名。会話と画面に出る。"),
	mime: z
		.enum(["text/markdown", "text/plain", "text/csv", "application/json"])
		.describe("内容の形式。表や見出しのある文書はtext/markdown。"),
	text: z
		.string()
		.min(1)
		.max(1_048_576)
		.describe("書き出す本文（UTF-8で1MiB以内）。"),
});
