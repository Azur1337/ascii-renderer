import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Lib build for @azur/ascii-renderer. The core renderer is the main entry
// (`.`); the hand is a separate asset entry (`./hand`). The dts plugin emits
// the matching .d.ts files so the package ships with types.
export default defineConfig({
	plugins: [
		dts({
			rollupTypes: true
		})
	],
	build: {
		lib: {
			entry: {
				index: 'src/index.ts',
				hand: 'assets/hand.ts'
			},
			name: 'AsciiRenderer',
			fileName: (_format, entryName) => `${entryName}.js`,
			formats: ['es']
		},
		outDir: 'dist',
		sourcemap: true
	}
});
