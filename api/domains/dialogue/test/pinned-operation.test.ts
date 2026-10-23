import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migrations as conversationMigrations,
	createConversationService,
} from "../../conversation";
import type { ToolchainCard } from "../../capabilities";
import type { LarmPort } from "../../larm";
import { createQueue, migration as queueMigration } from "../../queue";
import { createDialogueService, migration, queueLinkMigration } from "..";
import { pinnedToolchainMigration } from "../repository";
import type { DialogueDeps, GenerateInput } from "../service/context";
import { createGenerationHandler } from "../service/generation-handler";

const request = '夕焼けの海を描いて\n\n{"width":512}';

type Entry = {
	id: string;
	revisionId: string;
	execution: string;
	functionName: string;
};
const entries: Record<string, Entry> = {
	"image.create": {
		id: "image.create",
		revisionId: "toolchain:image.create@1",
		execution: "image",
		functionName: "image_create",
	},
	"music.create": {
		id: "music.create",
		revisionId: "toolchain:music.create@1",
		execution: "music-create",
		functionName: "music_create",
	},
	"web.search": {
		id: "web.search",
		revisionId: "toolchain:web.search@1",
		execution: "research",
		functionName: "web_search",
	},
	"music.play": {
		id: "music.play",
		revisionId: "toolchain:music.play@1",
		execution: "music-playback",
		functionName: "music_play",
	},
};
const cardOf = (e: Entry): ToolchainCard => ({
	revisionId: e.revisionId,
	id: e.id,
	functionName: e.functionName,
	title: e.id,
	summary: "目的",
	useWhen: ["場面"],
	redirects: [],
	score: { rank: 1, ftsRank: 1, similarity: null, fromHistory: false },
});

/** One queued run pinned to `toolchainId`, and the generation handler over a registry holding `active`. */
async function pinned(
	toolchainId: string,
	over: {
		active?: readonly string[];
		available?: readonly string[];
		withoutCard?: string;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-pinned-"));
	let inference = 0;
	const larm: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		connect: async () => {},
		answer: async () => {
			inference++;
			return "";
		},
		transcribe: async () => "",
		speak: async () => new Uint8Array(),
		close: async () => {},
	};
	const store = openStore(join(dir, "db.sqlite3"), [
		...conversationMigrations,
		migration,
		queueMigration,
		queueLinkMigration,
		pinnedToolchainMigration,
	]);
	const conversation = createConversationService(store);
	const queue = createQueue(store);
	const dialogue = createDialogueService({ store, conversation, larm, queue });
	const run = await dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: request,
		presentation: "artifact",
		toolchainId,
	});
	const active = [...(over.active ?? Object.keys(entries))];
	const deps = {
		store,
		larm,
		toolchains: {
			catalogInTransaction: () =>
				active.map((id) => ({
					id,
					revisionId: entries[id]!.revisionId,
					runtime: { execution: entries[id]!.execution },
				})),
			cardInTransaction: (_db: unknown, revisionId: string) => {
				const e = Object.values(entries).find(
					(x) => x.revisionId === revisionId,
				);
				return e && e.id !== over.withoutCard ? cardOf(e) : undefined;
			},
		},
	} as unknown as DialogueDeps;
	const input = {
		runId: run.id,
		revision: run.revision,
		messages: [{ role: "user", content: request }],
		currentRequest: { messageIndex: 0, messageId: run.inputMessageId },
		routing: {
			available: [...(over.available ?? active)],
			conversationId: "main",
			utteranceId: null,
			requestId: run.requestId ?? null,
			openQuestions: [],
		},
	} as unknown as GenerateInput;
	const handler = createGenerationHandler(deps, {
		partials: new Map(),
		publish: () => {},
	});
	const execute = () =>
		handler.execute(input, { signal: new AbortController().signal } as never);
	return {
		execute,
		inference: () => inference,
		close: async () => {
			await queue.close(100);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

for (const [id, execution] of [
	["image.create", "image"],
	["music.create", "music-create"],
] as const)
	test(`a run pinned to ${id} starts its specialist from the submit body without any inference call`, async () => {
		const p = await pinned(id);
		try {
			const result = await p.execute();
			expect(result).toMatchObject({
				text: "",
				operation: {
					kind: "toolchain",
					toolchainId: id,
					revisionId: entries[id]!.revisionId,
					functionName: entries[id]!.functionName,
					request,
				},
				selection: {
					decision: "toolchain",
					retrieval: "none",
					toolchainId: id,
					toolchainRevisionId: entries[id]!.revisionId,
					request,
					candidates: [{ toolchainId: id }],
				},
			});
			expect(result.receipt).toBeUndefined();
			expect(result.selection?.candidates).toHaveLength(1);
			expect(entries[id]!.execution).toBe(execution);
			expect(p.inference()).toBe(0);
		} finally {
			await p.close();
		}
	});

for (const [name, id, over] of [
	[
		"a toolchain that is not offered on this host",
		"image.create",
		{ available: ["music.create"] },
	],
	[
		"a toolchain with no active revision",
		"image.create",
		{ active: ["music.create"] },
	],
	[
		"a toolchain whose card cannot be rebuilt",
		"image.create",
		{
			withoutCard: "image.create",
		},
	],
	["a research toolchain", "web.search", {}],
	["a music playback toolchain", "music.play", {}],
] as const)
	test(`${name} fails the pinned run with toolchain_unavailable and no fallback`, async () => {
		const p = await pinned(id, over);
		try {
			await expect(p.execute()).rejects.toThrow("toolchain_unavailable");
			expect(p.inference()).toBe(0);
		} finally {
			await p.close();
		}
	});
