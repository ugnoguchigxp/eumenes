import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "../design-system";

type Props = { label: string; children: ReactNode; onReset?: () => void };
type State = { failed: boolean };

/** Keeps a render failure inside its own region; only the label and error name are logged. */
export class ErrorBoundary extends Component<Props, State> {
	state: State = { failed: false };

	static getDerivedStateFromError(): State {
		return { failed: true };
	}

	componentDidCatch(error: Error, _info: ErrorInfo) {
		console.error("ui.render_failed", {
			label: this.props.label,
			name: error.name,
		});
	}

	private reset = () => {
		this.setState({ failed: false });
		this.props.onReset?.();
	};

	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div className="error-boundary" role="alert">
				<p>表示中にエラーが発生しました。</p>
				<Button type="button" variant="secondary" onClick={this.reset}>
					再表示
				</Button>
				<Button
					type="button"
					variant="secondary"
					onClick={() => window.location.reload()}
				>
					ページを再読み込み
				</Button>
			</div>
		);
	}
}
