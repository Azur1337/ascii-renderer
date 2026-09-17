// A full-screen field of one static phrase, printed as ASCII on a canvas.
//
// The phrase is tiled across a grid that fills the canvas (no scroll). The grid
// resolution is derived from the canvas size, so a smaller screen gets fewer,
// larger characters. An optional brightness bitmap lights up a region: outside
// it the text is faint, inside it the text lights up. Random character slots
// flicker to other glyphs for a few seconds, then settle back.

import { bandSpread, curveFor, hash01, hexToRgb, noise2, voidErase } from './lookup.js';

// target ~77 rows of cells so the field reads as dense at a 16:9 viewport.
// the cell size is derived from the viewport, so the density holds at any
// resolution.
export const TARGET_ROWS = 77;

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
	 * current grid so the shape keeps its detail at any size. Omit it for a plain
	 * phrase field with no lit region.
	 */
	bitmap?: number[];
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
	/**
	 * a fixed cell height in CSS pixels. When set, the field uses this cell size
	 * instead of deriving it from the canvas height, so the text stays the same
	 * size no matter how tall the canvas is (a tall section backdrop, for
	 * example). Omit it to derive the cell size from the canvas.
	 */
	cellHeight?: number;
	/**
	 * fraction of cells (0-1) swapped for random atlas glyphs. Breaks up the
	 * phrase's lockstep repetition so a tiled field reads as texture instead of
	 * a repeating pattern. 0 (default) keeps the phrase clean.
	 */
	scatter?: number;
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

	// the brightness bitmap that lights up a region (0-255 per cell), or undefined
	// for a plain phrase field with no lit region
	private bitmap?: number[];
	private bitmapCols = 0;
	private bitmapRows = 0;
	private regionWidthFraction: number;
	private regionHeightFraction: number;
	private regionXFraction?: number;
	private regionYFraction?: number;

	// the current grid (recomputed on resize so it scales with the canvas)
	private cols = 0;
	private rows = 0;

	// the base character per cell (atlas index), or -1 for a space
	private base: Int16Array = new Int16Array(0);

	// the hand brightness per cell (0-255), or undefined for a plain backdrop
	private brightness?: number[];

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
	// the visible viewport height in CSS px (0 = the canvas is the viewport);
	// sizes the click band so a canvas taller than the screen doesn't get a
	// screen-swallowing ring
	private viewportH = 0;
	// the height the click band is sized against: the viewport when known and
	// smaller than the canvas, else the canvas itself
	private get clickRefH(): number {
		return this.viewportH > 0 ? Math.min(this.viewportH, this.viewH) : this.viewH;
	}

	private cellW = 0;
	private cellH = 0;
	private fontSize = 0;
	private cellAspect: number;
	// a fixed cell height in CSS px, or null to derive it from the canvas
	private cellHeight?: number;
	// fraction of cells swapped for random glyphs (breaks up the phrase pattern)
	private scatter: number;
	// the last device pixel ratio, so setCellHeight can re-derive the grid
	private dpr = 1;

	// where the lit region sits on the grid (in cells), recomputed on resize
	private regionCol0 = 0;
	private regionRow0 = 0;
	private regionCols = 0;
	private regionRows = 0;

	// the current visible glyph per cell (atlas index), rebuilt each frame
	private visible: Int16Array = new Int16Array(0);

	// last rendered state per cell, so a frame only redraws cells that changed.
	// -1 sentinel means "nothing rendered here yet" (forces a first draw).
	private prevGlyph: Int16Array = new Int16Array(0);
	private prevKey: Int32Array = new Int32Array(0);
	// forces a full redraw of every cell (set on resize / theme / phrase change /
	// first frame)
	private needsFullRedraw = true;

	// the baked glyph atlas: every atlas glyph rendered once to an offscreen
	// canvas, so a frame blits with drawImage instead of re-shaping text with
	// fillText (live text layout is the main-thread cost that made the field
	// janky). Baked at device-pixel (dpr) resolution so the per-frame blit is a
	// 1:1 copy (no blur). The atlas is white in dark mode (glyphs are lighter
	// than the ground) and black in light mode (glyphs are darker); the per-cell
	// color is applied as a globalAlpha tint at blit time. Rebuilt on resize
	// (cell size / font / dpr change) and on theme change.
	private atlasCanvas: HTMLCanvasElement | null = null;
	private atlasCtx: CanvasRenderingContext2D | null = null;

	// per-frame scratch, reused across frames to avoid per-cell allocation
	private col: [number, number, number] = [0, 0, 0];

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
		this.cellHeight = options.cellHeight;
		this.scatter = options.scatter ?? 0;
		this.bitmap = options.bitmap;
		this.bitmapCols = options.bitmapCols ?? 0;
		this.bitmapRows = options.bitmapRows ?? 0;
		// the hand fills the right half of the field, anchored to the bottom
		// right corner
		this.regionWidthFraction = options.regionWidthFraction ?? 0.5;
		this.regionHeightFraction = options.regionHeightFraction ?? 0.9;
		this.regionXFraction = options.regionXFraction;
		this.regionYFraction = options.regionYFraction;
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
		// default the highlight to the ink color so it never exceeds the hand's
		// core brightness (an explicit clickColor still wins)
		this.clickColor = hexToRgb(options.clickColor ?? inkHex);
		this.bg = hexToRgb(this.background);
		this.brightness = undefined;
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
		// the band's geometry is viewport-relative: on a canvas taller than the
		// viewport (a mobile section backdrop) the raw canvas height would make
		// the ring wider than the screen, lighting every visible letter at once
		const refH = this.clickRefH;
		// the farthest the ring has to travel to leave the visible area. when
		// the canvas is (about) the viewport, that is the farthest canvas corner
		// from the click point; on a taller canvas the visible box is refH tall
		// and contains the click, so bound it by the box's diagonal.
		const corner =
			refH >= this.viewH
				? Math.max(
						Math.hypot(x, y),
						Math.hypot(this.viewW - x, y),
						Math.hypot(x, this.viewH - y),
						Math.hypot(this.viewW - x, this.viewH - y)
					)
				: Math.hypot(Math.max(x, this.viewW - x), refH);
		// the band is a ring ~3 sigma wide, and its edge wanders by the jitter,
		// so it has fully left the visible area only once its inner edge (worst
		// case) has passed the farthest corner. Grow the radius to there, not to
		// the corner itself, or the tail of the band would sit on the corner and
		// fade out in place instead of moving off the screen.
		const sigma = (refH * this.clickBandWidthFraction) / 2;
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

	// flip light/dark: re-derives the ink and background, and re-bakes the atlas
	// (its color flips with the theme: white in dark, black in light)
	setDark(dark: boolean, ink?: string) {
		this.dark = dark;
		this.background = dark ? '#181818' : '#f1eee7';
		this.bg = hexToRgb(this.background);
		this.ink = hexToRgb(ink ?? (dark ? '#9e9e9e' : '#232323'));
		this.field = hexToRgb(dark ? '#1f1f1f' : '#e5e2d8');
		// follow the ink color (set just above) so the highlight never exceeds the
		// hand's core brightness (an explicit clickColor still wins)
		if (!this.clickColorExplicit) this.clickColor = this.ink;
		if (this.cols > 0 && this.rows > 0) this.bakeAtlas();
		// the theme flip changes the color key of every cell (and the background
		// itself), so the whole field must be repainted from scratch
		this.needsFullRedraw = true;
	}

	resize(width: number, height: number, dpr: number) {
		const canvas = this.ctx.canvas;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.viewW = width;
		this.viewH = height;
		this.dpr = dpr;

		// derive the cell size from the viewport so the field keeps its density at
		// any resolution. a minimum cell size keeps the text readable on small
		// screens (where the grid simply gets fewer, larger characters). a fixed
		// cellHeight (when set) overrides the derivation, so the text stays the
		// same size no matter how tall the canvas is.
		const cellH = this.cellHeight ?? Math.max(8, height / TARGET_ROWS);
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
		this.bakeAtlas();
	}

	// set a fixed cell height in CSS px (omit it to revert to the canvas-derived
	// size). re-derives the grid if the field is already sized.
	setCellHeight(h?: number) {
		this.cellHeight = h;
		if (this.viewW > 0) this.resize(this.viewW, this.viewH, this.dpr);
	}

	// update the lit region's fractions after construction. hosts that measure
	// the region off a canvas whose size changes after boot (e.g. a mobile
	// section that grows as reveals/fonts land) would otherwise keep sampling
	// the bitmap into a stale, stretched region — which smears the shape and
	// turns its per-cell noise into random highlights. re-derives the grid.
	setRegion(region: { width?: number; height?: number; x?: number; y?: number }) {
		if (region.width !== undefined) this.regionWidthFraction = region.width;
		if (region.height !== undefined) this.regionHeightFraction = region.height;
		if (region.x !== undefined) this.regionXFraction = region.x;
		if (region.y !== undefined) this.regionYFraction = region.y;
		if (this.cols > 0) this.rebuildGrid();
	}

	// tell the field how tall the visible viewport is (CSS px). the click
	// band's ring width and travel distance are sized against this instead of
	// the canvas height, so a canvas taller than the viewport (a mobile
	// section backdrop) gets a screen-sized ring, not a screen-swallowing one.
	// 0 (default) = the canvas is the viewport.
	setViewportHeight(height: number) {
		this.viewportH = height;
	}

	// bake the glyph atlas: render every atlas glyph once to an offscreen canvas.
	// A frame then blits a glyph with drawImage (a cheap texture copy) instead of
	// re-shaping it with fillText (live text layout, the main-thread cost that
	// made the field janky). Baked at device-pixel (dpr) resolution so the blit
	// is a 1:1 copy. The atlas is white in dark mode and black in light mode;
	// the per-cell color is applied as a globalAlpha tint at blit time.
	private bakeAtlas() {
		const { atlas, cellW, cellH, fontSize, font, dpr } = this;
		if (cellW <= 0 || cellH <= 0) return;
		const w = Math.ceil(atlas.length * cellW * dpr);
		const h = Math.ceil(cellH * dpr);
		if (!this.atlasCanvas) {
			this.atlasCanvas = document.createElement('canvas');
			const c = this.atlasCanvas.getContext('2d');
			if (!c) return;
			this.atlasCtx = c;
		}
		const ac = this.atlasCtx!;
		this.atlasCanvas.width = w; // also clears the canvas
		this.atlasCanvas.height = h;
		ac.setTransform(dpr, 0, 0, dpr, 0, 0);
		ac.fillStyle = this.dark ? '#fff' : '#000';
		ac.textAlign = 'center';
		ac.textBaseline = 'middle';
		ac.font = `${fontSize}px ${font}`;
		for (let i = 0; i < atlas.length; i++) {
			const ch = atlas[i];
			if (!ch || ch === ' ') continue;
			ac.fillText(ch, (i + 0.5) * cellW, 0.5 * cellH);
		}
	}

	// the globalAlpha that tints the (white/black) atlas glyph to the target
	// color over the background. In dark mode the atlas is white and the glyph
	// sits between the ground and white: a = (col - bg) / (255 - bg). In light
	// mode the atlas is black and the glyph sits between the ground and black:
	// a = (bg - col) / bg. Averaged over the channels (the colors are near-
	// grayscale, so the per-channel difference is sub-pixel).
	private alphaFor(col: [number, number, number]): number {
		const bg = this.bg;
		let a: number;
		if (this.dark) {
			const d0 = 255 - bg[0];
			const d1 = 255 - bg[1];
			const d2 = 255 - bg[2];
			a =
				(d0 > 0 ? (col[0] - bg[0]) / d0 : 0) +
				(d1 > 0 ? (col[1] - bg[1]) / d1 : 0) +
				(d2 > 0 ? (col[2] - bg[2]) / d2 : 0);
		} else {
			const d0 = bg[0];
			const d1 = bg[1];
			const d2 = bg[2];
			a =
				(d0 > 0 ? (bg[0] - col[0]) / d0 : 1) +
				(d1 > 0 ? (bg[1] - col[1]) / d1 : 1) +
				(d2 > 0 ? (bg[2] - col[2]) / d2 : 1);
		}
		a /= 3;
		return a < 0 ? 0 : a > 1 ? 1 : a;
	}

	// (re)build the base phrase and the lit-region brightness for the current grid
	private rebuildGrid() {
		const { cols, rows } = this;
		const cells = cols * rows;
		this.base = new Int16Array(cells);
		this.flickerStart = new Float64Array(cells).fill(-1);
		this.visible = new Int16Array(cells);
		// the grid changed, so the last-rendered state is stale: re-allocate the
		// prev-state arrays and force a full redraw of every cell
		this.prevGlyph = new Int16Array(cells).fill(-1);
		this.prevKey = new Int32Array(cells).fill(-1);
		this.needsFullRedraw = true;

		// the phrase, tiled across the whole grid. each row starts at a hashed
		// offset so the rows don't line up into a diagonal pattern. a fraction of
		// cells are swapped for random glyphs (scatter) so the repetition reads as
		// texture instead of a clean wallpaper pattern.
		const phrase = this.phrase;
		const scatter = this.scatter;
		for (let r = 0; r < rows; r++) {
			const offset = Math.floor(hash01(r * 0x9e3779b9) * phrase.length);
			for (let c = 0; c < cols; c++) {
				const idx = r * cols + c;
				const ch = phrase[(offset + c) % phrase.length];
				let gi = this.atlas.indexOf(ch);
				if (scatter > 0 && hash01(idx * 0x85ebca6b) < scatter) {
					gi = Math.floor(hash01(idx * 0xc2b2ae35) * this.atlas.length);
				}
				this.base[idx] = gi;
			}
		}

		// the lit region: where it sits on the grid, and its brightness sampled from
		// the bitmap
		this.brightness = undefined;
		if (this.bitmap && this.bitmapCols > 0 && this.bitmapRows > 0) {
			const regionCols = Math.max(8, Math.round(cols * this.regionWidthFraction));
			const regionRows = Math.max(4, Math.round(rows * this.regionHeightFraction));
			this.regionCols = regionCols;
			this.regionRows = regionRows;
			this.regionCol0 =
				this.regionXFraction !== undefined
					? Math.min(cols - regionCols, Math.max(0, Math.round(cols * this.regionXFraction)))
					: cols - regionCols; // anchored to the right
			this.regionRow0 =
				this.regionYFraction !== undefined
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

		// start new flickers up to the target count. the target is capped to a
		// fraction of the grid: flickerCount is a desktop-scale number, and on a
		// small canvas (a phone field with few, large cells) an uncapped 800 would
		// leave every letter constantly re-rolling. on a full desktop grid the cap
		// never binds (800 < 5% of ~17k cells).
		const target = Math.min(this.flickerCount, Math.round(cells * 0.05));
		let guard = 0;
		while (active < target && guard++ < this.flickerCount * 4) {
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
		const { cols, rows, cellW, cellH } = this;
		if (cols <= 0 || rows <= 0) return;
		// the atlas is baked at the exact cell size, so blits are 1:1 and need no
		// smoothing (keeps the glyphs crisp at any dpr)
		ctx.imageSmoothingEnabled = false;

		this.updateFlicker(time);

		// the hover void: ease its strength toward the pointer state, then work
		// out the bounding box of cells it can reach (so the per-cell cost is
		// paid only near the pointer)
		const dt = Math.min(100, Math.max(0, time - this.lastTime));
		this.lastTime = time;
		const target = this.pointerActive ? 1 : 0;
		this.voidStrength += (target - this.voidStrength) * (1 - Math.exp(-dt / 120));
		if (target === 0 && this.voidStrength < 0.001) this.voidStrength = 0;

		// cap the void radius by a fraction of the canvas width so it stays a
		// reasonable size on narrow/portrait screens (phones) instead of
		// swallowing the viewport; on wide desktops the height-based value wins
		const voidBase = Math.min(this.viewH * this.voidRadiusFraction, this.viewW * 0.15);
		const voidOn = this.voidStrength > 0.001 && voidBase > 0;
		const voidR = voidBase * (1 + this.voidJitter); // max reach, edge wander included
		const vMinC = voidOn ? Math.max(0, Math.floor((this.pointerX - voidR) / cellW)) : 1;
		const vMaxC = voidOn ? Math.min(cols, Math.ceil((this.pointerX + voidR) / cellW)) : 0;
		const vMinR = voidOn ? Math.max(0, Math.floor((this.pointerY - voidR) / cellH)) : 1;
		const vMaxR = voidOn ? Math.min(rows, Math.ceil((this.pointerY + voidR) / cellH)) : 0;

		// the click bands: rings of highlighted glyphs expanding from the click
		// point. the band is a ring, so only the letters under it light up.
		// sized against the viewport (clickRefH), not the raw canvas height.
		const waveSigma = (this.clickRefH * this.clickBandWidthFraction) / 2;
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
			// no ramp-in: the band lights at full strength from the first frame.
			// (A ramp-in combined with the hard bandS threshold below delayed the
			// first visible light until the ring had already traveled ~200px, so
			// the wave appeared to start at the hover void's edge instead of at
			// the click point.) The ring's own Gaussian edge already fades each
			// cell in and out as it passes, so the wave needs no extra envelope
			// while traveling; the tail only matters after it has crossed the
			// canvas (which maxR guarantees it has by `duration`).
			if (t < duration) wv.envelope = 1;
			else if (t < duration + 1000) wv.envelope = (duration + 1000 - t) / 1000;
			else wv.envelope = 0;
			if (wv.envelope <= 0) waves.splice(i, 1);
		}
		const waveOn = waveSigma > 0 && this.clickStrength > 0 && waves.length > 0;

		const { visible, brightness, regionCol0, regionRow0, regionCols, regionRows } = this;
		const atlas = this.atlasCanvas;
		if (!atlas) return; // no atlas (shouldn't happen in a browser)
		const dpr = this.dpr;
		const col = this.col; // reused scratch, no per-cell allocation
		const prevGlyph = this.prevGlyph;
		const prevKey = this.prevKey;
		// dirty-cell redraw: only cells whose glyph or color changed since the
		// last frame are blitted. on a full redraw (first frame, resize, theme or
		// phrase change) the canvas may be stale, so the whole background is
		// painted once up front; afterwards only glyph->space cells are cleared.
		const fullRedraw = this.needsFullRedraw;
		if (fullRedraw) {
			ctx.fillStyle = this.background;
			ctx.fillRect(0, 0, cols * cellW, rows * cellH);
		}
		let lastKey = -1;

		for (let r = 0; r < rows; r++) {
			const y = (r + 0.5) * cellH;
			for (let c = 0; c < cols; c++) {
				const idx = r * cols + c;
				const gi = visible[idx];
				let glyph = gi >= 0 ? this.atlas[gi] : '';
				if (gi < 0 || !glyph) {
					if (fullRedraw) {
						prevGlyph[idx] = -1;
						prevKey[idx] = -1;
					} else if (prevGlyph[idx] >= 0) {
						// glyph -> space: clear the cell back to the background
						ctx.globalAlpha = 1;
						ctx.fillStyle = this.background;
						ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
						prevGlyph[idx] = -1;
						prevKey[idx] = -1;
					}
					continue;
				}

				// the lit region is brighter; everything else is the faint end
				if (
					brightness &&
					c >= regionCol0 &&
					c < regionCol0 + regionCols &&
					r >= regionRow0 &&
					r < regionRow0 + regionRows
				) {
					const hb = brightness[(r - regionRow0) * regionCols + (c - regionCol0)];
					const t = curveFor(hb / 255);
					col[0] = this.field[0] + (this.ink[0] - this.field[0]) * t;
					col[1] = this.field[1] + (this.ink[1] - this.field[1]) * t;
					col[2] = this.field[2] + (this.ink[2] - this.field[2]) * t;
				} else {
					// outside the hand: the faint field color
					col[0] = this.field[0];
					col[1] = this.field[1];
					col[2] = this.field[2];
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
						col[0] += (this.bg[0] - col[0]) * e;
						col[1] += (this.bg[1] - col[1]) * e;
						col[2] += (this.bg[2] - col[2]) * e;
					}
				}

				// the click band: a ring of highlighted glyphs. only the letters
				// under it light up, and they flicker to other characters while
				// lit. applied after the void so the band covers it. the noise
				// wanders the edge so it is not a clean circle. skipped entirely
				// when no wave is in flight (the common case), so the per-cell
				// cost is just the color + blit.
				if (waveOn) {
					const x = (c + 0.5) * cellW;
					let bandS = 0;
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
					// hard-edged ring: fully lit or not, no in-between tones (matches the
					// reference and keeps the dirty-cell count to just the ring's edge)
					bandS = bandS > 0.5 ? 1 : 0;
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
							col[0] += (this.clickColor[0] - col[0]) * bandS;
							col[1] += (this.clickColor[1] - col[1]) * bandS;
							col[2] += (this.clickColor[2] - col[2]) * bandS;
						}
					}
				}

				// the color key is the rounded rgb packed into an int, so the dirty
				// check below can compare it against the last frame in one int
				const cr = Math.round(col[0]);
				const cg = Math.round(col[1]);
				const cb = Math.round(col[2]);
				const key = (cr << 16) | (cg << 8) | cb;
				if (!fullRedraw && gi === prevGlyph[idx] && key === prevKey[idx]) {
					continue; // unchanged since the last frame: nothing to redraw
				}
				if (fullRedraw) {
					// run-batch the tint: the field is one color except the
					// hand/void/click, so globalAlpha is only touched when the key
					// changes (start each full redraw from a sentinel)
					if (key !== lastKey) {
						ctx.globalAlpha = this.alphaFor([cr, cg, cb]);
						lastKey = key;
					}
				} else {
					// the cell changed, so clear its rect back to the background first
					// (at full opacity) to wipe the stale glyph, then blit the new one
					// on top. without this the new glyph stacks on the old and the
					// partial-alpha tint accumulates frame over frame.
					ctx.globalAlpha = 1;
					ctx.fillStyle = this.background;
					ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
					// dirty cells are scattered, so set the tint per cell
					ctx.globalAlpha = this.alphaFor([cr, cg, cb]);
				}

				// blit the glyph from the baked atlas (a cheap texture copy). the
				// source rect is in the atlas's device pixels (baked at dpr), the
				// dest in css px (the dpr transform scales it to match), so it is a
				// 1:1 copy with no blur.
				ctx.drawImage(
					atlas,
					gi * cellW * dpr,
					0,
					cellW * dpr,
					cellH * dpr,
					c * cellW,
					r * cellH,
					cellW,
					cellH
				);
				// remember what we just rendered, so the next frame can skip it
				prevGlyph[idx] = gi;
				prevKey[idx] = key;
			}
		}

		// the full redraw is done; from here on only dirty cells are repainted
		if (fullRedraw) this.needsFullRedraw = false;
		// reset the tint for other canvas users (the next frame re-sets it for its
		// first run, so there is no cross-frame state to carry)
		ctx.globalAlpha = 1;
	}

	destroy() {
		this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
	}
}
