import { defineConfig } from 'vite';
import path from 'path';
import typegpu from 'unplugin-typegpu/vite';
import { patchMurowTypegpuMetadata } from './vite-plugins/patch-murow-typegpu-metadata';

/**
 * Builds src/game-client.ts (the only file that touches `murow/webgpu`)
 * into a standalone bundle at public/game-client.js, loaded via a plain
 * <script> tag from Game.tsx's hydrate(): see that file's comment.
 *
 * Vite (not Newstack's own esbuild pipeline) because WebGPU3DRenderer's
 * built-in shaders are authored with `tgpu.fn`, which needs `unplugin-typegpu`
 * to embed shader metadata at build time: matching the toolchain versions
 * pinned in package.json (`overrides` + exact `unplugin-typegpu`), which are
 * the exact combination the murow repo's own multiplayer-cube-arena example
 * uses.
 *
 * Getting this working end to end took three separate fixes, in case any of
 * this needs revisiting:
 *  1. Alias straight to Murow's TypeScript source (like multiplayer-cube-arena
 *     does), and force-dedupe `typegpu` onto this project's copy: Murow's
 *     own repo has its own separately-installed `typegpu`, and two physical
 *     module instances means two `tgpu` singletons, which breaks TypeGPU's
 *     metadata WeakMap ("Found duplicate TypeGPU version" in the console).
 *  2. `packages/webgpu/src/shaders/runtime-transpile.ts` (Murow's runtime
 *     shader-metadata fallback, used for its own built-in mesh shaders
 *     regardless of bundler) only knew how to recover esbuild-style renamed
 *     identifiers (`mul` -> `mul2`). Rollup/Vite renames collisions as
 *     `mul` -> `mul$1` instead, and: when Murow passes a hardcoded
 *     `knownExternalNames` list: the AST body can reference a renamed
 *     identifier that never gets resolved at all, since resolution only
 *     walked that clean-names list. This is a real bug in Murow itself, but
 *     we don't touch the murow repo from this project: `patchMurowTypegpuMetadata`
 *     (see vite-plugins/) rewrites that one file's source in memory at
 *     build time instead, scoping the fix entirely to this project.
 *  3. Minification renames externals to arbitrary short names (`mul` -> `K`)
 *     with no textual relation to the original: unrecoverable without a
 *     source map. `minify: false` below sidesteps it; this is a local/
 *     prototype bundle, not a production deploy, so the size cost doesn't
 *     matter.
 */
export default defineConfig({
    plugins: [patchMurowTypegpuMetadata(), typegpu({})],
    // We reuse the `public/` folder as the build output: tell Vite it's
    // not also a static-assets source to copy from, silencing its warning.
    publicDir: false,
    // Some bundled deps do Node-style `process.env.NODE_ENV` dev/prod
    // checks; the browser has no `process` global, so replace it at build
    // time instead of shipping a full Node polyfill for one string check.
    define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
    },
    resolve: {
        alias: {
            'murow/webgpu': path.resolve(__dirname, '../murow/packages/webgpu/src/index.ts'),
            'murow/netcode': path.resolve(__dirname, '../murow/packages/netcode/src/index.ts'),
            'murow/*': path.resolve(__dirname, '../murow/packages/murow/src/*'),
            murow: path.resolve(__dirname, '../murow/packages/murow/src'),
            // Murow's own repo has its own separately-installed `typegpu` copy
            // (murow/node_modules/typegpu): Node resolution from the
            // source-aliased packages/webgpu/src files finds that one, while
            // our own imports resolve to this project's copy. Two physical
            // module instances means two `tgpu` singletons, which breaks
            // TypeGPU's metadata WeakMap and produces "Identifier ... not
            // found" at shader-resolution time. Force everyone onto our copy.
            typegpu: path.resolve(__dirname, 'node_modules/typegpu'),
            'typegpu/data': path.resolve(__dirname, 'node_modules/typegpu/data'),
            'typegpu/std': path.resolve(__dirname, 'node_modules/typegpu/std'),
        },
        dedupe: ['typegpu'],
    },
    build: {
        outDir: path.resolve(__dirname, 'public'),
        emptyOutDir: false,
        // Murow's runtime shader-metadata fallback (packages/webgpu/src/shaders/runtime-transpile.ts)
        // can only recover bundler-disambiguated names (`vec3f` -> `vec3f$1`),
        // not arbitrary minifier-shortened ones (`mul` -> `K`): there's no
        // way to reverse those without a source map. Not worth minifying a
        // local-dev/prototype bundle to work around that.
        minify: false,
        target: ['chrome95', 'firefox92', 'safari15', 'edge95', 'es2022'],
        rollupOptions: {
            input: path.resolve(__dirname, 'src/game-client.ts'),
            output: {
                format: 'iife',
                name: 'MobaGameClient',
                entryFileNames: 'game-client.js',
            },
        },
    },
});
