import { dirname, join, resolve } from "node:path";
import {
	createBrowser,
	createCaptureFiles,
	createExecutablePicker,
	createMcpBrowserDriver,
	createWebpEncoder,
	type BrowserCompletion,
	type BrowserDriver,
	type BrowserService,
} from "../../domains/browser";
import type { ConversationService } from "../../domains/conversation";
import type { Config } from "../../infrastructure/config";
import type { Core } from "../server-core";
import { createSavedPathDriver } from "./browser-driver";
import type { BrowserRequests } from "./browser-adapter";
import { registerBrowserEffects } from "./browser-effects";
import { createTaskRunner, type TaskRunnerPorts } from "./browser-task-runner";

/** MCP output and captures live under the data directory next to the database, in two managed folders. */
export function browserDirectories(dbPath: string) {
	const base = join(dirname(resolve(dbPath)), "browser");
	return { outputDir: join(base, "mcp"), captureDir: join(base, "captures") };
}

/** A finished capture is reported into the conversation that asked for it, in the same transaction. */
export function browserAnnouncement(conversation: ConversationService) {
	return (
		tx: Parameters<ConversationService["appendInTransaction"]>[0],
		notice: BrowserCompletion,
	) => {
		const id = `browser-notice:${notice.id}`;
		if (conversation.messageInTransaction(tx, id)) return;
		conversation.appendInTransaction(tx, {
			id,
			conversationId: notice.conversationId,
			role: "assistant",
			text: notice.message,
			createdAt: notice.at,
			runId: null,
		});
	};
}

/** What the user said, read from the saved conversation message a conversation operation came from. */
export function browserRequests(
	conversation: ConversationService,
): BrowserRequests {
	return {
		userMessageInTransaction(db, messageId) {
			const found = conversation.messageInTransaction(db, messageId)?.message;
			return found?.role === "user" && found.text ? found.text : null;
		},
	};
}

/**
 * Brave tab control, local captures and page-operation tasks. The driver is created at each connection with the Brave
 * path saved then; the web origin is the only private address a tab may be sent to. Built before
 * the toolchain, whose adapter is registered there.
 */
export function buildBrowser(
	config: Config,
	deps: {
		core: Pick<Core, "store" | "queue">;
		settings?: Pick<
			import("../../domains/settings").SettingsService,
			"browserBridge" | "browserBridgeCredential" | "onBrowserBridgeChange"
		>;
		conversation: ConversationService;
		/**
		 * The model calls and capability registry of page-operation tasks. Both are assembled after the browser, so
		 * `capabilities` is read when a task starts. Without `inference` tasks cannot be started.
		 */
		inference?: TaskRunnerPorts["inference"];
		capabilities?: TaskRunnerPorts["capabilities"];
		/** Replaces the MCP driver (tests only). */
		createDriver?: (executablePath: string | undefined) => BrowserDriver;
	},
) {
	const { store, queue } = deps.core;
	const { outputDir, captureDir } = browserDirectories(config.dbPath);
	let service: BrowserService | undefined;
	const driver = createSavedPathDriver({
		executablePath: () => service?.setting.get().executablePath || undefined,
		create:
			deps.createDriver ??
			((executablePath) =>
				createMcpBrowserDriver({
					executablePath,
					outputDir,
					extensionToken: deps.settings?.browserBridgeCredential() ?? undefined,
				})),
	});
	service = createBrowser({
		store,
		queue,
		canAutoConnect: () => {
			const s = deps.settings?.browserBridge();
			return !!s?.enabled && s.configured && s.available;
		},
		credentialRevision: () => deps.settings?.browserBridge().revision ?? 0,
		driver,
		encoder: createWebpEncoder(),
		files: createCaptureFiles({ directory: captureDir }),
		webOrigins: [config.origin],
		pickExecutable: createExecutablePicker(),
		announceInTransaction: browserAnnouncement(deps.conversation),
		...(deps.inference
			? {
					runTaskStep: createTaskRunner({
						store,
						inference: deps.inference,
						capabilities: deps.capabilities ?? (() => null),
						taskExecutionSourceInTransaction: (db, frozen) =>
							service?.taskExecutionSourceInTransaction(db, frozen) ?? null,
					}),
				}
			: {}),
	});
	const unsubscribe = deps.settings?.onBrowserBridgeChange(async () => {
		await service!.disconnect();
	});
	const effects = registerBrowserEffects({ queue, service });
	return {
		service,
		effects,
		requests: browserRequests(deps.conversation),
		/** Stops the MCP child when the process goes away; the user's browser is left as it is. */
		close: () => {
			unsubscribe?.();
			return driver.close();
		},
	};
}
export type BrowserAssembly = ReturnType<typeof buildBrowser>;
