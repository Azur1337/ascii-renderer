import spec from './hand.json';
import type { BitmapSpec } from '../src/index.js';

// A sample brightness bitmap (160x88) with its glyph atlas and phrase. Not part
// of the core renderer. Spread it into the options to use it:
//
//   import { hand } from 'azur-ascii-renderer/hand';
//   createAsciiRenderer(canvas, { dark: true, ...hand });
export const hand: BitmapSpec = {
	bitmap: spec.cellBrightness,
	bitmapCols: spec.modelCols,
	bitmapRows: spec.modelRows,
	atlas: spec.atlas,
	phrase: spec.phrase
};
