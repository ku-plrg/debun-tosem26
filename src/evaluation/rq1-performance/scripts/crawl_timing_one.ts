/**
 * Crawl ONE site into a throwaway root, purely to measure Setup time.
 *
 * The 14 sites carried over from the top-20 pilot are already present under
 * src/data/crawled/, but their per-site crawl times were lost with the scratchpad.
 * Re-crawling them in place would rewrite the corpus that stage1/stage2 measured, so
 * this writes elsewhere: downloadScripts' third argument is the root folder, resolved
 * relative to src/ (crawler.ts joins it onto __dirname/'../').
 *
 * Child-process isolation and the flush-before-exit are for the same reasons as
 * crawl_one.ts — see its header.
 */
import { downloadScripts } from '../../../cmd/crawler';

const site = process.argv[2];
const root = process.argv[3] ?? 'evaluation/rq1-performance/work/crawl-timing';
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

downloadScripts(`https://${site}`, true, root)
  .then((filePaths) => report({ crawlMs: Date.now() - t0, filePaths }))
  .catch((e) => report({ crawlMs: Date.now() - t0, filePaths: [], error: String(e?.message ?? e) }));
