import { createWebAdapterRegistry } from "../domains/toolchain-artifacts";
import {
	recordsWebAdapter,
	settingsWebAdapter,
} from "../domains/settings-data";
import { timerWebAdapter } from "../domains/timers/toolchain-adapter";
import { musicScreenWebAdapter } from "../domains/music/toolchain-adapter";
import { imageScreenWebAdapter } from "../domains/image/toolchain-adapter";
import { serviceTestsWebAdapter } from "../domains/service-tests/toolchain-adapter";

/** Every domain adapter the common artifact host can render. Adding a domain adds one line. */
export const toolchainWebAdapters = createWebAdapterRegistry([
	timerWebAdapter,
	musicScreenWebAdapter,
	imageScreenWebAdapter,
	settingsWebAdapter,
	recordsWebAdapter,
	serviceTestsWebAdapter,
]);
