import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FRAME_RATES, frameRate, setFrameRate } from "../frame-rate";
import { Knob, movedText, resetKnobs, setKnob, tuningOf } from "../presets/tune";
import { ColourSection, LyricsSection, PictureSection } from "./colour-panel";
import { IconButton, ICON_CLOSE, ICON_COPY, ICON_RESET } from "./icons";

type Tab = "preset" | "colour" | "picture" | "lyrics";
const TABS: [Tab, string][] = [
	["preset", "Preset"],
	["colour", "Colour"],
	["picture", "Picture"],
	["lyrics", "Lyrics"]
];

const FRAME_RATE_HINT =
	"Pictures drawn per second. Lower takes load off the graphics card on a fast monitor; movement keeps its speed, only smoothness changes. Monitor draws every frame the screen shows.";

// The knobs panel (T), in tabs. Preset: the preset on screen's numbers as sliders, double-click a name
// to reset it, "Copy" puts the moved values on the clipboard, to become the new defaults in tune(...).
export function TunePanel({ presetId, onClose }: { presetId: string; onClose: () => void }) {
	const [, redraw] = useState(0);
	// drawn beside the panel, where its scrolling cannot cut it off
	const [hint, setHint] = useState<{ text: string; foot: string; top: number; right: number } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	// our own hairline scrollbar: Spotify's client-wide scrollbar style wins over the panel's
	const [bar, setBar] = useState<{ top: number; height: number; right: number } | null>(null);
	const measureBar = () => {
		const p = panelRef.current;
		const parent = p?.offsetParent;
		if (!p || !parent || p.scrollHeight <= p.clientHeight + 1) return setBar(b => (b ? null : b));
		const box = parent.getBoundingClientRect();
		const r = p.getBoundingClientRect();
		const height = Math.max(24, (p.clientHeight / p.scrollHeight) * (r.height - 16));
		const top = r.top - box.top + 8 + (p.scrollTop / (p.scrollHeight - p.clientHeight)) * (r.height - 16 - height);
		const right = box.right - r.right + 3;
		setBar(b => (b && Math.abs(b.top - top) < 0.5 && Math.abs(b.height - height) < 0.5 && b.right === right ? b : { top, height, right }));
	};
	useLayoutEffect(measureBar);
	useEffect(() => {
		window.addEventListener("resize", measureBar);
		return () => window.removeEventListener("resize", measureBar);
	}, []);
	// "More settings" open or closed is remembered
	const [more, setMore] = useState(() => {
		try {
			return localStorage.getItem("vivy:more") === "1";
		} catch {
			return false;
		}
	});
	const toggleMore = () => {
		setHint(null);
		setMore(open => {
			try {
				localStorage.setItem("vivy:more", open ? "0" : "1");
			} catch {
				// storage denied: it opens closed next time
			}
			return !open;
		});
	};
	const [tab, setTab] = useState<Tab>(() => {
		try {
			const stored = localStorage.getItem("vivy:tab");
			return TABS.some(([id]) => id === stored) ? (stored as Tab) : "preset";
		} catch {
			return "preset";
		}
	});
	const chooseTab = (id: Tab) => {
		setHint(null);
		setTab(id);
		try {
			localStorage.setItem("vivy:tab", id);
		} catch {
			// opens on the first tab next time
		}
	};
	const t = tuningOf(presetId);
	const refresh = () => redraw(n => n + 1);
	// a feature flipped with its number key (the preset's own listener runs first)
	useEffect(() => {
		window.addEventListener("visualizer-feature", refresh);
		return () => window.removeEventListener("visualizer-feature", refresh);
	}, []);
	const copy = () => {
		const text = movedText(presetId);
		navigator.clipboard?.writeText(text || "nothing moved").catch(() => {});
		Spicetify.showNotification(text ? "Moved knobs copied" : "Nothing moved yet");
	};
	const explain = (text: string, foot: string, row: HTMLElement) => {
		const panel = panelRef.current;
		const parent = panel?.offsetParent;
		if (!text || !panel || !parent) return;
		const p = parent.getBoundingClientRect();
		setHint({ text, foot, top: row.getBoundingClientRect().top - p.top, right: p.right - panel.getBoundingClientRect().left + 10 });
	};
	const showHint = (knob: Knob, row: HTMLElement) =>
		explain(knob.hint, `default ${+knob.def.toPrecision(3)} · double-click the name to reset`, row);
	const knobs = (list: Knob[]) => {
		let group = "";
		return list.map(k => {
			const value = t!.values[k.key];
			const head = k.group !== group ? <div className="vivy-tune-group">{(group = k.group)}</div> : null;
			return (
				<React.Fragment key={k.key}>
					{head}
					<div
						className={`vivy-tune-knob${value !== k.def ? " moved" : ""}`}
						onMouseEnter={e => showHint(k, e.currentTarget)}
						onMouseLeave={() => setHint(null)}
						onFocus={e => showHint(k, e.currentTarget)}
						onBlur={() => setHint(null)}
					>
						<div className="vivy-tune-label" onDoubleClick={() => (setKnob(presetId, k.key, k.def), refresh())}>
							<span>{k.label}</span>
							<span>{+value.toPrecision(3)}</span>
						</div>
						<input
							type="range"
							min={k.min}
							max={k.max}
							step={(k.max - k.min) / 400}
							value={value}
							onChange={e => (setKnob(presetId, k.key, Number(e.target.value)), refresh())}
						/>
					</div>
				</React.Fragment>
			);
		});
	};
	return (
		<>
			<div className="vivy-tune" ref={panelRef} onMouseDown={e => e.stopPropagation()} onScroll={() => (setHint(null), measureBar())}>
				<div className="vivy-tune-head">
					<div className="vivy-tune-title">
						<b>Knobs</b>
						{tab === "preset" ? (
							<>
								<IconButton small label="Copy moved values" icon={ICON_COPY} onClick={copy} />
								<IconButton small label="Reset all to defaults" icon={ICON_RESET} onClick={() => (resetKnobs(presetId), refresh())} />
							</>
						) : null}
						<IconButton small label="Close (T)" icon={ICON_CLOSE} onClick={onClose} />
					</div>
					<div className="vivy-seg vivy-tabs" role="tablist">
						{TABS.map(([id, name]) => (
							<button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => chooseTab(id)}>
								{name}
							</button>
						))}
					</div>
				</div>
				{tab === "preset" ? (
					<>
						{!t || (t.knobs.length === 0 && t.features.length === 0) ? <div className="vivy-tune-none">This preset has no knobs yet.</div> : null}
						{t ? knobs(t.knobs.filter(k => k.basic)) : null}
						{t && (t.features.length > 0 || t.knobs.some(k => !k.basic)) ? (
							<button className={`vivy-more${more ? " on" : ""}`} aria-expanded={more} onClick={toggleMore}>
								<span>{more ? "Fewer settings" : "More settings"}</span>
								<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M6 9l6 6 6-6" />
								</svg>
							</button>
						) : null}
						{more && t ? (
							<>
								{t.features.length > 0 ? <div className="vivy-tune-group">effects</div> : null}
								{t.features.map((f, i) => (
									<label key={f.name} className="vivy-tune-feature">
										<input type="checkbox" checked={f.on} onChange={() => ((f.on = !f.on), refresh())} />
										{i + 1}. {f.name}
									</label>
								))}
								{knobs(t.knobs.filter(k => !k.basic))}
							</>
						) : null}
					</>
				) : null}
				{tab === "colour" ? (
					<ColourSection key={presetId} presetId={presetId} panel={panelRef} explain={(text, row) => explain(text, "", row)} unexplain={() => setHint(null)} />
				) : null}
				{tab === "picture" ? (
					<>
						<PictureSection explain={(text, row) => explain(text, "", row)} unexplain={() => setHint(null)} />
						<div className="vivy-tune-sub">frame rate</div>
						<div className="vivy-seg">
							{FRAME_RATES.map(fps => (
								<button
									key={fps}
									className={frameRate() === fps ? "on" : ""}
									onMouseEnter={e => explain(FRAME_RATE_HINT, "applies to every preset", e.currentTarget)}
									onMouseLeave={() => setHint(null)}
									onClick={() => (setFrameRate(fps), refresh())}
								>
									{fps || "Monitor"}
								</button>
							))}
						</div>
					</>
				) : null}
				{tab === "lyrics" ? <LyricsSection explain={(text, row) => explain(text, "", row)} unexplain={() => setHint(null)} /> : null}
			</div>
			{bar ? <div className="vivy-tune-bar" style={{ top: bar.top, height: bar.height, right: bar.right }} /> : null}
			{hint ? (
				<div className="vivy-tune-hint" style={{ top: hint.top, right: hint.right }}>
					<div>{hint.text}</div>
					{hint.foot ? <small>{hint.foot}</small> : null}
				</div>
			) : null}
		</>
	);
}
