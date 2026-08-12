import { useEffect, useState } from "react";
import { PWA_UPDATE_EVENT } from "./pwa.js";

function runsStandalone() {
	return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

export default function InstallApp() {
	const [installPrompt, setInstallPrompt] = useState(null);
	const [installed, setInstalled] = useState(runsStandalone);
	const [showHelp, setShowHelp] = useState(false);
	const [updateRegistration, setUpdateRegistration] = useState(null);
	const isiOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

	useEffect(() => {
		function offerInstall(event) {
			event.preventDefault();
			setInstallPrompt(event);
		}

		function markInstalled() {
			setInstalled(true);
			setInstallPrompt(null);
			setShowHelp(false);
		}

		function offerUpdate(event) {
			setUpdateRegistration(event.detail);
		}

		window.addEventListener("beforeinstallprompt", offerInstall);
		window.addEventListener("appinstalled", markInstalled);
		window.addEventListener(PWA_UPDATE_EVENT, offerUpdate);
		return () => {
			window.removeEventListener("beforeinstallprompt", offerInstall);
			window.removeEventListener("appinstalled", markInstalled);
			window.removeEventListener(PWA_UPDATE_EVENT, offerUpdate);
		};
	}, []);

	useEffect(() => {
		if (!showHelp) return undefined;
		function closeOnEscape(event) {
			if (event.key === "Escape") setShowHelp(false);
		}
		window.addEventListener("keydown", closeOnEscape);
		return () => window.removeEventListener("keydown", closeOnEscape);
	}, [showHelp]);

	async function install() {
		if (!installPrompt) {
			setShowHelp(true);
			return;
		}
		await installPrompt.prompt();
		const choice = await installPrompt.userChoice;
		setInstallPrompt(null);
		if (choice.outcome !== "accepted") setShowHelp(true);
	}

	function update() {
		const worker = updateRegistration?.waiting;
		if (!worker) return;
		worker.postMessage({ type: "SKIP_WAITING" });
	}

	if (installed && !updateRegistration) return null;

	return (
		<div className="pwa-actions">
			<button
				type="button"
				className={updateRegistration ? "pwa-install-button update-ready" : "pwa-install-button"}
				onClick={updateRegistration ? update : install}
			>
				<span aria-hidden="true">{updateRegistration ? "↻" : "↓"}</span>
				{updateRegistration ? "Update app" : "Install app"}
			</button>

			{showHelp && !updateRegistration && (
				<div className="pwa-install-panel" role="dialog" aria-label="Install Cozy Clay">
					<span className="pwa-install-kicker">One-click studio</span>
					<strong>Keep Cozy Clay with your other apps.</strong>
					{isiOS ? (
						<p>In Safari, tap Share, then choose <b>Add to Home Screen</b>.</p>
					) : (
						<p>In Chrome or Edge, choose <b>Install Cozy Clay</b> from the address bar or browser menu.</p>
					)}
					<small>Your shots stay on this device and the app keeps working after it has loaded once.</small>
					<button type="button" className="pwa-install-close" onClick={() => setShowHelp(false)}>
						Got it
					</button>
				</div>
			)}
		</div>
	);
}
