export default function ResultModal({ result, copied, recordedVideoName, onClose, onCopy, onDownload }) {
	const isVideo = result.mode === "video";
	const modelLabel = result.modelLabel ?? (isVideo ? "your video model" : "your image model");
	const hasFrame = Boolean(result.frame);

	let nextStep;
	if (isVideo && result.frameB) {
		nextStep = (
			<p>
				Paste the prompt into {modelLabel}, then set <code>blocking-frame-A-start.png</code> as the start frame and{" "}
				<code>blocking-frame-B-end.png</code> as the end frame.
			</p>
		);
	} else if (isVideo && hasFrame) {
		nextStep = (
			<p>
				Paste the prompt into {modelLabel}, then attach <code>blocking-frame.png</code> as the reference frame.
			</p>
		);
	} else if (hasFrame) {
		nextStep = (
			<p>
				Paste the prompt into {modelLabel}, then attach <code>blocking-frame.png</code> as the reference image.
			</p>
		);
	} else {
		nextStep = <p>Paste the copied prompt into {modelLabel} to create the shot.</p>;
	}

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="result-title">Your shot is ready</h3>
					<button type="button" className="x" onClick={onClose} aria-label="Close result">
						✕
					</button>
				</div>
				{result.frameB ? (
					<div className="move-frames">
						<figure>
							<img className="preview" src={result.frame} alt="move start frame" />
							<figcaption>A · start</figcaption>
						</figure>
						<figure>
							<img className="preview" src={result.frameB} alt="move end frame" />
							<figcaption>B · end</figcaption>
						</figure>
					</div>
				) : (
					result.frame && <img className="preview" src={result.frame} alt="framed shot" />
				)}
				{result.move && (
					<div className="move-slate result-move-slate">
						<span>{result.move.slate} · {result.move.spanS}s</span>
						<small>Camera move derived from your timeline keyframes</small>
					</div>
				)}
				<label className="modal-label">Prompt {copied && <em>· copied</em>}</label>
				<div className="promptbox">{result.prompt}</div>
				<div className="modal-actions">
					<button type="button" className="btn" onClick={onCopy}>
						{copied ? "Copied ✓" : "Copy prompt"}
					</button>
					{result.frame && (
						<button type="button" className="btn" onClick={onDownload}>
							{result.frameB ? "Download start & end frames" : "Download frame"}
						</button>
					)}
				</div>

				<section className="result-next" aria-labelledby="result-next-title">
					<span className="result-next-kicker">Next · {modelLabel}</span>
					<h4 id="result-next-title">Use the prompt and frame together</h4>
					{nextStep}
					{recordedVideoName && (
						<p className="result-reference-video">
							<strong>Optional reference video</strong>
							<code>{recordedVideoName}</code> came from Record and is separate from the prompt conditioning frame{result.frameB ? "s" : ""} above.
						</p>
					)}
				</section>
			</div>
		</div>
	);
}
