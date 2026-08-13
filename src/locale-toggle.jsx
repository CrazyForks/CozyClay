import { LOCALE, setLocale } from "./locale.js";

// One small header button: shows the language you would switch TO, so it
// reads as an action ("한국어" on the English UI, "EN" on the Korean one).
export default function LocaleToggle() {
	const next = LOCALE === "ko" ? "en" : "ko";
	return (
		<button
			type="button"
			className="locale-toggle"
			title={LOCALE === "ko" ? "Switch to English" : "한국어로 전환"}
			aria-label={LOCALE === "ko" ? "Switch to English" : "한국어로 전환"}
			onClick={() => setLocale(next)}
		>
			{next === "ko" ? "한국어" : "EN"}
		</button>
	);
}
