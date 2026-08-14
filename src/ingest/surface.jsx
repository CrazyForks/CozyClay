// surface.jsx — the ingest surface UI (plan §13 commit U2).
//
// The child side of the cross-origin boundary: this component renders the
// pipeline flow (pick footage, preflight, select take, calibrate, extract,
// review, publish) over the state machine (state.js), drives the machine
// with the events it owns, renders the host's NDJSON extract progress
// stream itself, and lands the finished take through the command adapter
// (adapter.js).
//
// What it deliberately does NOT render: an unavailable state. §11.6 puts
// that in the parent — an unreachable child cannot draw its own error — so
// this tree only ever renders states a live child can actually be in. The
// machine's dead-end states (no-go, calibration-blocked) are rendered as
// terminal panels: the §10.4/§9 gates make them unreachable-from by
// construction, and the only way out of a terminal state is a fresh
// surface session (the parent's Retry remounts the child).
//
// The machine and the adapter are created once in main.jsx and passed in;
// StrictMode double-rendering therefore cannot stack message listeners,
// ready handshakes or landings — the entry owns the singletons, this file
// owns the rendering and the orchestration.
//
// Measurement seams: Stage A ships the pipeline's decision functions, not
// the footage/camera measurement hardware, so the preflight signal set and
// the calibration verdict enter through the session store (the same store
// the browser suite drives). A stage whose input has not been measured
// renders "awaiting measurement" and blocks its advance button — the
// machine's gates stay the authority either way.

import { useEffect, useMemo, useRef, useState } from "react";
import { evaluateFootage, preflightGate, WARN_REASONS } from "./footage-policy.js";

// The seven plan stages (§14.1), in order. The machine's states map onto
// them: idle -> pick footage; preflight includes the no-go dead end;
// calibrate includes the calibration-blocked dead end; published is the
// publish stage's terminal outcome.
const STAGE_ORDER = ["pick-footage", "preflight", "select-take", "calibrate", "extract", "review", "publish"];
const STAGE_TITLES = {
	"pick-footage": "Pick footage",
	preflight: "Preflight",
	"select-take": "Select take",
	calibrate: "Calibrate",
	extract: "Extract",
	review: "Review",
	publish: "Publish",
};

const MACHINE_STAGE = {
	idle: "pick-footage",
	preflight: "preflight",
	"no-go": "preflight",
	"select-take": "select-take",
	calibrate: "calibrate",
	"calibration-blocked": "calibrate",
	extract: "extract",
	review: "review",
	published: "publish",
};

// The §5 payload the surface lands: rotationDeg 0, fps 20, equal frame
// counts, and the nine provenance keys — the exact clauses the parent door
// (src/surface-host.js validateTakePayload) rejects by name. Artifact
// fields are PATHS on the app's own origin (§12.3), never URLs. The
// requestId is minted here so the same payload object the machine stores
// is the same object the adapter sends — the parent caches under that id.
function buildTakePayload(sessionValue) {
	const p = sessionValue.provenance;
	const provenance = {
		command: "cozyclay ingest",
		sourceUrl: p.sourceUrl,
		licence: p.licence,
		sourceSha256: p.sourceSha256,
		trimStartS: p.trimStartS,
		trimEndS: p.trimEndS,
		gvhmrCommit: p.gvhmrCommit,
		weightsSha256: p.weightsSha256,
		annotationPath: sessionValue.artifactPaths.annotation,
	};
	const clip = (path) => ({
		rotationDeg: 0,
		fps: 20,
		frames: sessionValue.frames,
		artifactPath: path,
		provenance,
	});
	return { requestId: crypto.randomUUID(), a: clip(sessionValue.artifactPaths.a), b: clip(sessionValue.artifactPaths.b) };
}

