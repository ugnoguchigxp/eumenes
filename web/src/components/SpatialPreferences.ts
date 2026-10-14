import type { Settings } from "../../../api/domains/settings/contracts";
import {
	defaultSpatialOptions,
	type SpatialOptions,
} from "../domains/background/options";

/** Composition boundary: settings owns persistence; background owns no API or credentials. */
export function spatialPreferences(
	general?: Settings["general"],
): SpatialOptions {
	return {
		scatter: general?.spatialScatter ?? defaultSpatialOptions.scatter,
		core: general?.spatialCore ?? defaultSpatialOptions.core,
		focusCore: general?.spatialFocusCore ?? defaultSpatialOptions.focusCore,
		pointSize: general?.spatialPointSize ?? defaultSpatialOptions.pointSize,
		opacity: general?.spatialOpacity ?? defaultSpatialOptions.opacity,
		orbitSpeed: general?.spatialOrbitSpeed ?? defaultSpatialOptions.orbitSpeed,
		spinSpeed: general?.spatialSpinSpeed ?? defaultSpatialOptions.spinSpeed,
		paused: general?.spatialPaused ?? defaultSpatialOptions.paused,
		reducedMotion:
			general?.spatialReducedMotion ?? defaultSpatialOptions.reducedMotion,
		view: general?.spatialView ?? defaultSpatialOptions.view,
		demoEnabled:
			general?.spatialDemoEnabled ?? defaultSpatialOptions.demoEnabled,
		demoHealth: general?.spatialDemoHealth ?? defaultSpatialOptions.demoHealth,
		demoActivity:
			general?.spatialDemoActivity ?? defaultSpatialOptions.demoActivity,
		demoUtilization:
			general?.spatialDemoUtilization ?? defaultSpatialOptions.demoUtilization,
		demoStrength:
			general?.spatialDemoStrength ?? defaultSpatialOptions.demoStrength,
		demoStale: general?.spatialDemoStale ?? defaultSpatialOptions.demoStale,
	};
}
