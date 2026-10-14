import { createWebAdapterRegistry } from "../domains/toolchain-artifacts";
import {
	recordsWebAdapter,
	settingsWebAdapter,
} from "../domains/settings-data";
import { timerWebAdapter } from "../domains/timers/toolchain-adapter";
import { musicScreenWebAdapter } from "../domains/music/toolchain-adapter";

/** Every domain adapter the common artifact host can render. Adding a domain adds one line. */
export const toolchainWebAdapters = createWebAdapterRegistry([
	timerWebAdapter,
	musicScreenWebAdapter,
	settingsWebAdapter,
	recordsWebAdapter,
]);
