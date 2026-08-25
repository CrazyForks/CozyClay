import { Component } from "react";
import { isKo } from "./locale.js";

/**
 * The studio's last-ditch net: any render-time throw in the tree used to
 * blank the whole page (issue #63). This boundary keeps a named, recoverable
 * error screen instead — the autosaved scene survives in localStorage, so
 * "reload" is a real recovery path, not a shrug.
 */
export default class AppErrorBoundary extends Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error };
	}
	componentDidCatch(error, info) {
		console.error("[cozyclay] studio crash", error, info);
	}
	render() {
		if (this.state.error) {
			const message = String(this.state.error?.message ?? this.state.error ?? "unknown");
			return (
				<div className="crash-screen" role="alert">
					<div className="crash-card">
						<h1>{isKo ? "문제가 생겼어요" : "Something went wrong"}</h1>
						<p>
							{isKo
								? "작업은 브라우저에 자동 저장돼 있습니다. 새로고침하면 이어서 할 수 있어요."
								: "Your work is autosaved in the browser. Reloading picks it back up."}
						</p>
						<code>{message.slice(0, 300)}</code>
						<button type="button" onClick={() => window.location.reload()}>
							{isKo ? "새로고침" : "Reload"}
						</button>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}
