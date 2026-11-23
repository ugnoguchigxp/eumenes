import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { fixture } from "../api/application/app-development/app-development.fixture";
import {
	readingNotes,
	readingRequest,
} from "../api/application/app-development/app-records.fixture";
import { createGitObservation } from "../api/domains/git-observation";

const h = await fixture({
	request: readingRequest,
	draft: readingNotes,
	git: createGitObservation("/unused"),
	specialist: (messages) => {
		const document =
			/CURRENT_DOCUMENT path=definition\.json revision=(\d+)/.exec(
				messages.map((message) => message.content).join("\n"),
			);
		return {
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision: Number(document?.[1] ?? 0),
				title: "読書メモ",
				content: readingNotes,
			},
			text: "下書きを作りました。確認して保存できます。",
		};
	},
});
let failPublication = false,
	publicationFailures = 0;
const publish = h.appRuntime!.adapter.finishSave;
h.appRuntime!.adapter.finishSave = (...args) => {
	if (failPublication) {
		failPublication = false;
		publicationFailures++;
		throw new Error("app_storage_publication_fixture");
	}
	return publish(...args);
};
const path = join(h.dir, "app-storage");
writeFileSync(path, "temporary storage fault");
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: (request) => {
		if (
			new URL(request.url).pathname === "/__fixture/app-development" &&
			request.method === "GET"
		)
			return Response.json({
				fixture: "app-development",
				version: 1,
				publicationFailures,
			});
		if (
			new URL(request.url).pathname === "/__fixture/release-storage" &&
			request.method === "POST"
		) {
			rmSync(path);
			return new Response(null, { status: 204 });
		}
		if (
			new URL(request.url).pathname === "/__fixture/fail-next-publication" &&
			request.method === "POST"
		) {
			failPublication = true;
			return new Response(null, { status: 204 });
		}
		return h.app.fetch(request);
	},
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
