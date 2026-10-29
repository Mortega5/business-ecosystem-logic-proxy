import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['src/**/*.spec.ts'],
        setupFiles: ['reflect-metadata']
    },
    plugins: [swc.vite({ module: { type: 'es6' } })]
});
