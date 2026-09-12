// The brightness -> color math, pulled out so it's testable without a canvas.
//
// A brightness (0-255) maps to an ink color by interpolating between the faint
// field color and the core ink color, with a gentle 0.85 power so the mid tones
// fall off smoothly.

// parse "#rgb" or "#rrggbb" into [r, g, b]
export function hexToRgb(hex: string): [number, number, number] {
	let h = hex.replace('#', '');
	if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	const n = parseInt(h, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// the brightness curve: a gentle 0.85 power so the mid tones fall off smoothly
// toward the core. Anchored at 0 and 1.
export function curveFor(level: number): number {
	const t = Math.min(1, Math.max(0, level));
	return t ** 0.85;
}

// the ink color for a brightness (0-255): interpolate the faint field color
// toward the core ink color at curveFor(brightness/255). Returns an rgb tuple.
export function colorForRgb(
	brightness: number,
	field: [number, number, number],
	ink: [number, number, number]
): [number, number, number] {
	const t = curveFor(brightness / 255);
	return [
		Math.round(field[0] + (ink[0] - field[0]) * t),
		Math.round(field[1] + (ink[1] - field[1]) * t),
		Math.round(field[2] + (ink[2] - field[2]) * t)
	];
}

// same as colorForRgb, formatted as an "rgb(r,g,b)" string
export function colorFor(
	brightness: number,
	field: [number, number, number],
	ink: [number, number, number]
): string {
	const [r, g, b] = colorForRgb(brightness, field, ink);
	return `rgb(${r},${g},${b})`;
}

// a fast 1D integer hash in [0, 1). Cheaper than a full PRNG, used for the
// per-cell gap decision and the staggered flicker phase in the click band.
export function hash01(n: number): number {
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
	n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
	n = n ^ (n >>> 16);
	return (n >>> 0) / 4294967296;
}

// a deterministic 2D integer hash in [0, 1), for the value-noise lattice
function hash2(x: number, y: number): number {
	let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	h ^= h >>> 16;
	return (h >>> 0) / 4294967296;
}

// smooth value noise in [0, 1]. Deterministic and continuous: nearby points
// get nearby values. That is what lets the hover void's edge wander organically
// instead of reading as a clean circle.
export function noise2(x: number, y: number): number {
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const xf = x - xi;
	const yf = y - yi;
	const u = xf * xf * (3 - 2 * xf);
	const v = yf * yf * (3 - 2 * yf);
	const a = hash2(xi, yi);
	const b = hash2(xi + 1, yi);
	const c = hash2(xi, yi + 1);
	const d = hash2(xi + 1, yi + 1);
	return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// the click band: how much a cell `dist` px from the click point is
// highlighted when the band's center radius is `radius`. The band is a ring
// (annulus) centered on the radius, with a soft falloff of width `sigma`. As
// the radius grows the band moves outward, so each cell is highlighted only
// while the band passes over it (never the whole canvas at once). `noise`
// (0-1, from noise2) wanders the band's radius so the edge is not a clean
// circle, and `jitter` scales how far it wanders (0 = a clean circle). `peak`
// is the max highlight strength.
export function bandSpread(
	dist: number,
	radius: number,
	sigma: number,
	noise: number,
	jitter: number,
	peak: number
): number {
	if (sigma <= 0 || peak <= 0) return 0;
	const r = radius * (1 + (noise - 0.5) * 2 * jitter);
	const d = (dist - r) / sigma;
	if (d * d > 9) return 0; // beyond 3 sigma the band is negligible
	return peak * Math.exp(-0.5 * d * d);
}

// the hover void: how much a cell `dist` px from the pointer is erased.
// `noise` (0-1, from noise2) breaks up the circular edge and `jitter` scales
// how far the edge wanders (0 = a clean circle). The core is a solid erase
// (the text reads as vanishing, not fading) and only the outer `edge` fraction
// of the radius is a soft rim, so the hole has a thin shadow outline.
export function voidErase(
	dist: number,
	radius: number,
	noise: number,
	jitter: number,
	edge = 0.2
): number {
	const r = radius * (1 + (noise - 0.5) * 2 * jitter);
	if (r <= 0) return 0;
	const t = dist / r;
	if (t >= 1) return 0;
	const inner = 1 - edge;
	if (t <= inner) return 1; // solid core
	const s = (t - inner) / edge;
	return 1 - s * s * (3 - 2 * s); // thin soft rim
}
