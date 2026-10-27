export { createBrowser, type BrowserService } from "./service";
export { registerBrowser } from "./controller";
export { createBrowserResourceAdapter } from "./service/resource-adapter";
export { migrations } from "./repository";
export { BrowserApprovalRequired } from "./contracts";
export type {
	ApprovalRequest,
	ApprovedItem,
	BrowserCompletion,
	CaptureStart,
	CaptureView,
	ConnectionView,
	Effect,
	InputValueApproval,
	Observation,
	OperationOutcome,
	PageOperation,
	TabView,
	TaskStepInput,
	TaskStepOutcome,
	TaskView,
} from "./contracts";
export type {
	StartCaptureInput,
	StartedTask,
	StartTaskInput,
	TaskApi,
	TaskStepRunner,
} from "./service";
export type * from "./contracts/ports";
export { BrowserDriverError } from "./contracts/ports";
export { createMcpBrowserDriver } from "./adapters/mcp-driver";
export { createWebpEncoder } from "./adapters/webp-encoder";
export { createCaptureFiles } from "./adapters/capture-files";
export { createHostResolver } from "./adapters/host-resolver";
export { createExecutablePicker } from "./adapters/executable-picker";

export type {
	HistoryAction,
	HistoryCatalogEntry,
	HistoryDelete,
	HistoryDetail,
	HistoryForOperator,
	HistoryReplay,
	HistorySummary,
} from "./contracts/history";
export { historyDelete } from "./contracts/history";
export type {
	ScriptView,
	ScriptPublish,
	ScriptBinding,
} from "./contracts/script";

export type { CollectedPage } from "./service/research-collection";
