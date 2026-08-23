import type { Plugin } from 'vite';

/**
 * Works around a bug in Murow's own
 * `packages/webgpu/src/shaders/runtime-transpile.ts` (the runtime fallback
 * that gives WebGPU3DRenderer's built-in mesh shaders TypeGPU metadata
 * without a build-time plugin): patched here, in our own build config,
 * rather than in the murow repo itself, so the fix stays scoped to this
 * project.
 *
 * The bug: when a bundler renames a colliding top-level identifier
 * (e.g. `vec3f` → `vec3f$1`), Murow's recovery heuristic only knows how to
 * strip an esbuild-style trailing-digit suffix (`mul` → `mul2`), not
 * Rollup/Vite's `$`-prefixed one. Worse, when Murow calls
 * `attachShaderMetadata(..., knownExternalNames)` with a hardcoded list of
 * clean names (which it does for all of its own built-in shaders), the
 * renamed identifier never even gets a resolution attempt: the whole
 * lookup loop only iterates the clean `knownExternalNames`, never the raw
 * (possibly renamed) names tinyest actually extracted from the bundled
 * source. Result: `Identifier vec3f$1 not found` at shader-resolution time,
 * reproducible with any bundler that needs to disambiguate a colliding
 * name (Rollup/Vite; esbuild hits an analogous case with plain minification,
 * which this patch can't help with: see vite.config.ts's `minify: false`).
 *
 * This transform patches the loaded source in memory at build time:
 * 1. Strips a `$<digits>` suffix OR a plain trailing-digit suffix (never
 *    both: stripping both turns `u32$1` into `u`, not `u32`, which is its
 *    own bug distinct from the one this patch is fixing).
 * 2. Adds a second resolution pass over the raw extracted names (not just
 *    the clean `effectiveExternalNames`), covering the `knownExternalNames`
 *    case above.
 *
 * Guarded by matching known original snippets: if Murow's source changes
 * upstream and the snippets no longer match, this throws at build time
 * instead of silently no-op'ing, so a stale patch doesn't go unnoticed.
 */
