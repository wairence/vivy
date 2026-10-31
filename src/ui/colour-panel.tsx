import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Colours, ColourMode, coloursOf, hexToRgb, rgbToHex, setColours } from "../colours";
import { currentPicture, isDefaultPicture, Picture, PICTURE_DEFAULTS, setPicture } from "./picture";

// The colours, at the top of the knobs panel: cover or picked colours, and what the gradient follows.
// The picker opens beside the panel, because the panel's scrolling would cut it off.

type Hsv = { h: number; s: number; v: number };

const hexToHsv = (hex: string): Hsv => {
	const { r, g, b } = hexToRgb(hex);
	const max = Math.max(r, g, b) / 255;
	const min = Math.min(r, g, b) / 255;
	const d = max - min;
	let h = 0;
	if (d > 1e-6) {
		const [rn, gn, bn] = [r / 255, g / 255, b / 255];
		if (max === rn) h = ((gn - bn) / d) % 6;
		else if (max === gn) h = (bn - rn) / d + 2;
		else h = (rn - gn) / d + 4;
		h = (((h / 6) % 1) + 1) % 1;
	}
	return { h, s: max < 1e-6 ? 0 : d / max, v: max };
};

const hsvToHex = ({ h, s, v }: Hsv): string => {
	const f = (n: number) => {
		const k = (n + h * 6) % 6;
		return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
	};
	return rgbToHex({ r: f(5), g: f(3), b: f(1) });
};

// drag inside an element: calls back with the pointer's position across it, 0..1 each way
function useDrag(onMove: (x: number, y: number) => void) {
	return (e: React.PointerEvent<HTMLDivElement>) => {
		const el = e.currentTarget;
		const at = (ev: { clientX: number; clientY: number }) => {
			const r = el.getBoundingClientRect();
			onMove(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
		};
		el.setPointerCapture(e.pointerId);
		at(e);
		const move = (ev: PointerEvent) => at(ev);
		const up = () => {
			el.removeEventListener("pointermove", move);
			el.removeEventListener("pointerup", up);
		};
		el.addEventListener("pointermove", move);
		el.addEventListener("pointerup", up);
	};
}

function Picker({ hex, onChange, onRemove, onClose, top, right }: {
	hex: string;
	onChange: (hex: string) => void;
	onRemove: (() => void) | null;
	onClose: () => void;
	top: number;
	right: number;
}) {
	// HSV is kept, not derived from the hex: at zero saturation or brightness the hue is not in the hex
	const [hsv, setHsv] = useState(() => hexToHsv(hex));
	const [text, setText] = useState(hex);
	const set = (next: Hsv) => {
		setHsv(next);
		const h = hsvToHex(next);
		setText(h);
		onChange(h);
	};
	const square = useDrag((x, y) => set({ ...hsv, s: x, v: 1 - y }));
	const strip = useDrag(x => set({ ...hsv, h: Math.min(0.999, x) }));
	const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });
	// every change is on screen at once, so there is nothing to confirm: a click anywhere else, or Esc,
	// puts the picker away (a click on its own swatch is the swatch's, which toggles it)
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const doc = box.current?.ownerDocument;
		if (!doc) return;
		const away = (e: MouseEvent) => {
			const t = e.target as Element | null;
			if (box.current?.contains(t) || t?.closest?.(".vivy-swatch")) return;
			onClose();
		};
		const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		doc.addEventListener("mousedown", away, true);
		doc.addEventListener("keydown", esc, true);
		return () => {
			doc.removeEventListener("mousedown", away, true);
			doc.removeEventListener("keydown", esc, true);
		};
	}, [onClose]);
	return (
		<div className="vivy-picker" ref={box} style={{ top, right }} onMouseDown={e => e.stopPropagation()}>
			<div className="vivy-picker-square" style={{ backgroundColor: pure }} onPointerDown={square}>
				<div className="vivy-picker-dot" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
			</div>
			<div className="vivy-picker-strip" onPointerDown={strip}>
				<div className="vivy-picker-handle" style={{ left: `${hsv.h * 100}%`, background: pure }} />
			</div>
			<div className="vivy-picker-row">
				<span className="vivy-picker-chip" style={{ background: hsvToHex(hsv) }} />
				<input
					value={text}
					spellCheck={false}
					maxLength={7}
					onChange={e => {
						const v = e.target.value.trim();
						setText(v);
						const full = (v.startsWith("#") ? v : "#" + v).toLowerCase();
						if (/^#[0-9a-f]{6}$/.test(full)) {
							setHsv(hexToHsv(full));
							onChange(full);
						}
					}}
				/>
				{onRemove ? <button onClick={onRemove}>Remove</button> : null}
			</div>
		</div>
	);
}

const PICTURE_KNOBS: [keyof Picture, string, number, number, string][] = [
	["brightness", "brightness", 0, 2, "Darker or lighter, the whole picture."],
	["contrast", "contrast", 0, 2, "Flatter or harder, the whole picture."],
	["saturation", "saturation", 0, 2, "From grey to stronger colour."],
	["transparency", "transparency", 0, 1, "Lets the Spotify theme behind the page show through."]
];

const MODES: [ColourMode, string, string][] = [
	["cover", "Cover", "The colours come from the album cover and change with every track"],
	["custom", "Custom", "Your own two or three colours, the same for every track"]
];

