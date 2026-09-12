import { createAsciiRenderer } from '../src/index.js';

// the backdrop: just a field of faint text on a dark ground. No lit region
// (no bitmap), no hover void, no click band. The flicker is left on for a
// subtle sense of life; set flickerCount: 0 for a fully static field.
const canvas = document.querySelector<HTMLCanvasElement>('#field')!;
const renderer = createAsciiRenderer(canvas, {
	dark: true,
	phrase: 'WEB \u00b7 SYSTEMS \u00b7 DESIGN \u00b7 ENGINEERING \u00b7 PERFORMANCE \u00b7 ',
	voidRadiusFraction: 0,
	clickBandWidthFraction: 0
});

function resize() {
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	renderer.resize(w, h, window.devicePixelRatio);
}

window.addEventListener('resize', resize);

function start() {
	resize();
	const start = performance.now();
	function frame(now: number) {
		renderer.render(now - start);
		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);
}

if (document.fonts) {
	document.fonts.load('16px GeistMono').then(start).catch(start);
} else {
	start();
}
