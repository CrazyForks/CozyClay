export default function ResultModal({ result, copied, recordedVideoName, onClose, onCopy, onDownload }) {
	const isVideo = result.mode === "video";
	const modelLabel = result.modelLabel ?? (isVideo ? "선택한 영상 모델" : "선택한 이미지 모델");
	const hasFrame = Boolean(result.frame);

	let nextStep;
	if (isVideo && result.frameB) {
		nextStep = (
			<p>
				{modelLabel}에 프롬프트를 붙여 넣고 <code>blocking-frame-A-start.png</code>를 시작 프레임으로, {" "}
				<code>blocking-frame-B-end.png</code>를 끝 프레임으로 설정하세요.
			</p>
		);
	} else if (isVideo && hasFrame) {
		nextStep = (
			<p>
				{modelLabel}에 프롬프트를 붙여 넣고 <code>blocking-frame.png</code>를 참고 프레임으로 첨부하세요.
			</p>
		);
	} else if (hasFrame) {
		nextStep = (
			<p>
				{modelLabel}에 프롬프트를 붙여 넣고 <code>blocking-frame.png</code>를 참고 이미지로 첨부하세요.
			</p>
		);
	} else {
		nextStep = <p>복사한 프롬프트를 {modelLabel}에 붙여 넣어 장면을 만드세요.</p>;
	}

	return (
		<div className="modal-overlay" onClick={onClose}>
			<div className="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="result-title" onClick={(event) => event.stopPropagation()}>
				<div className="modal-head">
					<h3 id="result-title">장면이 준비됐어요</h3>
					<button type="button" className="x" onClick={onClose} aria-label="결과 닫기">
						✕
					</button>
				</div>
				{result.frameB ? (
					<div className="move-frames">
						<figure>
							<img className="preview" src={result.frame} alt="카메라 움직임 시작 프레임" />
							<figcaption>A · 시작</figcaption>
						</figure>
						<figure>
							<img className="preview" src={result.frameB} alt="카메라 움직임 끝 프레임" />
							<figcaption>B · 끝</figcaption>
						</figure>
					</div>
				) : (
					result.frame && <img className="preview" src={result.frame} alt="완성된 장면 프레임" />
				)}
				{result.move && (
					<div className="move-slate result-move-slate">
						<span>{result.move.displaySlate ?? result.move.slate} · {result.move.spanS}초</span>
						<small>타임라인 키프레임으로 만든 카메라 움직임</small>
					</div>
				)}
				<label className="modal-label">프롬프트 {copied && <em>· 복사됨</em>}</label>
				<div className="promptbox">{result.prompt}</div>
				<div className="modal-actions">
					<button type="button" className="btn" onClick={onCopy}>
						{copied ? "복사됨 ✓" : "프롬프트 복사"}
					</button>
					{result.frame && (
						<button type="button" className="btn" onClick={onDownload}>
							{result.frameB ? "시작·끝 프레임 다운로드" : "프레임 다운로드"}
						</button>
					)}
				</div>

				<section className="result-next" aria-labelledby="result-next-title">
					<span className="result-next-kicker">다음 · {modelLabel}</span>
					<h4 id="result-next-title">프롬프트와 프레임을 함께 사용하세요</h4>
					{nextStep}
					{recordedVideoName && (
						<p className="result-reference-video">
							<strong>선택 사항 · 참고 영상</strong>
							녹화 기능으로 만든 <code>{recordedVideoName}</code> 파일이에요. 위의 프롬프트 참고 프레임과는 별도로 활용하세요.
						</p>
					)}
				</section>
			</div>
		</div>
	);
}
