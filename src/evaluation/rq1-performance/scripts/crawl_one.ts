/**
 * Crawl ONE site and print {crawlMs, filePaths} as JSON on stdout.
 *
 * Runs as a child process because DEBUN's crawler can die in a way no caller can catch:
 * src/cmd/crawler.ts:80 handles a WriteStream error by calling unlinkSync, which itself
 * throws ENOTDIR when the path collides with an existing directory (seen on
 * cloudflare.com). That escapes the await chain as an uncaught exception, so isolating
 * each crawl keeps one bad site from ending a 100-site run.
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
