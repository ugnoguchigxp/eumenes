import { lazy, Suspense } from "react";
import type { EumenesClient } from "../../../client";
import { ErrorBoundary } from "../components/ErrorBoundary";

// Settings and its panels load on demand so the conversation screen stays small.
const SettingsPage = lazy(() =>
	import("../domains/settings/SettingsPage").then((m) => ({
		default: m.SettingsPage,
	})),
);
const ServiceTestsPanel = lazy(() =>
	import("../domains/service-tests").then((m) => ({
		default: m.ServiceTestsPanel,
	})),
);
const ToolchainHistoryPanel = lazy(() =>
	import("../domains/toolchain-history").then((m) => ({
		default: m.ToolchainHistoryPanel,
	})),
);
const WorldPanel = lazy(() =>
	import("../components/domains/world/WorldPanel").then((m) => ({
		default: m.WorldPanel,
	})),
);
const loadingFallback = <output>読み込み中…</output>;

export function SettingsContent({
	client,
	onDirty,
	onSaved,
}: {
	client: EumenesClient;
	onDirty: (dirty: boolean) => void;
	onSaved: () => void;
}) {
	return (
		<Suspense fallback={loadingFallback}>
			<SettingsPage
				renderServiceTests={(disabled) => (
					<Suspense fallback={loadingFallback}>
						<ServiceTestsPanel client={client} disabled={disabled} />
					</Suspense>
				)}
				renderWorld={() => (
					<ErrorBoundary label="world">
						<Suspense fallback={loadingFallback}>
							<WorldPanel client={client} />
						</Suspense>
					</ErrorBoundary>
				)}
				renderToolchainHistory={() => (
					<Suspense fallback={loadingFallback}>
						<ToolchainHistoryPanel client={client} />
					</Suspense>
				)}
				client={client}
				onDirty={onDirty}
				onSaved={onSaved}
			/>
		</Suspense>
	);
}
