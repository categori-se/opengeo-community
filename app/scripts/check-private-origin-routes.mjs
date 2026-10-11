import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';

const work = '.local-archives/publisher-private-origin-20260915';
const seal = JSON.parse(await readFile(`${work}/receipt.json`));
const source = await readFile('services/api/src/opengeo_api/framework_publication_aws.py');
assert.equal(`sha256:${createHash('sha256').update(source).digest('hex')}`,
  seal.changedModules['framework_publication_aws.py'].sha256);
const redirect = execFileSync('services/api/.venv/bin/python', ['-c',
  'from opengeo_api.framework_publication_aws import S3PublicationStorage; import sys; sys.stdout.buffer.write(S3PublicationStorage(None,"private","public",private_origin=True)._redirect_body("/article/"))'],
  {env: {...process.env, PYTHONPATH: 'services/api/src'}});
const browser = await chromium.launch({headless: true,
  executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)});
const unexpected = [], results = [];
try {
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({javaScriptEnabled, serviceWorkers: 'block'});
    const assets = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://pages.example.test') {
        unexpected.push(url.href); await route.abort(); return;
      }
      if (url.pathname === '/article') {
        await route.fulfill({contentType: 'text/html', body: redirect});
      } else if (url.pathname === '/article/') {
        await route.fulfill({contentType: 'text/html', body:
          '<!doctype html><link rel="stylesheet" href="assets/style.css"><h1>Article</h1><a href="guide/">Guide</a>'});
      } else if (url.pathname === '/article/assets/style.css') {
        assets.push(url.pathname); await route.fulfill({contentType: 'text/css', body: 'h1{color:blue}'});
      } else if (url.pathname === '/article/guide/') {
        await route.fulfill({contentType: 'text/html', body: '<h1>Guide</h1>'});
      } else {unexpected.push(url.href); await route.abort();}
    });
    const page = await context.newPage();
    await page.goto('https://pages.example.test/article?view=map#legend');
    await page.waitForURL(javaScriptEnabled
      ? 'https://pages.example.test/article/?view=map#legend'
      : 'https://pages.example.test/article/', {timeout: 10000});
    await page.locator('h1').waitFor();
    assert.equal(await page.locator('h1').textContent(), 'Article');
    assert.ok(assets.includes('/article/assets/style.css'));
    await page.getByRole('link', {name: 'Guide'}).click();
    await page.waitForURL('https://pages.example.test/article/guide/');
    assert.equal(await page.locator('h1').textContent(), 'Guide');
    results.push({javaScriptEnabled, directoryNavigation: true, relativeAssets: true});
    await context.close();
  }
  assert.deepEqual(unexpected, []);
  const receipt = {candidate: seal.candidate, passed: true, results, externalRequests: 0,
    scope: 'Generated redirect HTML in Chromium; mocked REST object delivery, not live CloudFront'};
  await writeFile(`${work}/browser-routes.json`, JSON.stringify(receipt, null, 2), {flag: 'wx'});
  console.log(JSON.stringify(receipt));
} finally {await browser.close();}
