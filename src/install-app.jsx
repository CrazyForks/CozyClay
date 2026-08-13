import { useEffect, useState } from "react";
import { PWA_UPDATE_EVENT } from "./pwa.js";
import { ko } from "./locale.js";

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
				{updateRegistration ? ko("Update app", "앱 업데이트") : ko("Install app", "앱 설치")}
			</button>

			{showHelp && !updateRegistration && (
				<div className="pwa-install-panel" role="dialog" aria-label={ko("Install Cozy Clay", "Cozy Clay 설치")}>
					<span className="pwa-install-kicker">{ko("Install once, open instantly", "한 번 설치하면 바로 실행")}</span>
					<strong>{ko("Use Cozy Clay like any other app.", "Cozy Clay를 다른 앱처럼 사용하세요.")}</strong>
					{isiOS ? (
						<p>{ko("In Safari, tap Share, then choose ", "Safari에서 공유를 누른 다음 ")}<b>{ko("Add to Home Screen", "홈 화면에 추가")}</b>{ko(".", "를 선택하세요.")}</p>
					) : (
						<p>{ko("In Chrome or Edge, choose ", "Chrome이나 Edge의 주소창 또는 브라우저 메뉴에서 ")}<b>{ko("Install Cozy Clay", "Cozy Clay 설치")}</b>{ko(" from the address bar or browser menu.", "를 선택하세요.")}</p>
					)}
					<small>{ko("Your scenes are stored only on this device, and the app keeps working offline after its first load.", "만든 장면은 이 기기에만 저장되며, 앱을 한 번 불러온 뒤에는 오프라인에서도 계속 사용할 수 있어요.")}</small>
					<button type="button" className="pwa-install-close" onClick={() => setShowHelp(false)}>
						{ko("Got it", "확인")}
					</button>
				</div>
			)}
		</div>
	);
}
