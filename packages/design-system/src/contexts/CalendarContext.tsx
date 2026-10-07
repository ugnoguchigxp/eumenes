import React, { createContext, useContext, useMemo } from "react";

export type SecondaryCalendar =
	| "none"
	| "japanese"
	| "buddhist"
	| "islamic"
	| "chinese";

export type CalendarSystem =
	| "gregorian"
	| "japanese"
	| "buddhist"
	| "islamic"
	| "chinese";

interface CalendarContextType {
	secondaryCalendar: SecondaryCalendar;
	preferLocalCalendar: boolean;
	setSecondaryCalendar: (calendar: SecondaryCalendar) => void;
	setPreferLocalCalendar: (prefer: boolean) => void;
}

const CalendarContext = createContext<CalendarContextType | undefined>(
	undefined,
);

interface CalendarProviderProps {
	children: React.ReactNode;
	defaultSecondaryCalendar?: SecondaryCalendar;
	defaultPreferLocalCalendar?: boolean;
}

export const CalendarProvider: React.FC<CalendarProviderProps> = ({
	children,
	defaultSecondaryCalendar = "none",
	defaultPreferLocalCalendar = false,
}) => {
	const [secondaryCalendar, setSecondaryCalendar] =
		React.useState<SecondaryCalendar>(defaultSecondaryCalendar);
	const [preferLocalCalendar, setPreferLocalCalendar] = React.useState<boolean>(
		defaultPreferLocalCalendar,
	);

	const value = useMemo(
		() => ({
			secondaryCalendar,
			preferLocalCalendar,
			setSecondaryCalendar,
			setPreferLocalCalendar,
		}),
		[secondaryCalendar, preferLocalCalendar],
	);

	return (
		<CalendarContext.Provider value={value}>
			{children}
		</CalendarContext.Provider>
	);
};

export const useCalendarSettings = (): CalendarContextType => {
	const context = useContext(CalendarContext);
	if (!context) {
		// Fallback to default values if used outside provider,
		// or throw error depending on strictness.
		// For backward compatibility/ease of use, we can return defaults.
		return {
			secondaryCalendar: "none",
			preferLocalCalendar: false,
			setSecondaryCalendar: () => {},
			setPreferLocalCalendar: () => {},
		};
	}
	return context;
};
