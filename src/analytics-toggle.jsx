import { useState } from "react";
import { getAnalyticsOptOut, setAnalyticsOptOut } from "./analytics.js";
import { ko } from "./locale.js";

export default function AnalyticsToggle() {
	const [optedOut, setOptedOut] = useState(getAnalyticsOptOut);
	const label = optedOut ? ko("Analytics off", "측정 끔") : ko("Analytics on", "측정 켬");
	const nextLabel = optedOut ? ko("Turn analytics on", "측정 켜기") : ko("Turn analytics off", "측정 끄기");
	return (
		<button
			type="button"
			className="locale-toggle"
			title={nextLabel}
			aria-label={nextLabel}
			onClick={() => {
				const next = !optedOut;
				setAnalyticsOptOut(next);
				setOptedOut(next);
			}}
		>
			{label}
		</button>
	);
}
