import { useEffect, useId, useRef, useState } from "react";

// Custom dropdown, structurally matched to the reference (`.dropdown`,
// `dd-caret`, `dropdown-menu`, `dropdown-item`, `dd-check`) with the keyboard
// support the reference lacks. `highlighted` marks the arrow-key cursor;
// the selection itself is `active`.
export function Dropdown({ value, options, onChange, ariaLabel }) {
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(-1);
	const rootRef = useRef(null);
	const triggerRef = useRef(null);
	const uid = useId();
	const listId = `${uid}-list`;
	const selectedIndex = options.findIndex((o) => o.value === value);
	const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

	// Close on any mousedown outside the dropdown; effect cleanup also covers
	// unmounting while open.
	useEffect(() => {
		if (!open) return;
		const onDocMouseDown = (e) => {
			if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocMouseDown);
		return () => document.removeEventListener("mousedown", onDocMouseDown);
	}, [open]);

	// Keyboard navigation starts from the current selection.
	useEffect(() => {
		if (open) setHighlight(selectedIndex);
	}, [open, selectedIndex]);

	const close = () => setOpen(false);

	const moveHighlight = (dir) => {
		if (options.length === 0) return;
		setHighlight((h) =>
			h < 0
				? dir > 0
					? 0
					: options.length - 1
				: (h + dir + options.length) % options.length,
		);
	};

	const onKeyDown = (e) => {
		if (!open) return;
		if (e.key === "Escape") {
			e.preventDefault();
			close();
			triggerRef.current?.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			moveHighlight(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			moveHighlight(-1);
		} else if (e.key === "Enter" && highlight >= 0 && highlight < options.length) {
			e.preventDefault();
			onChange(options[highlight].value);
			close();
		}
	};

	return (
		<div className={"dropdown" + (open ? " open" : "")} ref={rootRef} onKeyDown={onKeyDown}>
			<button
				type="button"
				className="trigger"
				ref={triggerRef}
				aria-expanded={open}
				aria-haspopup="listbox"
				aria-controls={listId}
				aria-label={ariaLabel}
				onClick={() => setOpen((o) => !o)}
			>
				<span>{selected ? selected.label : ""}</span>
				<svg
					className="dd-caret"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M6 9l6 6 6-6" />
				</svg>
			</button>
			{open && (
				<div
					className="dropdown-menu"
					id={listId}
					role="listbox"
					aria-activedescendant={highlight >= 0 && highlight < options.length ? `${uid}-opt-${highlight}` : undefined}
				>
					{options.map((opt, i) => (
						<button
							type="button"
							key={opt.value}
							id={`${uid}-opt-${i}`}
							role="option"
							aria-selected={opt.value === value}
							className={
								"dropdown-item" +
								(opt.value === value ? " active" : "") +
								(i === highlight ? " highlighted" : "")
							}
							onClick={() => {
								onChange(opt.value);
								close();
							}}
						>
							<span>{opt.label}</span>
							{opt.value === value && (
								<svg
									className="dd-check"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M20 6L9 17l-5-5" />
								</svg>
							)}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// Auto-dismissing toast; the timer restarts whenever the message (or
// duration) changes and is always cleared on unmount.
export function Toast({ message, onDone, duration = 2200 }) {
	useEffect(() => {
		if (!message) return;
		const timer = setTimeout(onDone, duration);
		return () => clearTimeout(timer);
		// onDone deliberately excluded: callers pass inline callbacks and the
		// timer must survive parent re-renders within one message lifetime.
	}, [message, duration]);
	if (!message) return null;
	return <div className="toast">{message}</div>;
}

// Range slider with the reference's filled-track gradient. `value` may be a
// raw float (e.g. from drag interactions), so it is clamped and the label is
// rounded to the slider's own step precision.
export function Slider({ label, min, max, step, value, unit = "", onChange, compact }) {
	const clamped = Math.min(max, Math.max(min, value));
	const percent = Math.max(0, Math.min(100, ((clamped - min) / (max - min)) * 100));
	const decimals = (String(step).split(".")[1] || "").length;
	const snapped = Math.round((clamped - min) / step) * step + min;
	const text = String(decimals > 0 ? Number(snapped.toFixed(decimals)) : Math.round(snapped));
	const input = (
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={clamped}
			style={{ background: `linear-gradient(to right, var(--accent) ${percent}%, var(--track) ${percent}%)` }}
			onChange={(e) => onChange(parseFloat(e.target.value))}
		/>
	);
	if (compact) {
		return (
			<div className="cslider">
				<div className="cslider-head">
					<span>{label}</span>
					<span className="val">
						{text}
						{unit}
					</span>
				</div>
				{input}
			</div>
		);
	}
	return (
		<div className="row">
			<span>{label}</span>
			{input}
			<span className="val">
				{text}
				{unit}
			</span>
		</div>
	);
}

export function Field({ label, children }) {
	return (
		<div className="field">
			<label>{label}</label>
			{children}
		</div>
	);
}
