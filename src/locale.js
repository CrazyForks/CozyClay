// CozyClay UI locale. English is the default; Korean is opt-in.
//
// Resolution order: an explicit choice saved in localStorage wins, otherwise
// the browser language picks Korean for ko-* and English for everything
// else. The locale is fixed for the lifetime of the page — every label goes
// through ko() at render time, so switching just reloads.
const KEY = "cozyclay.locale";

function stored() {
	try {
		const value = localStorage.getItem(KEY);
		return value === "ko" || value === "en" ? value : null;
	} catch {
		return null;
	}
}

function detected() {
	try {
		// Browser only: node also exposes navigator.language (the machine's
		// ICU locale), which would make tests and tooling locale-dependent.
		if (typeof window === "undefined") return "en";
		return (navigator.language || "").toLowerCase().startsWith("ko") ? "ko" : "en";
	} catch {
		return "en";
	}
}

export const LOCALE = stored() ?? detected();
export const isKo = LOCALE === "ko";

/** Pick the label for the active locale: ko("Frame", "프레임"). */
export function ko(en, koText) {
	return isKo ? koText : en;
}

export function setLocale(next) {
	if (next !== "ko" && next !== "en") return;
	try {
		localStorage.setItem(KEY, next);
	} catch {
		// Private mode without storage: the toggle still works for this load.
	}
	window.location.reload();
}
