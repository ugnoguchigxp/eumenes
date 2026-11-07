import { Save } from "lucide-react";
import type React from "react";
import { ActionButton, type ActionButtonProps } from "./ActionButton";

/**
 * 保存ボタン
 */
export const SaveButton: React.FC<ActionButtonProps> = ({
	label = "保存",
	icon = Save,
	variant = "default",
	...props
}) => {
	return (
		<ActionButton label={label} icon={icon} variant={variant} {...props} />
	);
};

SaveButton.displayName = "SaveButton";

/** The save action with a consistent icon-only presentation and accessible label. */
export const SaveIconButton: React.FC<
	Omit<ActionButtonProps, "iconOnly" | "alwaysFull">
> = (props) => <SaveButton {...props} iconOnly />;
SaveIconButton.displayName = "SaveIconButton";