export function ColourSection({ presetId, panel, explain, unexplain }: {
	presetId: string;
	panel: React.RefObject<HTMLDivElement | null>;
	explain: (text: string, row: HTMLElement) => void;
	unexplain: () => void;
}) {
	const [, redraw] = useState(0);
	const [editing, setEditing] = useState<{ i: number; top: number; right: number } | null>(null);
	const refresh = () => redraw(n => n + 1);
	const set = (patch: Partial<Colours>) => (setColours(presetId, patch), refresh());
	const own = coloursOf(presetId);
	// the picker belongs to the panel: it goes when the panel scrolls it out of reach
	useEffect(() => {
		const p = panel.current;
		if (!p || !editing) return;
		const close = () => setEditing(null);
		p.addEventListener("scroll", close);
		return () => p.removeEventListener("scroll", close);
	}, [editing, panel]);
	const open = (i: number, el: HTMLElement) => {
		const p = panel.current;
		const parent = p?.offsetParent;
		if (!p || !parent) return;
		if (editing?.i === i) return setEditing(null);
		const box = parent.getBoundingClientRect();
		setEditing({ i, top: el.getBoundingClientRect().top - box.top - 8, right: box.right - p.getBoundingClientRect().left + 10 });
	};
	if (!own) return null;
	const colours = own.colours;
	const custom = colours.mode === "custom";
	const stops = colours.stops;
	return (
		<>
			<div className="vivy-tune-group">colour</div>
			<div className="vivy-seg">
				{MODES.map(([m, name, what]) => (
					<button
						key={m}
						className={colours.mode === m ? "on" : ""}
						onMouseEnter={e => explain(what, e.currentTarget)}
						onMouseLeave={unexplain}
						onClick={() => (setEditing(null), set({ mode: m }))}>
						{name}
					</button>
				))}
			</div>
			{custom ? (
				<div className="vivy-swatches">
					{stops.map((hex, i) => (
						<button
							key={i}
							className={`vivy-swatch${editing?.i === i ? " on" : ""}`}
							style={{ background: hex }}
							title="Change this colour"
							aria-label={`Colour ${i + 1}: ${hex}`}
							onClick={e => open(i, e.currentTarget)}
						/>
					))}
					{stops.length < 3 ? (
						<button
							className="vivy-swatch add"
							title="Add a colour"
							aria-label="Add a colour"
							onClick={e => {
								set({ stops: [...stops, stops[stops.length - 1]] });
								open(stops.length, e.currentTarget);
							}}
						>
							+
						</button>
					) : null}
					<div className="vivy-ramp" style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }} />
				</div>
			) : null}
			<div className="vivy-tune-sub">gradient follows</div>
			<div className="vivy-seg">
				{own.gradients.map(([f, name, what]) => (
					<button
						key={f}
						className={colours.follows === f ? "on" : ""}
						onMouseEnter={e => explain(what, e.currentTarget)}
						onMouseLeave={unexplain}
						onFocus={e => explain(what, e.currentTarget)}
						onBlur={unexplain}
						onClick={() => set({ follows: f })}
					>
						{name}
					</button>
				))}
			</div>
			<div
				className="vivy-tune-knob"
				onMouseEnter={e => explain("Each part of a song has its own key, and the colours lean round the wheel with it. Zero keeps them exactly as they are. Double-click the name to reset.", e.currentTarget)}
				onMouseLeave={unexplain}
			>
				<div className="vivy-tune-label" onDoubleClick={() => set({ harmony: 1 })}>
					<span>the song's key turns the hue</span>
					<span>{colours.harmony.toFixed(2)}</span>
				</div>
				<input type="range" min={0} max={1} step={0.01} value={colours.harmony} onChange={e => set({ harmony: Number(e.target.value) })} />
			</div>
			<div className="vivy-tune-sub">picture</div>
			{PICTURE_KNOBS.map(([key, name, min, max, what]) => (
				<div
					key={key}
					className="vivy-tune-knob"
					onMouseEnter={e => explain(`${what} Applies to every preset. Double-click the name to reset.`, e.currentTarget)}
					onMouseLeave={unexplain}
				>
					<div className="vivy-tune-label" onDoubleClick={() => (setPicture({ [key]: PICTURE_DEFAULTS[key] }), refresh())}>
						<span>{name}</span>
						<span>{currentPicture()[key].toFixed(2)}</span>
					</div>
					<input type="range" min={min} max={max} step={0.01} value={currentPicture()[key]} onChange={e => (setPicture({ [key]: Number(e.target.value) }), refresh())} />
				</div>
			))}
			<div className="vivy-seg">
				<button disabled={isDefaultPicture()} onClick={() => (setPicture(PICTURE_DEFAULTS), refresh())}>
					Reset picture
				</button>
			</div>
			{editing && custom && stops[editing.i] && panel.current?.offsetParent
				? createPortal(
				<Picker
					key={editing.i}
					hex={stops[editing.i]}
					top={editing.top}
					right={editing.right}
					onChange={hex => set({ stops: stops.map((s, i) => (i === editing.i ? hex : s)) })}
					onRemove={stops.length > 2 ? () => (setEditing(null), set({ stops: stops.filter((_, i) => i !== editing.i) })) : null}
					onClose={() => setEditing(null)}
				/>,
				panel.current.offsetParent
				)
				: null}
		</>
	);
}