export function patchMurowTypegpuMetadata(): Plugin {
    return {
        name: 'patch-murow-typegpu-metadata',
        enforce: 'pre',
        transform(code, id) {
            if (!id.replace(/\\/g, '/').endsWith('shaders/runtime-transpile.ts')) return null;

            const stripSnippet = "const stripped = name.replace(/\\d+$/, '');";
            const stripOccurrences = code.split(stripSnippet).length - 1;
            if (stripOccurrences !== 2) {
                throw new Error(
                    `[patch-murow-typegpu-metadata] expected 2 occurrences of the trailing-digit strip in ${id}, found ${stripOccurrences}. ` +
                    `Murow's runtime-transpile.ts may have changed: update this patch (moba-3x3/vite-plugins/patch-murow-typegpu-metadata.ts).`,
                );
            }

            const helperName = '__mobaStripBundlerSuffix';
            const formatVersionMarker = 'const FORMAT_VERSION = 1;';
            if (!code.includes(formatVersionMarker)) {
                throw new Error(
                    `[patch-murow-typegpu-metadata] FORMAT_VERSION anchor not found in ${id}. ` +
                    `Murow's runtime-transpile.ts may have changed: update this patch.`,
                );
            }
            const helperDef = `${formatVersionMarker}

// (moba-3x3 patch) Strips a bundler disambiguation suffix so a renamed
// identifier can be looked up under its original name. Different bundlers
// use different conventions: esbuild appends plain trailing digits
// ("mul" -> "mul2"), Rollup/Vite append a "$"-prefixed counter
// ("vec3f" -> "vec3f$1"). Only one ever applies: trying both in sequence
// would turn "u32$1" into "u" instead of "u32".
function ${helperName}(name) {
    const dollarStripped = name.replace(/\\$\\d+$/, '');
    if (dollarStripped !== name) return dollarStripped;
    return name.replace(/\\d+$/, '');
}`;

            // Both original occurrences: swap the plain-digit-only strip for our helper.
            let patched = code
                .replace(formatVersionMarker, helperDef)
                .replaceAll(stripSnippet, `const stripped = ${helperName}(name);`);

            const insertAfter = '    // Call the externals getter eagerly to detect bundler-renamed names.';
            if (!patched.includes(insertAfter)) {
                throw new Error(
                    `[patch-murow-typegpu-metadata] anchor comment not found in ${id}. ` +
                    `Murow's runtime-transpile.ts may have changed: update this patch.`,
                );
            }
            const rawNamesPass = `
    // (moba-3x3 patch) When \`knownExternalNames\` is supplied,
    // \`effectiveExternalNames\` holds the original clean names (e.g.
    // "vec3f"), but the parsed \`body\` AST still reflects whatever the
    // *actual* bundled source says, which may be a renamed identifier
    // (e.g. "vec3f$1") if the bundler needed to disambiguate it from a
    // same-named binding elsewhere in the file. Resolution walks \`body\`,
    // not \`effectiveExternalNames\`, so it looks up the renamed
    // identifier, which the loop above never populates in that case,
    // since it never iterates the raw (renamed) names. Re-resolve every
    // raw extracted name here too, so both spellings are available.
    for (const name of externalNames) {
        if (name in resolvedMembers || resolvedAliases[name]) continue;
        const strippedRaw = ${helperName}(name);
        if (strippedRaw === name) continue;
        for (const [, ns] of candidateEntries) {
            const nsRecord = ns as Record<string, unknown>;
            if (strippedRaw in nsRecord) {
                resolvedMembers[name] = nsRecord[strippedRaw];
                break;
            }
        }
    }

${insertAfter}`;
            patched = patched.replace(insertAfter, rawNamesPass);

            // --- Fix 2: the eager `getExternals()` call must not be fatal.
            const eagerCall = 'const baseExternals = getExternals();';
            if (!patched.includes(eagerCall)) {
                throw new Error(
                    `[patch-murow-typegpu-metadata] eager getExternals() call not found in ${id}. ` +
                    `Murow's runtime-transpile.ts may have changed: update this patch.`,
                );
            }
            const guardedEagerCall = `// (moba-3x3 patch) This eager call exists only to feed the
    // minified-name recovery heuristics below, but it is NOT safe for
    // every caller. \`ComputeBuilder\`'s externals getter (see
    // ../../compute/compute-builder.ts) dereferences \`layout.$[name]\` for
    // each of its buffers, and in typegpu 0.10.2 touching \`layout.$\`
    // outside of an actual shader/pipeline resolution throws "Direct access
    // to buffer values is possible only as part of a compute dispatch or
    // draw call". That made EVERY \`ComputeBuilder.build()\` throw, which
    // in practice meant the skeletal-animation kernel could never be built,
    // so any skinned GLTF instance blew up \`render()\` before it issued a
    // single draw call and blanked the whole canvas.
    //
    // The heuristics that consume \`baseExternals\` only matter for minified
    // bundles (we build with \`minify: false\`, see vite.config.ts), so
    // degrading to an empty record is strictly better than throwing. The
    // lazy \`wrappedExternals\` getter below is unaffected: it runs during
    // pipeline resolution, where dereferencing \`layout.$\` is legal.
    let baseExternals = {};
    try {
        baseExternals = getExternals();
    } catch {
        // Externals not resolvable outside a shader context: skip the
        // minified-name recovery passes rather than failing the build.
    }`;
            // Replacer *function*, not a string: the replacement below contains
            // "layout.$`", and in a replacement string "$`" is the special
            // "everything before the match" pattern, which silently splices the
            // whole preceding file into the output. A function replacer disables
            // all `$` pattern interpretation.
            patched = patched.replace(eagerCall, () => guardedEagerCall);

            // --- Fix 3: don't force every declaration to `const`.
            //
            // `splitDecls` rewrites the `kind` of every VariableDeclaration it
            // walks to 'const', unconditionally. In TGSL a `const` declaration
            // lowers to an *immutable* WGSL binding, so any source that
            // declares `let x = ...` and later reassigns `x` fails resolution
            // with "'x = ...' is invalid, because x is a constant".
            //
            // Murow's own mesh shaders happen to never reassign a local, which
            // is why this went unnoticed, but the skeletal-animation kernel
            // (3d/skeletal-animation-compute/kernel.ts) leans on mutable locals
            // throughout (`lo`/`hi` for the keyframe binary search, `tx`/`qx`/
            // `sx`… for the TRS accumulators). Preserving the author's own
            // `let`/`const` is strictly more faithful: const-ifying a local
            // that is never reassigned was a no-op anyway, and keeping `let`
            // mutable is always sound. `var` has no TGSL equivalent, so it
            // normalizes to `let`.
            const forceConstDecl = "s.kind = 'const';";
            const forceConstSplit = "kind: 'const',";
            if (!patched.includes(forceConstDecl) || !patched.includes(forceConstSplit)) {
                throw new Error(
                    `[patch-murow-typegpu-metadata] the const-forcing lines in splitDecls were not found in ${id}. ` +
                    `Murow's runtime-transpile.ts may have changed: update this patch.`,
                );
            }
            patched = patched
                .replace(forceConstDecl, () => "s.kind = s.kind === 'var' ? 'let' : s.kind;")
                // The split-out statements inherit the (already normalized)
                // kind of the declaration they came from, rather than the
                // hardcoded 'const'.
                .replace(forceConstSplit, () => 'kind: s.kind,');

            return { code: patched, map: null };
        },
    };
}
