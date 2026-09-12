import { createAsciiRenderer } from '../src/index.js';
import { hand } from '../assets/hand.js';

// the interactive field: the hand bitmap lights up a region, with the hover
// void and click band on top. The hand is a loadable asset, spread in here.
const canvas = document.querySelector<HTMLCanvasElement>('#hand')!;
const renderer = createAsciiRenderer(canvas, { dark: true, ...hand });

function resize() {
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	renderer.resize(w, h, window.devicePixelRatio);
}

window.addEventListener('resize', resize);

// the hover void: the field erases the glyphs around the pointer
canvas.addEventListener('pointermove', (e) => {
	const rect = canvas.getBoundingClientRect();
	renderer.pointer(e.clientX - rect.left, e.clientY - rect.top);
});
canvas.addEventListener('pointerleave', () => renderer.pointerClear());

// the click wave: a ring of highlighted glyphs expanding from the click
canvas.addEventListener('pointerdown', (e) => {
	const rect = canvas.getBoundingClientRect();
	renderer.click(e.clientX - rect.left, e.clientY - rect.top);
});

// the font size is measured off "M" at resize time, so wait for Geist Mono to
// load first; otherwise the fallback font's metrics get baked in
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
