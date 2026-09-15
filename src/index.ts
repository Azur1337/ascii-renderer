import { GlyphField } from './glyph-field';

export { TARGET_ROWS } from './glyph-field';

// the full printable ASCII set (space through tilde). the default glyph atlas,
// so any phrase renders; the extras are what the flicker re-rolls to.
const DEFAULT_ATLAS =
	' .!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

// a brightness bitmap and the content it prints. the shape of a loadable asset:
// spread one into the renderer options to use it.
export interface BitmapSpec {
	/** the brightness values (0-255), row-major, top-left first */
	bitmap: number[];
	/** the bitmap width in cells */
	bitmapCols: number;
	/** the bitmap height in cells */
	bitmapRows: number;
	/** the glyph set the region prints with (must cover the phrase's characters) */
	atlas: string;
	/** the phrase that fills the field */
	phrase: string;
}

export interface AsciiRendererOptions {
	/** the phrase that tiles across the field (the content you are rendering) */
	phrase: string;
	/**
	 * the glyph atlas: the set of characters the field can print. It must include
	 * every character in the phrase; the extra characters are what the flicker
	 * re-rolls to. Defaults to the full printable ASCII set.
	 */
	atlas?: string;
	/**
	 * the brightness bitmap that lights up a region of the field (0-255 per cell).
	 * Omit it for a plain phrase field with no lit region (a backdrop); pass your
	 * own bitmap for a different shape.
	 */
	bitmap?: number[];
	/** the width of the bitmap in cells (required with a custom bitmap) */
	bitmapCols?: number;
	/** the height of the bitmap in cells (required with a custom bitmap) */
	bitmapRows?: number;
	/** fraction of the width the lit region occupies (0-1) */
	regionWidthFraction?: number;
	/** fraction of the height the lit region occupies (0-1) */
	regionHeightFraction?: number;
	/** fraction of the width where the lit region's left edge sits (0-1) */
	regionXFraction?: number;
	/** fraction of the height where the lit region's top edge sits (0-1) */
	regionYFraction?: number;
	/** white on a dark ground */
	dark?: boolean;
	/** the ink color the lit region's core is printed in (defaults to a mid grey in dark) */
	ink?: string;
	/** font family for the glyphs */
	font?: string;
	/** the background the text is printed on (the canvas is filled with it) */
	background?: string;
	/** the width/height ratio of a single glyph cell (monospace aspect) */
	cellAspect?: number;
	/**
	 * a fixed cell height in CSS pixels. When set, the field uses this cell size
	 * instead of deriving it from the canvas height, so the text stays the same
	 * size no matter how tall the canvas is. Omit it to derive the cell size
	 * from the canvas.
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

export interface AsciiRenderer {
	resize(width: number, height: number, dpr: number): void;
	/** set a fixed cell height in CSS px (omit it to revert to the canvas-derived size) */
	setCellHeight(height?: number): void;
	/**
	 * update the lit region's fractions after construction (e.g. when the host
	 * measures them off a canvas that changes size after boot). omitted values
	 * keep their current setting.
	 */
	setRegion(region: { width?: number; height?: number; x?: number; y?: number }): void;
	/**
	 * tell the field how tall the visible viewport is (CSS px). the click
	 * band's ring is sized against this instead of the canvas height, so a
	 * canvas taller than the viewport gets a screen-sized ring. 0 (default)
	 * = the canvas is the viewport.
	 */
	setViewportHeight(height: number): void;
	/** render a frame; pass the animation clock (ms) to drive the flicker */
	render(time?: number): void;
	/** swap the phrase that fills the field */
	setPhrase(phrase: string): void;
	/** flip light/dark */
	setDark(dark: boolean, ink?: string): void;
	/** move the hover void to (x, y) in canvas pixels */
	pointer(x: number, y: number): void;
	/** remove the pointer; the void fades out in place */
	pointerClear(): void;
	/** spawn a click wave: a ring of highlighted glyphs expanding from (x, y) in canvas pixels */
	click(x: number, y: number): void;
	destroy(): void;
}

// create a 2D ASCII glyph-field renderer. prints a phrase as a field of glyphs
// on a canvas, with an optional lit region, flicker, hover void, and click band.
export function createAsciiRenderer(
	canvas: HTMLCanvasElement,
	options: AsciiRendererOptions
): AsciiRenderer {
	const field = new GlyphField(canvas, {
		atlas: options.atlas ?? DEFAULT_ATLAS,
		phrase: options.phrase,
		dark: options.dark,
		ink: options.ink,
		font: options.font,
		background: options.background,
		bitmap: options.bitmap,
		bitmapCols: options.bitmapCols ?? 0,
		bitmapRows: options.bitmapRows ?? 0,
		regionWidthFraction: options.regionWidthFraction,
		regionHeightFraction: options.regionHeightFraction,
		regionXFraction: options.regionXFraction,
		regionYFraction: options.regionYFraction,
		cellAspect: options.cellAspect,
		cellHeight: options.cellHeight,
		scatter: options.scatter,
		flickerIntervalMs: options.flickerIntervalMs,
		flickerDurationMs: options.flickerDurationMs,
		flickerCount: options.flickerCount,
		voidRadiusFraction: options.voidRadiusFraction,
		voidJitter: options.voidJitter,
		clickDurationMs: options.clickDurationMs,
		clickBandWidthFraction: options.clickBandWidthFraction,
		clickJitter: options.clickJitter,
		clickStrength: options.clickStrength,
		clickDensity: options.clickDensity,
		clickColor: options.clickColor
	});

	return {
		resize(width, height, dpr) {
			field.resize(width, height, dpr);
		},
		setCellHeight(height) {
			field.setCellHeight(height);
		},
		setRegion(region) {
			field.setRegion(region);
		},
		setViewportHeight(height) {
			field.setViewportHeight(height);
		},
		render(time) {
			field.render(time);
		},
		setPhrase(phrase) {
			field.setPhrase(phrase);
		},
		setDark(dark, ink) {
			field.setDark(dark, ink);
		},
		pointer(x, y) {
			field.pointer(x, y);
		},
		pointerClear() {
			field.pointerClear();
		},
		click(x, y) {
			field.click(x, y);
		},
		destroy() {
			field.destroy();
		}
	};
}
