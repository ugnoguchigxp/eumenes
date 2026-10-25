import type { Definition } from "../contracts";

/**
 * The common tool every sub-agent can be given to read a resource (resource-uri plan §6.2). A bundle offers it
 * by listing `tool:resource.read@1` in its package; the agent-runtime host runs it through the resource port and
 * refuses any URI that was not handed to the execution or returned by one of its tools. It has no `backend`,
 * so every host registers it.
 */
export const resourceReadBuiltins: Definition[] = [
	{
		revision: 1,
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
];
