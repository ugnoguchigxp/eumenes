export { createBrowser, type BrowserService } from "./service";
export { registerBrowser } from "./controller";
export { createBrowserResourceAdapter } from "./service/resource-adapter";
export { migrations } from "./repository";
export { BrowserApprovalRequired } from "./contracts";
export type {
	ApprovalRequest,
	ApprovedItem,
	BrowserCompletion,
	CaptureView,
	Effect,
	InputValueApproval,
	Observation,
	OperationOutcome,
	TabView,
	TaskStepInput,
	TaskStepOutcome,
	TaskView,
} from "./contracts";
export type { TaskApi, TaskStepRunner } from "./service";
export type * from "./contracts/ports";
export { BrowserDriverError } from "./contracts/ports";
export { createMcpBrowserDriver } from "./adapters/mcp-driver";
export { createWebpEncoder } from "./adapters/webp-encoder";
export { createCaptureFiles } from "./adapters/capture-files";
export { createExecutablePicker } from "./adapters/executable-picker";
