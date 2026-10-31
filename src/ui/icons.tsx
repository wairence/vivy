import React from "react";

// 24 units square, drawn in the text's colour
export const ICON_KNOBS = (
	<>
		<path d="M4 7h16M4 12h16M4 17h16" />
		<circle cx="15" cy="7" r="2.2" fill="currentColor" />
		<circle cx="8" cy="12" r="2.2" fill="currentColor" />
		<circle cx="13" cy="17" r="2.2" fill="currentColor" />
	</>
);
export const ICON_PIP = (
	<>
		<rect x="3" y="5" width="18" height="14" rx="2" />
		<rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
	</>
);
export const ICON_EXPAND = <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />;
export const ICON_SHRINK = <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />;

export const ICON_COPY = (
	<>
		<rect x="8" y="8" width="12" height="12" rx="2" />
		<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
	</>
);
export const ICON_RESET = (
	<>
		<path d="M4 12a8 8 0 1 0 2.4-5.7" />
		<path d="M4 4v4.5h4.5" />
	</>
);
export const ICON_CLOSE = <path d="M6 6l12 12M18 6L6 18" />;
export const ICON_PLAY = <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />;
export const ICON_PAUSE = <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth="2.6" />;
export const ICON_BACK = (
	<>
		<path d="M6.5 5.5v13" strokeWidth="2.2" />
		<path d="M18.5 5.5v13L9 12z" fill="currentColor" />
	</>
);
export const ICON_NEXT = (
	<>
		<path d="M17.5 5.5v13" strokeWidth="2.2" />
		<path d="M5.5 5.5v13L15 12z" fill="currentColor" />
	</>
);
const HEART = "M12 19.5l-6.6-6.6a4.2 4.2 0 0 1 6-5.9l.6.6.6-.6a4.2 4.2 0 0 1 6 5.9z";
export const ICON_HEART = <path d={HEART} />;
export const ICON_HEART_FILLED = <path d={HEART} fill="currentColor" />;

export function IconButton({ label, icon, active, small, onClick }: { label: string; icon: React.ReactNode; active?: boolean; small?: boolean; onClick: () => void }) {
	return (
		<button className={`vivy-icon${small ? " small" : ""}${active ? " active" : ""}`} title={label} aria-label={label} aria-pressed={active}onClick={onClick}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				{icon}
			</svg>
		</button>
	);
}
