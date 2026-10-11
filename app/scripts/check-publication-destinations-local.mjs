import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile, readdir, mkdtemp} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// Built Studio modules, fixture-only API. No real address is reserved or published.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const output = await mkdtemp('/tmp/opengeo-publication-destinations-');
const module = (await readdir(resolve(dist, '_import/components'))).find(name => /^FrameworkPublications\./.test(name));
const theme = (await readdir(resolve(dist, '_observablehq'))).find(name => name.endsWith('.css'));
const css = (await readdir(resolve(dist, '_file'))).find(name => /^style\..*\.css$/.test(name));
assert.ok(module && theme && css, 'Build Studio before this check');
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/check') {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/_observablehq/${theme}"><link rel="stylesheet" href="/_file/${css}"><main class="platform-surface" id="workspace"></main>`);
    return;
  }
  const file = resolve(dist, `.${decodeURIComponent(path)}`);
  if (!file.startsWith(dist)) {response.writeHead(403).end(); return;}
  try {
    response.setHeader('Content-Type', extname(file) === '.js' ? 'text/javascript' : extname(file) === '.css' ? 'text/css' : 'application/octet-stream');
    response.end(await readFile(file));
  } catch {response.writeHead(404).end();}
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({headless: true, executablePath: ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)});
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(origin + '/')) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.goto(origin + '/check');
  await page.evaluate(async module => {
    const {FrameworkPublications} = await import(`/_import/components/${module}`);
    const id = '10000000-0000-4000-8000-000000000001';
    const origins = ['pages.studio.opengeo.tools', 'opengeo.tools', 'atlas.example.test'].map((hostname, index) => ({
      id: `${index + 2}0000000-0000-4000-8000-000000000001`, hostname, pathPrefix: '/publications/', urlPrefix: `https://${hostname}/publications/`
    }));
    const status = {sourceProjectId: id, canPublish: true, dispatchConfigured: true,
      canConfigureDestinations: true, origins, mounts: [], reviews: []};
    window.reservations = []; window.publications = 0;
    const adapter = {
      getFrameworkPublications: async () => status,
      listObservableBuildJobs: async () => [],
      reserveFrameworkPublicationDestination: async (project, source, request) => {
        if (project !== id || source !== id) throw Error('scope mismatch');
        window.reservations.push(request);
        const host = origins.find(origin => origin.id === request.originId);
        status.mounts.push({id: request.reservationId, hostname: host.hostname,
          mountPath: host.pathPrefix + request.slug + '/', url: host.urlPrefix + request.slug + '/', enabled: true});
        return structuredClone(status);
      },
      approveFrameworkPublication: async () => {window.publications++; throw Error('Unexpected publication');}
    };
    document.querySelector('#workspace').append(FrameworkPublications({adapter, projectId: id, sourceProjectId: id}));
  }, module);
  const name = page.getByRole('textbox', {name: 'Address name', exact: true});
  const reserve = page.getByRole('button', {name: 'Reserve address', exact: true});
  await name.waitFor();
  assert.equal(await page.evaluate(() => window.reservations.length), 0);
  await name.fill('../atlas'); assert.equal(await reserve.isDisabled(), true);
  await page.getByRole('combobox', {name: 'Public hosting'}).selectOption({label: 'https://opengeo.tools/publications/'});
  // The maximum supported path/name must fit a phone as well as a desktop.
  await name.fill('a'.repeat(80));
  for (const width of [1280, 390]) {
    await page.setViewportSize({width, height: 900});
    await page.screenshot({path: `${output}/address-${width}.png`, fullPage: true});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `No overflow at ${width}px; screenshot: ${output}/address-${width}.png`);
  }
  await name.fill('watershed-atlas');
  assert.equal(await page.getByLabel('Proposed public address').textContent(), 'https://opengeo.tools/publications/watershed-atlas/');
  await reserve.click();
  await page.getByRole('link', {name: 'https://opengeo.tools/publications/watershed-atlas/', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.reservations.length), 1);
  await page.getByRole('button', {name: 'Reload publication reviews'}).click();
  await page.getByRole('link', {name: 'https://opengeo.tools/publications/watershed-atlas/', exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.reservations.length), 1);
  assert.equal(await page.evaluate(() => window.publications), 0);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({passed: true, fixtureOnly: true, output, widths: [1280, 390], reservations: 1, publications: 0, externalRequests: 0}));
} finally {
  await browser?.close(); await new Promise(done => server.close(done));
}
