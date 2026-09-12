// A full-screen field of one static phrase, printed as ASCII on a canvas.
//
// The phrase is tiled across a grid that fills the canvas (no scroll). The grid
// resolution is derived from the canvas size, so a smaller screen gets fewer,
// larger characters. An optional brightness bitmap lights up a region: outside
// it the text is faint, inside it the text lights up. Random character slots
// flicker to other glyphs for a few seconds, then settle back.

import { bandSpread, colorForRgb, hash01, hexToRgb, noise2, voidErase } from './lookup.js';

// target ~77 rows of cells so the field reads as dense at a 16:9 viewport.
// the cell size is derived from the viewport, so the density holds at any
// resolution.
const TARGET_ROWS = 77;

export interface GlyphFieldOptions {
	atlas: string;
	/** the phrase that fills the field */
	phrase: string;
	/** white on a dark ground */
	dark?: boolean;
	/** font family for the glyphs */
	font?: string;
	/** the background the text is printed on (the canvas is filled with it) */
	background?: string;
	/**
	 * the ink color the glyphs are printed in. The bitmap's brightness controls
	 * how much of the ink shows through (a 12% floor keeps the faint edges
	 * visible); the rest is the background.
	 */
	ink?: string;
	/**
	 * the brightness bitmap and its dimensions. The bitmap is sampled down to the
	 * current grid so the shape keeps its detail at any size. Pass `null` (or omit
	 * it) for a plain phrase field with no lit region.
	 */
	bitmap?: number[] | null;
	bitmapCols?: number;
	bitmapRows?: number;
	/** fraction of the width the lit region occupies (0-1) */
	regionWidthFraction?: number;
	/** fraction of the height the lit region occupies (0-1) */
	regionHeightFraction?: number;
	/**
	 * fraction of the width where the hand's left edge sits (0-1). When unset the
	 * hand is anchored to the right edge.
	 */
	regionXFraction?: number;
	/**
	 * fraction of the height where the hand's top edge sits (0-1). When unset the
	 * hand is anchored to the bottom edge.
	 */
	regionYFraction?: number;
	/** the width/height ratio of a single glyph cell (monospace aspect) */
	cellAspect?: number;
	/** how often a flickering cell re-rolls its glyph (ms) */
	flickerIntervalMs?: number;
	/** how long a flicker lasts before it settles (ms) */
	flickerDurationMs?: number;
	/** how many cells flicker at once (0 disables the effect) */
	flickerCount?: number;
	/**
	 * the hover void: radius of the eraser that follows the pointer, as a
	 * fraction of the canvas height (0 disables the effect)
	 */
	voidRadiusFraction?: number;
	/**
	 * how far the void's edge wanders from a clean circle (0 = circle,
	 * 1 = very blobby)
	 */
	voidJitter?: number;
	/**
	 * the click band: how long it takes to travel from the click point to fully
	 * off the screen (ms). The band's speed is derived from this and the distance
	 * to the far corner, so it always takes the same time to finish no matter the
	 * screen size.
	 */
	clickDurationMs?: number;
	/**
	 * the click band: width of the highlighted band, as a fraction of the canvas
	 * height (0 disables the effect)
	 */
	clickBandWidthFraction?: number;
	/**
	 * the click band: how far the edge wanders from a clean circle (0 = circle,
	 * 1 = very blobby)
	 */
	clickJitter?: number;
	/**
	 * the click band: peak highlight strength, 0-1 (how far a glyph is blended
	 * toward the highlight color at the band's center)
	 */
	clickStrength?: number;
	/**
	 * the click band: fraction of the letters under the band that light up (the
	 * rest are left as gaps, so the band reads as sparse, not solid). 0-1
	 */
	clickDensity?: number;
	/**
	 * the click band: the color the glyphs are highlighted toward (defaults to
	 * white in dark mode, the ink in light mode)
	 */
	clickColor?: string;
}

// how many click waves can be in flight at once (oldest is dropped first)
const MAX_WAVES = 8;

