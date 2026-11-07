import type { Definition } from "../contracts";

/**
 * The host tools every sub-agent working for a conversation is given (resource-uri plan §6.2,
 * spec/server-scratch-cache-design-2026-11-07.md §9): reading a resource, and writing a shared file. The
 * agent-runtime host binds them itself (no package lists them) and answers them through its ports: a read refuses
 * any URI that was not handed to the execution or returned by one of its tools. They have no `backend`, so every
 * host registers them. Revision 2 of `resource.read` reads on from an `offset`.
 */
export const resourceReadBuiltins: Definition[] = [
	{
		revision: 2,
		aliases: [],
		tags: [],
		useWhen: [],
		avoidWhen: [],
		dependencies: [],
		kind: "tool",
		id: "resource.read",
		title: "リソースを読む",
		summary:
			"依頼に添えられたURI、またはこの作業のtoolが返したURIのリソースの内容を読む",
		schemaKey: "resourceRead",
	},
	{
		revision: 1,
		aliases: [],
		tags: [],
		useWhen: [],
		avoidWhen: [],
		dependencies: [],
		kind: "tool",
		id: "scratch.write",
		title: "共有ファイルに書き出す",
		summary:
			"依頼の成果・途中の表・下書きを、他の担当へ渡せる一時ファイルに書き出す。返ったURIをfinishのlinksに書くと、会話から番号で指せる",
		schemaKey: "scratchWrite",
	},
];
