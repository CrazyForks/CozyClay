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
export function NumberField({ label, value, step, precision = 2, onChange, title }) {
	const [focused, setFocused] = useState(false);
	const [draft, setDraft] = useState(null);
	// The draft must be readable synchronously: blur() fires the commit
	// handler before React re-renders, so state alone would commit the
	// pre-Escape value.
	const draftRef = useRef(null);
	// Freshest committed prop for a drag baseline, even while a parent
	// re-render from the previous commit is still pending.
	const valueRef = useRef(value);
	const inputRef = useRef(null);
	// `{ x, value }` of the drag start, null while not scrubbing.
	const dragRef = useRef(null);

	valueRef.current = value;

	const setDraftValue = (text) => {
		draftRef.current = text;
		setDraft(text);
	};

	// Push the draft to the store when it parses; either way clear it so the
	// field falls back to the incoming prop. Returns the parsed number (or
	// null) so a drag can baseline from what was just committed.
	const commitDraft = () => {
		const parsed = parseFloat(draftRef.current);
		const ok = Number.isFinite(parsed);
		if (ok) onChange(parsed);
		setDraftValue(null);
		return ok ? parsed : null;
	};

	// Round to `precision` decimals, then let String() drop trailing zeros:
	// 1.50 reads 1.5, 45.0 reads 45.
	const formatValue = (n) => String(Number(n.toFixed(precision)));

	const onFocus = (e) => {
		setFocused(true);
		// Start from the formatted number so typing replaces the whole value.
		setDraftValue(formatValue(value));
		e.target.select();
	};

	const onBlur = () => {
		commitDraft();
		setFocused(false);
	};

	const onKeyDown = (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commitDraft();
			// Keep focus and select the committed value so the next keystroke
			// replaces it, like Unity's inspector.
			e.currentTarget.select();
		} else if (e.key === "Escape") {
			e.preventDefault();
			// Clear the ref first: the blur below commits, and a cleared
			// draft parses to NaN, so the revert survives.
			setDraftValue(null);
			inputRef.current?.blur();
		}
	};

	// Unity-style scrubbing: drag the axis label to change the value. Pointer
	// capture keeps the drag alive when the cursor leaves the window; Shift
	// moves 10x per pixel, Alt 0.1x.
	const onAxisPointerDown = (e) => {
		e.preventDefault();
		const base = commitDraft();
		dragRef.current = { x: e.clientX, value: base ?? valueRef.current };
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onAxisPointerMove = (e) => {
		const drag = dragRef.current;
		if (!drag) return;
		const multiplier = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
		onChange(drag.value + (e.clientX - drag.x) * step * multiplier);
	};

	const endAxisDrag = (e) => {
		dragRef.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) {
			e.currentTarget.releasePointerCapture(e.pointerId);
		}
	};

	const display = focused && draft !== null ? draft : formatValue(value);

	return (
		<span className="number-field" title={title}>
			<span
				className="axis"
				onPointerDown={onAxisPointerDown}
				onPointerMove={onAxisPointerMove}
				onPointerUp={endAxisDrag}
				onPointerCancel={endAxisDrag}
			>
				{label}
			</span>
			<input
				ref={inputRef}
				type="text"
				inputMode="decimal"
				value={display}
				onFocus={onFocus}
				onBlur={onBlur}
				onChange={(e) => setDraftValue(e.target.value)}
				onKeyDown={onKeyDown}
			/>
		</span>
	);
}

// One Unity-style transform row: a row label plus one scrubbable NumberField
// per axis. `fields` entries are `{ axis, value, step, precision, onChange }`.
export function Vector3Row({ label, fields }) {
	return (
		<div className="vec3-row">
			<span className="vec3-label">{label}</span>
			{fields.map((field) => (
				<NumberField
					key={field.axis}
					label={field.axis}
					value={field.value}
					step={field.step}
					precision={field.precision}
					onChange={field.onChange}
				/>
			))}
		</div>
	);
}