// a tiny deterministic PRNG so the flicker is stable across re-renders
function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(a ^ (a >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class GlyphField {
	private ctx: CanvasRenderingContext2D;
	private atlas: string;
	private phrase: string;
	private dark: boolean;
	private font: string;
	private background: string;
	// the ink color the hand's core is printed in, as rgb
	private ink: [number, number, number];
	// the faint field color (outside the hand), as rgb
	private field: [number, number, number];

	// the brightness bitmap that lights up a region (0-255 per cell), or null for
	// a plain phrase field with no lit region
	private bitmap: number[] | null;
	private bitmapCols = 0;
	private bitmapRows = 0;
	private regionWidthFraction: number;
	private regionHeightFraction: number;
	private regionXFraction: number | null;
	private regionYFraction: number | null;

	// the current grid (recomputed on resize so it scales with the canvas)
	private cols = 0;
	private rows = 0;

	// the base character per cell (atlas index), or -1 for a space
	private base: Int16Array = new Int16Array(0);

	// the hand brightness per cell (0-255), or null for a plain backdrop
	private brightness: number[] | null;

	// per-cell flicker state: start time, or -1 when not flickering
	private flickerStart: Float64Array = new Float64Array(0);

	private flickerInterval: number;
	private flickerDuration: number;
	private flickerCount: number;

	// the hover void: pointer position (canvas px), whether it is on the
	// canvas, and a 0-1 strength that eases in/out so the void fades instead
	// of popping
	private voidRadiusFraction: number;
	private voidJitter: number;
	private pointerX = 0;
	private pointerY = 0;
	private pointerActive = false;
	private voidStrength = 0;
	private lastTime = 0;

	// the click waves: rings of highlighted glyphs expanding from where the
	// pointer clicked. Each ring grows at clickSpeed px/ms and is done once its
	// trailing edge has passed the farthest corner of the canvas (so it moves
	// off the screen rather than fading in place).
	private waves: {
		x: number;
		y: number;
		start: number;
		maxR: number;
		r: number;
		envelope: number;
	}[] = [];
	private clickDurationMs: number;
	private clickBandWidthFraction: number;
	private clickJitter: number;
	private clickStrength: number;
	private clickDensity: number;
	private clickColor: [number, number, number];
	private clickColorExplicit: boolean;

	// the background as rgb, so the void can blend glyphs into it
	private bg: [number, number, number];
	private viewW = 0;
	private viewH = 0;

	private cellW = 0;
	private cellH = 0;
	private fontSize = 0;
	private cellAspect: number;

	// where the lit region sits on the grid (in cells), recomputed on resize
	private regionCol0 = 0;
	private regionRow0 = 0;
	private regionCols = 0;
	private regionRows = 0;

	// the current visible glyph per cell (atlas index), rebuilt each frame
	private visible: Int16Array = new Int16Array(0);

	private rng: () => number;

	constructor(canvas: HTMLCanvasElement, options: GlyphFieldOptions) {
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('ascii-renderer: no 2d context');
		this.ctx = ctx;
		this.atlas = options.atlas;
		this.phrase = options.phrase;
		this.dark = options.dark ?? false;
		// the default mono stack (Geist Mono first, then common fallbacks)
		this.font =
			options.font ??
			'GeistMono, ui-monospace, SFMono-Regular, Roboto Mono, Menlo, Monaco, Liberation Mono, DejaVu Sans Mono, Courier New, monospace';
		this.background = options.background ?? (this.dark ? '#181818' : '#f1eee7');
		// the hand's core ink and the faint field color. In dark mode the field
		// is a near-black grey just above the background and the core is a mid
		// grey; in light mode they flip.
		const inkHex = options.ink ?? (this.dark ? '#9e9e9e' : '#232323');
		this.ink = hexToRgb(inkHex);
		this.field = hexToRgb(this.dark ? '#1f1f1f' : '#e5e2d8');
		this.cellAspect = options.cellAspect ?? 0.55;
		this.bitmap = options.bitmap ?? null;
		this.bitmapCols = options.bitmapCols ?? 0;
		this.bitmapRows = options.bitmapRows ?? 0;
		// the hand fills the right half of the field, anchored to the bottom
		// right corner
		this.regionWidthFraction = options.regionWidthFraction ?? 0.5;
		this.regionHeightFraction = options.regionHeightFraction ?? 0.9;
		this.regionXFraction = options.regionXFraction ?? null;
		this.regionYFraction = options.regionYFraction ?? null;
		this.flickerInterval = options.flickerIntervalMs ?? 400;
		this.flickerDuration = options.flickerDurationMs ?? 3000;
		this.flickerCount = options.flickerCount ?? 800;
		this.voidRadiusFraction = options.voidRadiusFraction ?? 0.24;
		this.voidJitter = options.voidJitter ?? 0.25;
		this.clickDurationMs = options.clickDurationMs ?? 1500;
		this.clickBandWidthFraction = options.clickBandWidthFraction ?? 0.25;
		this.clickJitter = options.clickJitter ?? 0.25;
		this.clickStrength = options.clickStrength ?? 0.8;
		this.clickDensity = options.clickDensity ?? 0.5;
		this.clickColorExplicit = options.clickColor != null;
		this.clickColor = hexToRgb(options.clickColor ?? (this.dark ? '#ffffff' : '#232323'));
		this.bg = hexToRgb(this.background);
		this.brightness = null;
		this.rng = mulberry32(0x187);
	}

	// move the hover void to (x, y) in canvas pixels
	pointer(x: number, y: number) {
		this.pointerX = x;
		this.pointerY = y;
		this.pointerActive = true;
	}

	// remove the pointer; the void fades out in place
	pointerClear() {
		this.pointerActive = false;
	}

	// spawn a click wave: a ring of highlighted glyphs expanding from (x, y)
	// in canvas pixels. The wave is done once it has crossed the whole canvas.
	click(x: number, y: number) {
		if (this.viewW <= 0 || this.viewH <= 0) return;
		// the farthest corner from the click point
		const corner = Math.max(
			Math.hypot(x, y),
			Math.hypot(this.viewW - x, y),
			Math.hypot(x, this.viewH - y),
			Math.hypot(this.viewW - x, this.viewH - y)
		);
		// the band is a ring ~3 sigma wide, and its edge wanders by the jitter,
		// so it has fully left the canvas only once its inner edge (worst case)
		// has passed the farthest corner. Grow the radius to there, not to the
		// corner itself, or the tail of the band would sit on the corner and
		// fade out in place instead of moving off the screen.
		const sigma = (this.viewH * this.clickBandWidthFraction) / 2;
		const denom = 1 - this.clickJitter;
		const maxR = denom > 0 ? (corner + 3 * sigma) / denom : corner + 3 * sigma;
		this.waves.push({ x, y, start: this.lastTime, maxR, r: 0, envelope: 0 });
		if (this.waves.length > MAX_WAVES) this.waves.shift();
	}

	// swap the phrase that fills the field
	setPhrase(phrase: string) {
		this.phrase = phrase;
		if (this.cols > 0 && this.rows > 0) this.rebuildGrid();
	}

	// flip light/dark: re-derives the ink and background
	setDark(dark: boolean, ink?: string) {
		this.dark = dark;
		this.background = dark ? '#181818' : '#f1eee7';
		this.bg = hexToRgb(this.background);
		this.ink = hexToRgb(ink ?? (dark ? '#9e9e9e' : '#232323'));
		this.field = hexToRgb(dark ? '#1f1f1f' : '#e5e2d8');
		if (!this.clickColorExplicit) this.clickColor = hexToRgb(dark ? '#ffffff' : '#232323');
	}

	resize(width: number, height: number, dpr: number) {
		const canvas = this.ctx.canvas;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = width;
		this.viewH = height;

		// derive the cell size from the viewport so the field keeps its density at
		// any resolution. a minimum cell size keeps the text readable on small
		// screens (where the grid simply gets fewer, larger characters).
		const cellH = Math.max(8, height / TARGET_ROWS);
		const cellW = cellH * this.cellAspect;
		this.rows = Math.max(8, Math.round(height / cellH));
		this.cols = Math.max(16, Math.round(width / cellW));
		this.cellW = width / this.cols;
		this.cellH = height / this.rows;
		// size the font so a glyph is exactly one cell wide (measured off "M"),
		// which fills the cell with no horizontal gap
		const base = this.cellH;
		this.ctx.font = `${base}px ${this.font}`;
		const w = this.ctx.measureText('M').width || 0.6 * base;
		this.fontSize = (this.cellW / w) * base;

		this.rebuildGrid();
	}

	// (re)build the base phrase and the lit-region brightness for the current grid
	private rebuildGrid() {
		const { cols, rows } = this;
		const cells = cols * rows;
		this.base = new Int16Array(cells);
		this.flickerStart = new Float64Array(cells).fill(-1);
		this.visible = new Int16Array(cells);

		// the phrase, tiled across the whole grid. each row starts at a hashed
		// offset so the rows don't line up into a diagonal pattern
		const phrase = this.phrase;
		for (let r = 0; r < rows; r++) {
			const offset = Math.floor(hash01(r * 0x9e3779b9) * phrase.length);
			for (let c = 0; c < cols; c++) {
				const ch = phrase[(offset + c) % phrase.length];
				this.base[r * cols + c] = this.atlas.indexOf(ch);
			}
		}

		// the lit region: where it sits on the grid, and its brightness sampled from
		// the bitmap
		this.brightness = null;
		if (this.bitmap && this.bitmapCols > 0 && this.bitmapRows > 0) {
			const regionCols = Math.max(8, Math.round(cols * this.regionWidthFraction));
			const regionRows = Math.max(4, Math.round(rows * this.regionHeightFraction));
			this.regionCols = regionCols;
			this.regionRows = regionRows;
			this.regionCol0 =
				this.regionXFraction != null
					? Math.min(cols - regionCols, Math.max(0, Math.round(cols * this.regionXFraction)))
					: cols - regionCols; // anchored to the right
			this.regionRow0 =
				this.regionYFraction != null
					? Math.min(rows - regionRows, Math.max(0, Math.round(rows * this.regionYFraction)))
					: rows - regionRows; // anchored to the bottom
			this.brightness = this.sampleBitmap(regionCols, regionRows);
		}
	}

	// sample the bitmap down to regionCols x regionRows. Each output cell is the
	// average of the bitmap cells it covers, so the shape is preserved.
	private sampleBitmap(regionCols: number, regionRows: number): number[] {
		const { bitmap, bitmapCols, bitmapRows } = this;
		if (!bitmap) return new Array<number>(regionCols * regionRows).fill(0);
		const out = new Array<number>(regionCols * regionRows);
		for (let r = 0; r < regionRows; r++) {
			const y0 = Math.floor((r / regionRows) * bitmapRows);
			const y1 = Math.max(y0 + 1, Math.floor(((r + 1) / regionRows) * bitmapRows));
			for (let c = 0; c < regionCols; c++) {
				const x0 = Math.floor((c / regionCols) * bitmapCols);
				const x1 = Math.max(x0 + 1, Math.floor(((c + 1) / regionCols) * bitmapCols));
				let sum = 0;
				let n = 0;
				for (let y = y0; y < y1; y++) {
					for (let x = x0; x < x1; x++) {
						sum += bitmap[y * bitmapCols + x];
						n++;
					}
				}
				out[r * regionCols + c] = n ? sum / n : 0;
			}
		}
		return out;
	}

	// advance the flicker: start new flickers, expire old ones, re-roll active
	private updateFlicker(time: number) {
		const { base, flickerStart, visible, cols, rows } = this;
		const cells = cols * rows;
		const rng = this.rng;

		// expire flickers that have run their course
		let active = 0;
		for (let i = 0; i < cells; i++) {
			if (flickerStart[i] >= 0 && time - flickerStart[i] >= this.flickerDuration) {
				flickerStart[i] = -1;
			} else if (flickerStart[i] >= 0) {
				active++;
			}
		}

		// start new flickers up to the target count
		let guard = 0;
		while (active < this.flickerCount && guard++ < this.flickerCount * 4) {
			const i = Math.floor(rng() * cells);
			if (flickerStart[i] < 0) {
				flickerStart[i] = time;
				active++;
			}
		}

		// build the visible glyph for every cell
		for (let i = 0; i < cells; i++) {
			const b = base[i];
			if (flickerStart[i] >= 0) {
				// re-roll the glyph on each interval tick
				const step = Math.floor((time - flickerStart[i]) / this.flickerInterval);
				// hash the cell + step so each tick is a stable random glyph
				const h = mulberry32((i * 2654435761 + step * 40503) >>> 0);
				visible[i] = Math.floor(h() * this.atlas.length);
			} else {
				visible[i] = b;
			}
		}
	}

	render(time = 0) {
		const ctx = this.ctx;
		const { cols, rows, cellW, cellH, fontSize } = this;
		if (cols <= 0 || rows <= 0) return;
		// paint the background, then print the single field on top
		ctx.fillStyle = this.background;
		ctx.fillRect(0, 0, cols * cellW, rows * cellH);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.font = `${fontSize}px ${this.font}`;

		this.updateFlicker(time);

		// the hover void: ease its strength toward the pointer state, then work
		// out the bounding box of cells it can reach (so the per-cell cost is
		// paid only near the pointer)
		const dt = Math.min(100, Math.max(0, time - this.lastTime));
		this.lastTime = time;
		const target = this.pointerActive ? 1 : 0;
		this.voidStrength += (target - this.voidStrength) * (1 - Math.exp(-dt / 120));
		if (target === 0 && this.voidStrength < 0.001) this.voidStrength = 0;

		const voidBase = this.viewH * this.voidRadiusFraction;
		const voidOn = this.voidStrength > 0.001 && voidBase > 0;
		const voidR = voidBase * (1 + this.voidJitter); // max reach, edge wander included
		const vMinC = voidOn ? Math.max(0, Math.floor((this.pointerX - voidR) / cellW)) : 1;
		const vMaxC = voidOn ? Math.min(cols, Math.ceil((this.pointerX + voidR) / cellW)) : 0;
		const vMinR = voidOn ? Math.max(0, Math.floor((this.pointerY - voidR) / cellH)) : 1;
		const vMaxR = voidOn ? Math.min(rows, Math.ceil((this.pointerY + voidR) / cellH)) : 0;

		// the click bands: rings of highlighted glyphs expanding from the click
		// point. the band is a ring, so only the letters under it light up.
		const waveSigma = (this.viewH * this.clickBandWidthFraction) / 2;
		const waves = this.waves;
		// the band always takes this long to travel from the click point to fully
		// off the screen, no matter the screen size. Each band's speed is derived
		// from its own distance (maxR) and this fixed duration.
		const duration = this.clickDurationMs;
		for (let i = waves.length - 1; i >= 0; i--) {
			const wv = waves[i];
			const t = time - wv.start;
			const speed = wv.maxR / duration;
			wv.r = Math.min(wv.maxR, t * speed);
			if (t < 250) wv.envelope = t / 250;
			else if (t < duration) wv.envelope = 1;
			else if (t < duration + 1000) wv.envelope = (duration + 1000 - t) / 1000;
			else wv.envelope = 0;
			if (wv.envelope <= 0) waves.splice(i, 1);
		}
		const waveOn = waveSigma > 0 && this.clickStrength > 0 && waves.length > 0;

		const { visible, brightness, regionCol0, regionRow0, regionCols, regionRows } = this;
		for (let r = 0; r < rows; r++) {
			const y = (r + 0.5) * cellH;
			for (let c = 0; c < cols; c++) {
				const idx = r * cols + c;
				const gi = visible[idx];
				if (gi < 0) continue; // space in the phrase
				let glyph = this.atlas[gi];
				if (!glyph) continue;

				// the lit region is brighter; everything else is the faint end
				let col: [number, number, number];
				if (
					brightness &&
					c >= regionCol0 &&
					c < regionCol0 + regionCols &&
					r >= regionRow0 &&
					r < regionRow0 + regionRows
				) {
					const hb = brightness[(r - regionRow0) * regionCols + (c - regionCol0)];
					col = colorForRgb(hb, this.field, this.ink);
				} else {
					// outside the hand: the faint field color
					col = this.field;
				}

				// the hover void erases the glyphs around the pointer, blending
				// them into the background. The noise breaks up the edge so it is
				// not a clean circle, and the falloff means the further a cell is
				// from the pointer, the less of it is removed.
				if (voidOn && c >= vMinC && c < vMaxC && r >= vMinR && r < vMaxR) {
					const dx = (c + 0.5) * cellW - this.pointerX;
					const dy = (r + 0.5) * cellH - this.pointerY;
					const n = noise2(c * 0.25, r * 0.25);
					const e = voidErase(Math.hypot(dx, dy), voidBase, n, this.voidJitter) * this.voidStrength;
					if (e > 0) {
						col = [
							col[0] + (this.bg[0] - col[0]) * e,
							col[1] + (this.bg[1] - col[1]) * e,
							col[2] + (this.bg[2] - col[2]) * e
						];
					}
				}

				// the click band: a ring of highlighted glyphs. only the letters
				// under it light up, and they flicker to other characters while
				// lit. applied after the void so the band covers it. the noise
				// wanders the edge so it is not a clean circle.
				let bandS = 0;
				if (waveOn) {
					const x = (c + 0.5) * cellW;
					for (let w = 0; w < waves.length; w++) {
						const wv = waves[w];
						const dx = x - wv.x;
						const dy = y - wv.y;
						const d2 = dx * dx + dy * dy;
						const outer = wv.r * (1 + this.clickJitter) + waveSigma * 3;
						const inner = Math.max(0, wv.r * (1 - this.clickJitter) - waveSigma * 3);
						if (d2 > outer * outer || d2 < inner * inner) continue;
						const s =
							bandSpread(
								Math.sqrt(d2),
								wv.r,
								waveSigma,
								noise2(c * 0.25, r * 0.25),
								this.clickJitter,
								this.clickStrength
							) * wv.envelope;
						if (s > bandS) bandS = s;
					}
				}
				if (bandS > 0) {
					// gaps: only a fraction of the letters under the band light
					// up (the rest stay as gaps), so the band reads as sparse
					// rather than a solid wall of highlighted text
					if (hash01(idx * 0x9e3779b9) < this.clickDensity) {
						// the lit letters flicker to other characters. Each
						// letter has its own phase offset, so they re-roll at
						// different times instead of all at once
						const phase = Math.floor(hash01(idx * 0x85ebca6b) * 60);
						const step = Math.floor((time + phase) / 60);
						const g = hash01((idx * 31 + step * 1000003) >>> 0);
						glyph = this.atlas[Math.floor(g * this.atlas.length)];
						col = [
							col[0] + (this.clickColor[0] - col[0]) * bandS,
							col[1] + (this.clickColor[1] - col[1]) * bandS,
							col[2] + (this.clickColor[2] - col[2]) * bandS
						];
					}
				}

				ctx.fillStyle = `rgb(${Math.round(col[0])},${Math.round(col[1])},${Math.round(col[2])})`;
				ctx.fillText(glyph, (c + 0.5) * cellW, y);
			}
		}
	}

	destroy() {
		this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
	}
}
