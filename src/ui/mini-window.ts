// The mini window: a Document Picture-in-Picture window, always on top, with the canvas itself moved
// into it so the preset draws once, at the window's size. Plain DOM: React does not own this window.
// It has no frame in this client, so it is moved by a drag region and sized with resizeTo, the way
// Spotify's own miniplayer is.

export const IDLE_HIDE_MS = 2500;
const PLACE_KEY = "vivy:pip-place";
const SMALLEST = 200;

type Hooks = {
	// the window the canvas is in changed size
	onResize: () => void;
	// the canvas moved into the mini window (true) or back to the page (false)
	onMove: (open: boolean) => void;
};

type DocumentPip = { requestWindow: (o: { width: number; height: number }) => Promise<Window> };

export function createMiniWindow(canvas: HTMLCanvasElement, hooks: Hooks) {
	let pip: Window | null = null;
	let closed = false;
	const container = canvas.parentElement;

	// resizeTo takes the outside size; this takes the inside
	const sizeTo = (w: Window, width: number, height: number) => {
		const limitW = Math.max(SMALLEST, (w.screen?.availWidth ?? 1920) * 0.9);
		const limitH = Math.max(SMALLEST, (w.screen?.availHeight ?? 1080) * 0.9);
		const k = Math.min(1, limitW / width, limitH / height);
		try {
			w.resizeTo(
				Math.round(Math.max(SMALLEST, width * k) + (w.outerWidth - w.innerWidth)),
				Math.round(Math.max(SMALLEST * 0.5625, height * k) + (w.outerHeight - w.innerHeight))
			);
		} catch {
			// not resizable from the page: its edges still work
		}
	};
	const remember = (w: Window) => {
		if (w.innerWidth < 50) return;
		try {
			localStorage.setItem(PLACE_KEY, JSON.stringify({ w: w.innerWidth, h: w.innerHeight, x: w.screenX, y: w.screenY }));
		} catch {
			// opens at the default next time
		}
	};
	const comeBack = () => {
		// closing is asynchronous: this can arrive after the page has gone
		if (!pip || closed) return;
		pip.removeEventListener("resize", hooks.onResize);
		pip = null;
		canvas.style.cssText = "";
		container?.prepend(canvas);
		hooks.onMove(false);
	};

	const open = () => {
		const api = (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture;
		if (!api) {
			Spicetify.showNotification("This Spotify build has no picture-in-picture window", true);
			return;
		}
		let place: { w: number; h: number; x: number; y: number } | null = null;
		try {
			place = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
		} catch {
			place = null;
		}
		api.requestWindow({ width: Math.max(SMALLEST, place?.w ?? 480), height: Math.max(SMALLEST * 0.5625, place?.h ?? 270) })
			.then(opened => {
				if (closed) {
					opened.close();
					return;
				}
				pip = opened;
				const doc = opened.document;
				doc.title = "vivy";
				doc.body.style.cssText = "margin:0;background:#000;overflow:hidden";
				// the stylesheet stays in Spotify's document
				canvas.style.cssText = "display:block;width:100vw;height:100vh";
				doc.body.append(canvas);
				if (place && Number.isFinite(place.x) && Number.isFinite(place.y)) {
					try {
						opened.moveTo(place.x, place.y);
					} catch {
						// it opens where the client puts it
					}
				}

				// the whole picture is the drag handle, except a rim: a drag region at the border takes its resize grip
				const handle = doc.createElement("div");
				handle.style.cssText = "position:fixed;inset:10px;-webkit-app-region:drag;app-region:drag;cursor:grab";
				handle.title = "Drag to move. Wheel, + and - resize. Esc closes.";
				doc.body.append(handle);

				const scaleBy = (factor: number) => sizeTo(opened, opened.innerWidth * factor, opened.innerHeight * factor);
				opened.addEventListener(
					"wheel",
					event => {
						event.preventDefault();
						scaleBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
					},
					{ passive: false }
				);

				// Corner buttons fade out when idle, like the main view's bar. A faded button still takes
				// the mouse, so the corner answers even when the drag handle keeps mouse moves to itself.
				const buttons: HTMLElement[] = [];
				let idle = 0;
				const wake = () => {
					for (const b of buttons) b.style.opacity = "0.5";
					opened.clearTimeout(idle);
					idle = opened.setTimeout(() => {
						for (const b of buttons) b.style.opacity = "0";
					}, IDLE_HIDE_MS);
				};
				// drawn as icons: a text "+" sits on the font's baseline, not in the middle of its circle
				const button = (path: string, right: number, hint: string, act: () => void) => {
					const b = doc.createElement("div");
					b.title = hint;
					b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="${path}"/></svg>`;
					b.style.cssText =
						`position:fixed;top:8px;right:${right}px;width:28px;height:28px;box-sizing:border-box;border-radius:50%;` +
						"display:grid;place-items:center;color:rgba(255,255,255,0.8);background:rgba(0,0,0,0.45);" +
						"border:1px solid rgba(255,255,255,0.12);backdrop-filter:blur(12px);" +
						"opacity:0;transition:opacity 0.4s ease,background 0.2s ease,color 0.2s ease;cursor:pointer;user-select:none;-webkit-app-region:no-drag;app-region:no-drag;z-index:2";
					b.addEventListener("mouseenter", () => {
						wake();
						b.style.opacity = "1";
						b.style.color = "#fff";
						b.style.background = "rgba(255,255,255,0.16)";
					});
					b.addEventListener("mouseleave", () => {
						b.style.color = "rgba(255,255,255,0.8)";
						b.style.background = "rgba(0,0,0,0.45)";
						wake();
					});
					b.addEventListener("click", act);
					doc.body.append(b);
					buttons.push(b);
				};
				for (const sign of ["mousemove", "mousedown", "wheel", "keydown", "focus"]) opened.addEventListener(sign, wake, true);
				doc.documentElement.addEventListener("mouseenter", wake);
				button("M6 6l12 12M18 6L6 18", 8, "Close (Esc)", () => opened.close());
				button("M12 5v14M5 12h14", 42, "Bigger (+ or wheel up)", () => scaleBy(1.25));
				button("M5 12h14", 76, "Smaller (- or wheel down)", () => scaleBy(0.8));
				wake();

				// its own keys; everything else goes to the visualizer as if typed there
				opened.addEventListener("keydown", event => {
					if (event.key === "Escape") opened.close();
					else if (event.key === "+" || event.key === "=") scaleBy(1.25);
					else if (event.key === "-" || event.key === "_") scaleBy(0.8);
					else window.dispatchEvent(new KeyboardEvent("keydown", { key: event.key }));
				});

				opened.addEventListener("resize", hooks.onResize);
				opened.addEventListener("resize", () => remember(opened));
				// closed with its own button, or by Spotify opening its miniplayer in the same slot
				opened.addEventListener("pagehide", () => remember(opened), { once: true });
				opened.addEventListener("pagehide", comeBack, { once: true });
				hooks.onMove(true);
			})
			.catch(err => Spicetify.showNotification(`Picture-in-picture: ${String(err?.message ?? err)}`, true));
	};

	return {
		toggle: () => (pip ? pip.close() : open()),
		// the page is going: take the window with it
		close: () => {
			closed = true;
			const leaving = pip;
			pip = null;
			leaving?.close();
		}
	};
}
