// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
	bandSpread,
	colorFor,
	colorForRgb,
	curveFor,
	hash01,
	hexToRgb,
	noise2,
	voidErase
} from '../src/lookup.js';
import { hand } from '../assets/hand.js';

// the dark-mode colors: faint field just above the background, core a mid grey
const FIELD: [number, number, number] = [31, 31, 31]; // #1f1f1f
const INK: [number, number, number] = [158, 158, 158]; // #9e9e9e

describe('hexToRgb', () => {
	it('parses #rrggbb', () => {
		expect(hexToRgb('#181818')).toEqual([24, 24, 24]);
		expect(hexToRgb('#9e9e9e')).toEqual([158, 158, 158]);
	});

	it('parses #rgb shorthand', () => {
		expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
		expect(hexToRgb('#000')).toEqual([0, 0, 0]);
	});
});

describe('curveFor', () => {
	it('is anchored at 0 and 1', () => {
		expect(curveFor(0)).toBe(0);
		expect(curveFor(1)).toBe(1);
	});

	it('clamps out-of-range input', () => {
		expect(curveFor(-1)).toBe(0);
		expect(curveFor(2)).toBe(1);
	});

	it('is monotonic non-decreasing', () => {
		let prev = -1;
		for (let i = 0; i <= 100; i++) {
			const v = curveFor(i / 100);
			expect(v).toBeGreaterThanOrEqual(prev);
			prev = v;
		}
	});
});

describe('colorFor', () => {
	const sum = (s: string) => (s.match(/\d+/g) ?? []).reduce((a, b) => a + parseInt(b, 10), 0);

	it('maps brightness 0 to the faint field color', () => {
		expect(colorFor(0, FIELD, INK)).toBe('rgb(31,31,31)');
	});

	it('maps brightness 255 to the core ink', () => {
		expect(colorFor(255, FIELD, INK)).toBe('rgb(158,158,158)');
	});

	it('is monotonic: brighter input gives a brighter color', () => {
		expect(sum(colorFor(60, FIELD, INK))).toBeLessThan(sum(colorFor(120, FIELD, INK)));
		expect(sum(colorFor(120, FIELD, INK))).toBeLessThan(sum(colorFor(200, FIELD, INK)));
	});

	it('keeps the faint fingertips visible (above the field, below the core)', () => {
		const tip = sum(colorFor(12, FIELD, INK));
		const field = sum('rgb(31,31,31)');
		const core = sum('rgb(158,158,158)');
		expect(tip).toBeGreaterThan(field);
		expect(tip).toBeLessThan(core);
	});
});

describe('colorForRgb', () => {
	it('matches colorFor', () => {
		for (const b of [0, 12, 60, 120, 200, 255]) {
			const [r, g, bl] = colorForRgb(b, FIELD, INK);
			expect(`rgb(${r},${g},${bl})`).toBe(colorFor(b, FIELD, INK));
		}
	});
});