export function Surface({ machine, adapter, session }) {
	const [state, setState] = useState(machine.state());
	const [sessionValue, setSessionValue] = useState(session.value);
	const [extract, setExtract] = useState({ running: false, lines: [], done: null, error: null });
	const [ack, setAck] = useState(null);
	const [landing, setLanding] = useState(false);
	const [refusal, setRefusal] = useState(null);
	const fileInputRef = useRef(null);

	// The session store lives in main.jsx; this subscription mirrors its
	// value into render state. StrictMode mounts the effect twice; the
	// subscribe/unsubscribe pair leaves exactly one live subscription.
	useEffect(() => session.subscribe(setSessionValue), [session]);

	const dispatch = (event, payload) => {
		const result = machine.dispatch(event, payload);
		setState(machine.state());
		setRefusal(result.ok ? null : result.reason ?? null);
		return result;
	};

	const machineReport = machine.report();

	// --- pick footage --------------------------------------------------------
	const stageFootage = async () => {
		const file = fileInputRef.current?.files?.[0];
		if (!file) return;
		// The host's /ingest/stage takes the raw bytes and answers with an
		// opaque stage id; the UI never sees a path (§12.3).
		const res = await fetch("/ingest/stage", { method: "POST", body: file });
		if (!res.ok) throw new Error(`stage-http-${res.status}`);
		const body = await res.json();
		session.set({ filename: file.name, stageId: body.stageId });
		dispatch("pick-footage", { filename: file.name, stageId: body.stageId });
	};

	// --- preflight -----------------------------------------------------------
	const report = useMemo(() => {
		if (!sessionValue.signals) return null;
		try {
			return evaluateFootage(sessionValue.signals);
		} catch (err) {
			return { error: err.message };
		}
	}, [sessionValue.signals]);
	const [ackedWarnings, setAckedWarnings] = useState([]);
	const warnReasons = useMemo(() => (report?.reasons ?? []).filter((code) => WARN_REASONS.includes(code)), [report]);
	const gate = report && !report.error ? preflightGate(report, ackedWarnings) : null;
	const toggleWarn = (code) => {
		setAckedWarnings((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
	};
	const submitPreflight = () => {
		if (!report || report.error) return;
		dispatch("preflight-report", { report, acknowledgedWarnings: ackedWarnings });
	};

	// --- extract -------------------------------------------------------------
	// The host answers /ingest/extract with an NDJSON stream; the surface
	// renders that progress itself — log lines as they arrive, then the
	// done record. A non-zero done code stays on the stage with the error.
	// The take payload is built at completion: the review and the publish
	// door operate on the machine's stored take, so the payload contract
	// (frames, artifact paths, provenance) must be complete before the run.
	const payloadReady = Boolean(
		sessionValue.frames &&
			sessionValue.artifactPaths.a &&
			sessionValue.artifactPaths.b &&
			sessionValue.artifactPaths.annotation &&
			sessionValue.provenance.sourceUrl &&
			sessionValue.provenance.licence,
	);
	const runExtract = async () => {
		if (extract.running || !sessionValue.stageId) return;
		setExtract({ running: true, lines: [], done: null, error: null });
		try {
			const res = await fetch("/ingest/extract", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ stageId: sessionValue.stageId }),
			});
			if (!res.ok || !res.body) throw new Error(`extract-http-${res.status}`);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let doneRecord = null;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (!line.trim()) continue;
					let record;
					try {
						record = JSON.parse(line);
					} catch {
						continue; // a partial tail is not a record; the next chunk completes it
					}
					if (record.type === "log") {
						setExtract((prev) => ({ ...prev, lines: [...prev.lines, { stream: record.stream ?? "stdout", line: record.line }] }));
					} else if (record.type === "done") {
						doneRecord = record;
					}
				}
			}
			if (doneRecord?.code !== 0) throw new Error(`extract-failed-${doneRecord?.code ?? "no-done"}`);
			setExtract((prev) => ({ ...prev, running: false, done: doneRecord }));
			if (!payloadReady) {
				setExtract((prev) => ({ ...prev, error: "take-metadata-missing" }));
				return;
			}
			dispatch("extraction-complete", buildTakePayload(sessionValue));
		} catch (err) {
			setExtract((prev) => ({ ...prev, running: false, error: err.message }));
		}
	};

	// --- publish -------------------------------------------------------------
	// The machine's publish event is the child-side §5 door: the stored
	// take must pass validateTakePayload before any bytes leave. Only then
	// does the adapter send the land; the ack (ok or a named rejection) is
	// rendered, and a rejected landing stays retryable with the same take.
	const land = async () => {
		if (landing) return;
		const take = machine.report().take;
		if (!take) return;
		// The §5 door runs once: from review the machine's publish event
		// validates the stored take and advances; a retry from the
		// published state skips the (now impossible) second dispatch and
		// re-sends the SAME take — the parent's session table dedupes the
		// identical requestId, so a retry can never land twice.
		if (machine.state() !== "published") {
			const result = dispatch("publish");
			if (!result.ok) return;
		}
		setLanding(true);
		setAck(null);
		try {
			const ackPayload = await adapter.sendLand(take);
			setAck({ status: ackPayload?.status ?? "ok" });
		} catch (err) {
			setAck({ status: "rejected", code: err.message });
		} finally {
			setLanding(false);
		}
	};

	const stage = MACHINE_STAGE[state] ?? "pick-footage";
	const stageChips = STAGE_ORDER.map((name) => (
		<li
			key={name}
			className={`cclay-stage-chip${name === stage ? " is-active" : ""}${STAGE_ORDER.indexOf(name) < STAGE_ORDER.indexOf(stage) ? " is-done" : ""}`}
		>
			{STAGE_TITLES[name]}
		</li>
	));

	return (
		<div className="cclay-surface" data-surface-root>
			<header className="cclay-header">
				<h1 className="cclay-title">Footage ingest</h1>
				<span className="cclay-stage-label">{STAGE_TITLES[stage]}</span>
			</header>
			<ul className="cclay-stages">{stageChips}</ul>

			{state === "idle" && (
				<div className="cclay-panel">
					<h2>Pick footage</h2>
					<p className="cclay-meta">One locked-off, cut-free take; exactly two fighters.</p>
					<div className="cclay-file-row">
						<input ref={fileInputRef} type="file" accept="video/*" data-action="footage-file" />
						<button type="button" className="cclay-button is-primary" data-action="stage-footage" onClick={stageFootage}>
							Stage footage
						</button>
					</div>
					{sessionValue.filename && (
						<p className="cclay-meta">
							staged: {sessionValue.filename} ({sessionValue.stageId})
						</p>
					)}
				</div>
			)}

			{state === "preflight" && (
				<div className="cclay-panel">
					<h2>Preflight</h2>
					{report?.error ? (
						<div className="cclay-error">{report.error}</div>
					) : report ? (
						<>
							<span className={`cclay-verdict is-${report.verdict}`}>{report.verdict}</span>
							<ul className="cclay-reasons">
								{report.reasons.map((code) => (
									<li key={code} className={`cclay-reason is-${WARN_REASONS.includes(code) ? "warn" : "no-go"}`}>
										{code}
									</li>
								))}
							</ul>
							{warnReasons.length > 0 && (
								<ul className="cclay-warn-list">
									{warnReasons.map((code) => (
										<li key={code}>
											<label>
												<input type="checkbox" checked={ackedWarnings.includes(code)} onChange={() => toggleWarn(code)} />
												acknowledge {code}
											</label>
										</li>
									))}
								</ul>
							)}
							{refusal === "verdict-warn" && <div className="cclay-error">Warn verdict: §10.4 requires the deinterlace chain and a fresh preflight report — re-preflight is the only path.</div>}
							{refusal === "warnings-unacknowledged" && <div className="cclay-error">Every warn code must be acknowledged before this report can leave preflight.</div>}
							<div className="cclay-actions">
								<button type="button" className="cclay-button is-primary" data-action="continue-preflight" disabled={!gate?.allowed} onClick={submitPreflight}>
									Continue
								</button>
							</div>
						</>
					) : (
						<p className="cclay-meta">Awaiting preflight measurement.</p>
					)}
				</div>
			)}

			{state === "no-go" && (
				<div className="cclay-panel">
					<h2>Footage rejected</h2>
					<span className="cclay-verdict is-no-go">no-go</span>
					<ul className="cclay-reasons">
						{(machineReport.footageReport?.reasons ?? []).map((code) => (
							<li key={code} className="cclay-reason is-no-go">
								{code}
							</li>
						))}
					</ul>
					<p className="cclay-meta">The §10.4 gates have no path out of this state — start a fresh surface session for new footage.</p>
				</div>
			)}

			{state === "select-take" && (
				<div className="cclay-panel">
					<h2>Select take</h2>
					<p className="cclay-meta">{sessionValue.filename ?? "staged take"}</p>
					<p className="cclay-meta">The take is operator-assigned: Subject A is the left fighter, Subject B the right.</p>
					<div className="cclay-actions">
						<button type="button" className="cclay-button is-primary" data-action="confirm-take" onClick={() => dispatch("take-selected", { takeId: sessionValue.stageId ?? "staged-take", filename: sessionValue.filename })}>
							Confirm take
						</button>
					</div>
				</div>
			)}

			{state === "calibrate" && (
				<div className="cclay-panel">
					<h2>Ring calibration</h2>
					<p className="cclay-meta">Mark the ring: eight coplanar marks with known ring geometry.</p>
					{sessionValue.calibration ? (
						<>
							<span className={`cclay-verdict is-${sessionValue.calibration.level}`}>{sessionValue.calibration.level}</span>
							{(sessionValue.calibration.reasons ?? []).length > 0 && (
								<ul className="cclay-reasons">
									{sessionValue.calibration.reasons.map((code) => (
										<li key={code} className="cclay-reason is-warn">
											{code}
										</li>
									))}
								</ul>
							)}
							{refusal === "calibration-verdict-invalid" && <div className="cclay-error">{refusal}</div>}
							<div className="cclay-actions">
								<button
									type="button"
									className="cclay-button is-primary"
									data-action="complete-calibration"
									disabled={!["ok", "warn", "block"].includes(sessionValue.calibration.level)}
									onClick={() => dispatch("calibration-verdict", sessionValue.calibration)}
								>
									Continue to extraction
								</button>
							</div>
						</>
					) : (
						<p className="cclay-meta">Awaiting calibration marks.</p>
					)}
				</div>
			)}

			{state === "calibration-blocked" && (
				<div className="cclay-panel">
					<h2>Calibration blocked</h2>
					<span className="cclay-verdict is-block">block</span>
					<ul className="cclay-reasons">
						{(sessionValue.calibration?.reasons ?? []).map((code) => (
							<li key={code} className="cclay-reason is-no-go">
								{code}
							</li>
						))}
					</ul>
					<p className="cclay-meta">The §9 gates have no path out of this state — start a fresh surface session to re-mark the ring.</p>
				</div>
			)}

			{state === "extract" && (
				<div className="cclay-panel">
					<h2>Extract motion</h2>
					{!payloadReady && <p className="cclay-meta">Awaiting take metadata (frames, artifact paths, provenance).</p>}
					<div className="cclay-actions">
						<button type="button" className="cclay-button is-primary" data-action="begin-extraction" disabled={extract.running || !payloadReady} onClick={runExtract}>
							{extract.running ? "Extracting…" : "Begin extraction"}
						</button>
					</div>
					{extract.lines.length > 0 && (
						<div className="cclay-log" data-role="extract-log">
							{extract.lines.map((entry, index) => (
								<div key={index} className={`cclay-log-line${entry.stream === "stderr" ? " is-stderr" : ""}`}>
									{entry.line}
								</div>
							))}
						</div>
					)}
					{extract.error && <div className="cclay-error">{extract.error}</div>}
				</div>
			)}

			{state === "review" && (
				<div className="cclay-panel">
					<h2>Review</h2>
					<div className="cclay-summary">
						<p className="cclay-meta">source: {machineReport.take?.provenance?.sourceUrl ?? "—"}</p>
						<p className="cclay-meta">frames: {machineReport.take?.a?.frames ?? "—"} @ 20 fps</p>
						<p className="cclay-meta">extract lines: {extract.lines.length}</p>
						{machineReport.calibrationWarnings.length > 0 && (
							<ul className="cclay-reasons">
								{machineReport.calibrationWarnings.map((code) => (
									<li key={code} className="cclay-reason is-warn">
										{code}
									</li>
								))}
							</ul>
						)}
					</div>
					{refusal && <div className="cclay-error">{refusal}</div>}
					<div className="cclay-actions">
						<button type="button" className="cclay-button is-primary" data-action="land-take" disabled={landing} onClick={land}>
							{landing ? "Landing…" : "Land take"}
						</button>
					</div>
				</div>
			)}

			{state === "published" && (
				<div className="cclay-panel">
					<h2>Publish</h2>
					<div className="cclay-actions">
						<button type="button" className="cclay-button is-primary" data-action="land-take" disabled={landing} onClick={land}>
							{landing ? "Landing…" : "Retry landing"}
						</button>
					</div>
					{ack && (
						<div className={`cclay-ack is-${ack.status === "ok" ? "ok" : "rejected"}`} data-role="land-ack">
							{ack.status === "ok" ? `Landed (${machineReport.take?.requestId ?? "ok"})` : `rejected: ${ack.code ?? ack.status}`}
						</div>
					)}
					{ack?.status === "session-request-budget-exhausted" && <p className="cclay-meta">Reload the surface to start a fresh session.</p>}
				</div>
			)}
		</div>
	);
}
