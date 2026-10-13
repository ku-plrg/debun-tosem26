/**
 * Crawl ONE site and print {crawlMs, filePaths} as JSON on stdout.
 *
 * Runs as a child process so that one site cannot end a 100-site run. That isolation was
 * added for a crawler crash — a WriteStream error was handled by an unlinkSync that threw
 * ENOTDIR inside the event handler and escaped the await chain, which is how cloudflare.com
 * and workers.dev recorded zero files. The crash is fixed in src/cmd/crawler.ts; the
 * uncaughtException handler below stays as the backstop for whatever the next one is.
 *
 * stdout is flushed before exit — calling process.exit() straight after write()
 * truncates a piped stdout, which silently cut the JSON for sites with many files.
 */
import { downloadScripts } from '../../../cmd/crawler';

const site = process.argv[2];
const t0 = Date.now();
let reported = false;

function report(obj: Record<string, unknown>) {
  if (reported) return;
  reported = true;
  process.stdout.write('\n__RESULT__' + JSON.stringify(obj) + '\n', () => process.exit(0));
}

process.on('uncaughtException', (e) => {
  report({ crawlMs: Date.now() - t0, filePaths: [], error: `uncaught: ${e.message}` });
});
process.on('unhandledRejection', (e) => {
  report({ crawlMs: Date.now() - t0, filePaths: [], error: `unhandled: ${String(e)}` });
});

downloadScripts(`https://${site}`)
  .then((filePaths) => report({ crawlMs: Date.now() - t0, filePaths }))
  .catch((e) => report({ crawlMs: Date.now() - t0, filePaths: [], error: String(e?.message ?? e) }));