describe('noise2', () => {
	it('is deterministic', () => {
		expect(noise2(3.7, 1.2)).toBe(noise2(3.7, 1.2));
		expect(noise2(-4.1, 9.9)).toBe(noise2(-4.1, 9.9));
	});

	it('stays in [0, 1]', () => {
		for (let i = 0; i < 200; i++) {
			const v = noise2(i * 0.37, i * 0.71);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it('is smooth (nearby points get nearby values)', () => {
		const a = noise2(10, 10);
		const b = noise2(10.1, 10.05);
		expect(Math.abs(a - b)).toBeLessThan(0.2);
	});

	it('varies across the field', () => {
		let min = 1;
		let max = 0;
		for (let i = 0; i < 100; i++) {
			const v = noise2(i * 1.31, i * 0.77);
			min = Math.min(min, v);
			max = Math.max(max, v);
		}
		expect(max - min).toBeGreaterThan(0.5);
	});
});

describe('voidErase', () => {
	it('fully erases at the center', () => {
		expect(voidErase(0, 100, 0.5, 0.4)).toBe(1);
	});

	it('does not erase outside the (jittered) radius', () => {
		// the max jittered radius with noise 1 and jitter 0.4 is 1.4 * 100 = 140
		expect(voidErase(200, 100, 1, 0.4)).toBe(0);
	});

	it('has a solid core and a thin falling-off rim', () => {
		// inside the core (below 80% of the radius) it is a full erase
		expect(voidErase(20, 100, 0.5, 0.4)).toBe(1);
		expect(voidErase(70, 100, 0.5, 0.4)).toBe(1);
		// the rim falls off toward the edge
		const rim = voidErase(95, 100, 0.5, 0.4);
		expect(rim).toBeLessThan(1);
		expect(rim).toBeGreaterThan(0);
	});

	it('jitter wanders the edge: high noise pushes it out, low noise pulls it in', () => {
		// d = 90: inside the core of the pushed-out radius (140), in the rim of
		// the base radius (100), and outside the pulled-in radius (60)
		const d = 90;
		expect(voidErase(d, 100, 1, 0.4)).toBeGreaterThan(voidErase(d, 100, 0.5, 0.4));
		expect(voidErase(d, 100, 0.5, 0.4)).toBeGreaterThan(voidErase(d, 100, 0, 0.4));
	});

	it('is a clean circle when jitter is 0', () => {
		// with no jitter the erasure depends only on the distance
		expect(voidErase(50, 100, 0.1, 0)).toBe(voidErase(50, 100, 0.9, 0));
		expect(voidErase(100, 100, 0.5, 0)).toBe(0);
	});
});

describe('bandSpread', () => {
	it('peaks at the band center', () => {
		expect(bandSpread(100, 100, 20, 0.5, 0.25, 1)).toBe(1);
	});

	it('is zero beyond 3 sigma', () => {
		expect(bandSpread(100 + 61, 100, 20, 0.5, 0.25, 1)).toBe(0);
	});

	it('fades away from the band center', () => {
		const at = (d: number) => bandSpread(100 + d, 100, 20, 0.5, 0.25, 1);
		expect(at(0)).toBe(1);
		expect(at(10)).toBeGreaterThan(at(20));
		expect(at(20)).toBeGreaterThan(at(40));
		expect(at(40)).toBeGreaterThan(0);
	});

	it('jitter wanders the band: high noise pushes it out, low noise pulls it in', () => {
		// d = 130: near the pushed-out band (noise 1, r = 125), mid for the base
		// radius (100), and far from the pulled-in band (noise 0, r = 75)
		const d = 130;
		expect(bandSpread(d, 100, 20, 1, 0.25, 1)).toBeGreaterThan(
			bandSpread(d, 100, 20, 0.5, 0.25, 1)
		);
		expect(bandSpread(d, 100, 20, 0.5, 0.25, 1)).toBeGreaterThan(
			bandSpread(d, 100, 20, 0, 0.25, 1)
		);
	});

	it('is a clean circle when jitter is 0', () => {
		// with no jitter the highlight depends only on the distance
		expect(bandSpread(110, 100, 20, 0.1, 0, 1)).toBe(bandSpread(110, 100, 20, 0.9, 0, 1));
	});

	it('scales with the peak', () => {
		expect(bandSpread(100, 100, 20, 0.5, 0.25, 0.5)).toBe(0.5);
		expect(bandSpread(120, 100, 20, 0.5, 0.25, 0.5)).toBe(
			bandSpread(120, 100, 20, 0.5, 0.25, 1) / 2
		);
	});

	it('is disabled when sigma or peak is 0', () => {
		expect(bandSpread(100, 100, 0, 0.5, 0.25, 1)).toBe(0);
		expect(bandSpread(100, 100, 20, 0.5, 0.25, 0)).toBe(0);
	});
});

describe('hash01', () => {
	it('is deterministic', () => {
		expect(hash01(12345)).toBe(hash01(12345));
		expect(hash01(98765)).toBe(hash01(98765));
	});

	it('stays in [0, 1)', () => {
		for (let i = 0; i < 1000; i++) {
			const v = hash01(i * 2654435761);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThan(1);
		}
	});

	it('varies across inputs', () => {
		let min = 1;
		let max = 0;
		for (let i = 0; i < 100; i++) {
			const v = hash01(i * 374761393);
			min = Math.min(min, v);
			max = Math.max(max, v);
		}
		expect(max - min).toBeGreaterThan(0.5);
	});
});

describe('hand spec', () => {
	it('has the expected grid', () => {
		expect(hand.bitmapCols).toBe(160);
		expect(hand.bitmapRows).toBe(88);
		expect(hand.bitmap).toHaveLength(160 * 88);
	});

	it('has a phrase whose characters are all in the atlas', () => {
		expect(hand.phrase).toBe(
			'WEB \u00b7 SYSTEMS \u00b7 DESIGN \u00b7 ENGINEERING \u00b7 PERFORMANCE \u00b7 '
		);
		// every phrase char must be in the atlas
		for (const ch of hand.phrase) {
			expect(hand.atlas.indexOf(ch)).toBeGreaterThanOrEqual(0);
		}
	});

	it('has a hand shape (a good number of lit cells)', () => {
		const lit = hand.bitmap.filter((v) => v > 0).length;
		expect(lit).toBeGreaterThan(1000);
	});

	it('has faint cells (the fingertips) and a bright core', () => {
		const b = hand.bitmap;
		// faint cells (1-15) form the fingertips/edges
		expect(b.filter((v) => v > 0 && v < 16).length).toBeGreaterThan(500);
		// and a bright core near white
		expect(b.some((v) => v > 240)).toBe(true);
	});
});
