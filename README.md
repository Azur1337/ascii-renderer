# ascii-renderer

[![npm version](https://img.shields.io/npm/v/azur-ascii-renderer)](https://www.npmjs.com/package/azur-ascii-renderer)

A 2D ASCII glyph-field renderer. It prints a phrase as a field of glyphs on a
canvas, and layers on a few effects: an optional lit region, a flicker, a hover
void, and a click band. Every effect is a toggle, so the same renderer is a full
interactive field or a plain static backdrop.

![the field](./docs/field.png)

## Install

```
npm install azur-ascii-renderer
```

## Quick start

```ts
import { createAsciiRenderer } from 'azur-ascii-renderer';

const canvas = document.querySelector('#field');
const renderer = createAsciiRenderer(canvas, {
	dark: true,
	phrase: 'AZUR \u00b7 '
});

function resize() {
	renderer.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio);
}
window.addEventListener('resize', resize);
resize();

const start = performance.now();
(function frame(now) {
	renderer.render(now - start);
	requestAnimationFrame(frame);
})(start);
```

That's a plain field of faint text on a dark ground. No lit region, no effects.

![the backdrop](./docs/backdrop.png)

## The hand asset

The package ships with a sample brightness bitmap (a hand) that lights up a
region of the field. It's a separate entry, so the core stays general:

```ts
import { createAsciiRenderer } from 'azur-ascii-renderer';
import { hand } from 'azur-ascii-renderer/hand';

const renderer = createAsciiRenderer(canvas, { dark: true, ...hand });
```

Spreading `hand` sets the bitmap, its dimensions, the glyph atlas, and the
phrase. The hand lights up the right half of the field; the rest stays faint.

Move the pointer over the field and a void erases the glyphs around the cursor.
Click and a band of highlighted glyphs expands out and off the screen.

![the hover void](./docs/void.png)

![the click band](./docs/click.png)

## Options

| option                   | default     | what it does                                       |
| ------------------------ | ----------- | -------------------------------------------------- |
| `phrase`                 | (required)  | the text that tiles across the field               |
| `atlas`                  | full ASCII  | the glyph set; must cover every char in the phrase |
| `bitmap`                 | `null`      | a brightness bitmap (0-255) for a lit region       |
| `bitmapCols`             | `0`         | the bitmap width in cells                          |
| `bitmapRows`             | `0`         | the bitmap height in cells                         |
| `regionWidthFraction`    | `0.5`       | how wide the lit region is                         |
| `regionHeightFraction`   | `0.9`       | how tall the lit region is                         |
| `regionXFraction`        | `null`      | where the region's left edge sits (null = right)   |
| `regionYFraction`        | `null`      | where the region's top edge sits (null = bottom)   |
| `dark`                   | `false`     | white on a dark ground                             |
| `ink`                    | mid grey    | the color the lit region's core is printed in      |
| `font`                   | mono stack  | the font family                                    |
| `background`             | `#181818`   | the canvas background                              |
| `cellAspect`             | `0.55`      | the width/height ratio of a glyph cell             |
| `flickerCount`           | `800`       | how many cells flicker at once (0 disables)        |
| `flickerIntervalMs`      | `400`       | how often a flickering cell re-rolls               |
| `flickerDurationMs`      | `3000`      | how long a flicker lasts                           |
| `voidRadiusFraction`     | `0.24`      | the hover void radius (0 disables)                 |
| `voidJitter`             | `0.25`      | how far the void's edge wanders                    |
| `clickDurationMs`        | `1500`      | how long the click band takes to cross the screen  |
| `clickBandWidthFraction` | `0.25`      | the click band width (0 disables)                  |
| `clickJitter`            | `0.25`      | how far the band's edge wanders                    |
| `clickStrength`          | `0.8`       | the peak highlight strength                        |
| `clickDensity`           | `0.5`       | the fraction of letters that light up              |
| `clickColor`             | white / ink | the highlight color                                |

## Demo

The `demo/` folder has a Vite demo with the interactive field (`/`) and the
plain backdrop (`/backdrop.html`).

```
bunx vite demo/
```

## License

MIT
