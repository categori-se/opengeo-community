import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const transition = process.argv.includes('--transition-release');
const work = new URL(transition ? '../../.local-archives/publisher-compiler-transition-20260915/execution/' : '../../.local-archives/publisher-navigation-repair-20260915/', import.meta.url);
const before = JSON.parse(await readFile(new URL(transition ? 'preflight.json' : 'release-execution.json', work)));
const protectedHashes = transition ? before.publicHashes : before.beforePublicHashes;
const receipt = {startedAt: new Date().toISOString(), publicChecks: {}, protectedHtmlUnchanged: false};
const formats = process.argv.find(arg => arg.startsWith('--formats='))?.slice(10).split(',') ?? ['html', 'map', 'notebook', 'jupyter'];
assert.ok(formats.length > 0 && formats.every(format => ['html', 'map', 'notebook', 'jupyter', 'framework'].includes(format)));
const browser = await chromium.launch({executablePath: '/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox']});
try {
  const context = await browser.newContext({serviceWorkers: 'block'});
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === 'https://opengeo.tools' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  for (const [format, name] of [['html', 'HTML'], ['map', 'map'], ['notebook', 'Notebook'], ['jupyter', 'Jupyter'], ['framework', 'Framework']]) {
    if (!formats.includes(format)) continue;
    await page.goto(`https://opengeo.tools/publisher-check/${format}/`);
    await page.getByRole('heading', {name: 'Publisher acceptance ' + name, exact: true}).waitFor();
    await page.reload();
    if (format === 'html') {
      await page.getByRole('button', {name: 'Count: 0', exact: true}).click();
      await page.getByRole('button', {name: 'Count: 1', exact: true}).waitFor();
    } else if (format === 'notebook' || format === 'framework') {
      const total = format === 'framework' ? 44 : 42;
      await page.getByText('Computed total: ' + total, {exact: true}).waitFor();
      const input = page.locator('input[type=range]').first();
      await input.fill('3'); await input.dispatchEvent('input');
      await page.getByText('Computed total: ' + total * 1.5, {exact: true}).waitFor();
      if (format === 'framework') {
        await page.getByRole('link', {name: 'Methods', exact: true}).last().click();
        await page.getByRole('heading', {name: 'Methods', exact: true}).waitFor();
        await page.reload();
        await page.getByRole('heading', {name: 'Methods', exact: true}).waitFor();
        await page.getByRole('link', {name: 'Home', exact: true}).last().click();
        await page.getByRole('heading', {name: 'Publisher acceptance Framework', exact: true}).waitFor();
      }
    } else if (format === 'jupyter') {
      await page.getByText('Saved observations', {exact: true}).waitFor();
    } else {
      const canvas = page.locator('.maplibregl-canvas');
      await canvas.waitFor(); await page.waitForTimeout(1000);
      const first = await canvas.screenshot();
      await context.setOffline(true);
      await page.locator('.maplibregl-ctrl-zoom-in').click();
      await page.waitForTimeout(1000);
      assert.notDeepEqual(await canvas.screenshot(), first, 'Offline map zoom did not change rendering');
      await context.setOffline(false);
      receipt.offlineMapZoomPassed = true;
    }
    receipt.publicChecks[format] = {anonymous: true, reload: true, content: true};
    await page.screenshot({path: new URL(`public-final-${format}.png`, work).pathname});
  }
  const hashes = {};
  for (const path of Object.keys(protectedHashes)) {
    const response = await context.request.get('https://opengeo.tools' + path);
    hashes[path] = response.status() === 404 ? {status: 404} : {
      status: response.status(), sha256: createHash('sha256').update(await response.body()).digest('hex')
    };
  }
  assert.deepEqual(hashes, protectedHashes);
  receipt.publicHashes = hashes; receipt.protectedHtmlUnchanged = true;
} finally {
  await browser.close();
  receipt.finishedAt = new Date().toISOString();
  await writeFile(new URL('public-postflight.json', work), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
}
