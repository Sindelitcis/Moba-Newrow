/**
 * Frame sink for `public/harness.html`.
 *
 * The harness can render the game without a compositing browser tab (it swaps
 * `requestAnimationFrame` for a `setTimeout` shim: see that file), but a tab
 * that isn't compositing also can't be screenshotted from outside. What it
 * *can* do is read its own canvas back with `toDataURL()` and POST it
 * somewhere, which is what `__shot()` / `__crop()` do and what this receives.
 *
 * Run it alongside the page server, then from the harness console:
 *
 *   bun run capture             # this process, on :3011
 *   __shot('lane')              # writes captures/lane.png
 *   __crop('tower', 500, 200, 260, 200, 3)
 *
 * Without it the two helpers simply fail and the rest of the harness still
 * works: it is a convenience, not a dependency.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = Number(process.env.CAPTURE_PORT) || 3011;
const OUTPUT_DIR = join(import.meta.dir, '..', 'captures');
/** Only `image/png` data URLs; anything else is a mistake worth rejecting loudly. */
const DATA_URL_PREFIX = 'data:image/png;base64,';

await mkdir(OUTPUT_DIR, { recursive: true });

/** Strips anything that could escape `captures/`: the body is untrusted input. */
function safeName(raw: string | null): string {
    const cleaned = (raw ?? 'frame').replace(/[^a-zA-Z0-9._-]/g, '-');
    return cleaned.length > 0 ? cleaned : 'frame';
}

Bun.serve({
    port: PORT,
    async fetch(request) {
        // The harness is served from :3000 and posts here, so this is
        // cross-origin: without the preflight answer the POST never arrives.
        const cors = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };
        if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
        if (request.method !== 'POST') return new Response('POST a PNG data URL', { status: 405, headers: cors });

        const dataUrl = await request.text();
        if (!dataUrl.startsWith(DATA_URL_PREFIX)) {
            return new Response('expected a PNG data URL', { status: 400, headers: cors });
        }

        const name = safeName(new URL(request.url).searchParams.get('name'));
        const file = join(OUTPUT_DIR, `${name}.png`);
        await Bun.write(file, Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), 'base64'));

        console.log(`[capture] wrote ${file}`);
        return new Response(file, { headers: cors });
    },
});

console.log(`[capture] listening on http://localhost:${PORT}, writing to ${OUTPUT_DIR}`);
