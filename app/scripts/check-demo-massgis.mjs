import assert from "node:assert/strict";
import {createServer} from "node:http";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {extname, normalize, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";

import {chromium} from "playwright";

import {
  MASSGIS_FEATURE_LAYER_URL,
  massgisArchiveUrl,
  massgisSourceFields
} from "../src/lib/massgisDemo.js";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildVariant = process.env.OPEN_GEO_DEMO_BUILD_VARIANT ?? "isolated";
if (!["isolated", "managed"].includes(buildVariant)) {
  throw new Error("OPEN_GEO_DEMO_BUILD_VARIANT must be isolated or managed");
}
const demoRoot = resolve(
  appRoot,
  buildVariant === "managed" ? "dist/managed-demo-build" : "dist/demo-build"
);
const demoIndex = resolve(demoRoot, "index.html");
const combinedPageId = "massgis-combined-cumulative-burden-analysis";
const pm25PageId = "massgis-pm25-concentration";
const massgisQueryPath = `${new URL(MASSGIS_FEATURE_LAYER_URL).pathname}/query`;
const massgisConfig = JSON.parse(await readFile(
  new URL("../src/data/massgis-enviroscreen.json", import.meta.url),
  "utf8"
));
const expectedFields = [...massgisSourceFields(massgisConfig)];
const expectedArchive = massgisConfig.sources[0].archive;
const expectedArchiveUrl = massgisArchiveUrl(massgisConfig);
const expectedArchivePath = new URL(expectedArchiveUrl).pathname;
const massgisFixture = twoPolygonFixture(expectedFields);
const combinedLayerIds = [...massgisConfig.combinedAnalysis.layers]
  .reverse()
  .map(({slug}) => massgisLayerId(slug));
const indicatorLayerIds = massgisConfig.indicatorGroups
  .flatMap(({maps}) => maps.map(({slug}) => massgisLayerId(slug)));
const allMassgisLayerIds = [...combinedLayerIds, ...indicatorLayerIds];
const sensitiveQueryKey = /(?:^|[-_])(api[-_]?key|access[-_]?token|token|password|passwd|secret|authorization|cookie|signature|sig|client[-_]?secret)(?:$|[-_])/i;

const configuredOrigin = process.env.OPEN_GEO_DEMO_TEST_ORIGIN;
let server = null;
let baseUrl;
if (configuredOrigin) {
  baseUrl = reviewedDemoOrigin(configuredOrigin);
} else {
  if (!existsSync(demoIndex)) {
    throw new Error(
      buildVariant === "managed"
        ? "The sealed managed demo build is missing. Run npm run build:demo:managed before this acceptance check."
        : "The sealed demo build is missing. Run npm run build:demo before this acceptance check."
    );
  }
  server = createStaticServer(demoRoot);
  await listen(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
const browser = await chromium.launch({headless: true, ...chromiumExecutable()});
const results = {};

try {
  results.desktop = await checkDesktop(browser, baseUrl);
  results.mobile = await checkMobile(browser, baseUrl);
  console.log(JSON.stringify({
    status: "passed",
    target: configuredOrigin
      ? baseUrl
      : buildVariant === "managed" ? "dist/managed-demo-build" : "dist/demo-build",
    combinedPageId,
    pm25PageId,
    archiveFeatures: expectedArchive.featureCount,
    archiveFields: expectedFields.length,
    ...results
  }, null, 2));
} finally {
  await browser.close();
  if (server) await close(server);
}

function reviewedDemoOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:"
    || !["demo.studio.opengeo.tools", "dwghtckt4utb9.cloudfront.net"].includes(url.hostname)
    || url.pathname !== "/"
    || url.search
    || url.hash) {
    throw new Error("OPEN_GEO_DEMO_TEST_ORIGIN must be an exact reviewed demo origin");
  }
  return url.origin;
}

function massgisLayerId(slug) {
  return `massgis_${slug.replaceAll("-", "_")}`;
}

async function checkDesktop(browserInstance, origin) {
  const {context, audit} = await auditedContext(browserInstance, origin, {
    viewport: {width: 1440, height: 900},
    colorScheme: "dark"
  });
  const page = await context.newPage();
  const browserErrors = captureBrowserErrors(page);

  try {
    const directoryResponse = await page.goto(`${origin}/?view=examples`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    assert.equal(directoryResponse?.status(), 200, "published examples directory did not return 200");
    await page.getByRole("heading", {name: "Sample datasets", exact: true}).waitFor();
    assert.equal(await page.locator('.public-demo-project-card').count(), 4,
      "starter, MassGIS, satellite search and Studio workflow cards are not all present");
    assert.equal(await page.locator('a[data-page-id^="massgis-"]').count(), 31,
      "published MassGIS directory does not link all 31 maps");
    assert.equal(audit.archive.length, 0,
      "metadata-only examples directory downloaded the statewide archive before a map was opened");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
      "published examples directory has horizontal overflow");

    const response = await page.goto(`${origin}/?map=${combinedPageId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    assert.equal(response?.status(), 200, "direct combined demo URL did not return 200");
    await waitForWorkbench(page, combinedPageId, 33);
    await page.locator(".public-demo-notice", {hasText: "Combined cumulative burden analysis"}).waitFor();
    const panelDensity = await assertCombinedTree(page);
    await assertCombinedRenderStack(page);
    await exerciseLayerToggles(page);
    await exerciseGroupReorder(page);
    const reorderedLayerIds = await exerciseCombinedReorder(page);
    await saveAndReloadCombinedOrder(page, reorderedLayerIds);
    await authorPointAtTop(page, reorderedLayerIds);

    await page.locator(".gis-workspace-select").selectOption(pm25PageId);
    await waitForWorkbench(page, pm25PageId, 33);
    assert.equal(new URL(page.url()).searchParams.get("map"), pm25PageId);
    await assertPm25Presentation(page);
    await exerciseRepaintIdentifyLifecycle(page);
    assert.equal(audit.massgis.length, 0, "switching demo maps bypassed the reviewed archive");

    await page.goBack({waitUntil: "commit", timeout: 10_000});
    await waitForWorkbench(page, combinedPageId, 33);
    assert.equal(new URL(page.url()).searchParams.get("map"), combinedPageId);
    await assertProjectLayerOrder(page, reorderedLayerIds, [
      "massgis_massenviroscreen_score-fill",
      "massgis_massenviroscreen_score-outline",
      "massgis_population_characteristics-outline",
      "massgis_pollution_burden-outline"
    ]);
    assert.equal(audit.massgis.length, 0, "history back bypassed the reviewed archive");

    await page.goForward({waitUntil: "commit", timeout: 10_000});
    await waitForWorkbench(page, pm25PageId, 33);
    assert.equal(new URL(page.url()).searchParams.get("map"), pm25PageId);
    await assertPm25Presentation(page);
    assert.equal(audit.massgis.length, 0, "history forward bypassed the reviewed archive");

    await assertViewportLayout(page, "desktop PM2.5 after history", {mobile: false});
    assertAudit(audit, {label: "desktop", minimumArchiveRequests: 1});
    assert.deepEqual(browserErrors, [], `desktop browser errors: ${browserErrors.join(" | ")}`);
    return {
      publicationDirectory: "2 public projects, satellite search, Studio workflow links and 31 direct MassGIS map links; zero eager archive requests",
      directCombined: "passed",
      treeAndLegends: "33 layers in six groups; 3 combined six-row legends",
      renderStack: "fill, two outlines, correct source fields",
      visibilityToggles: "group and individual passed",
      orderAndDraft: "tree, context, map, and reload agree",
      runtimeTop: "authored point layer is top in tree and map",
      repaintLifecycle: "two repaints produced one identify popup",
      navigationAndHistory: "combined -> PM2.5 -> back -> forward passed",
      panelDensity,
      archiveRequests: audit.archive.length,
      massgisRequests: audit.massgis.length,
      basemapStyleRequests: audit.styles.length
    };
  } finally {
    await stopMap(page);
    await context.close();
  }
}

async function checkMobile(browserInstance, origin) {
  const {context, audit} = await auditedContext(browserInstance, origin, {
    viewport: {width: 390, height: 844},
    screen: {width: 390, height: 844},
    colorScheme: "dark",
    hasTouch: true,
    isMobile: true
  });
  const page = await context.newPage();
  const browserErrors = captureBrowserErrors(page);

  try {
    await page.goto(`${origin}/?map=${combinedPageId}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000
    });
    await waitForWorkbench(page, combinedPageId, 33);
    await assertViewportLayout(page, "phone portrait", {mobile: true});

    const toolbar = page.locator('.gis-mobile-toolbar[aria-label="Mobile map tools"]');
    await toolbar.waitFor();
    assert.equal(await toolbar.locator(".gis-mobile-command").count(), 6);
    assert.equal(
      await toolbar.evaluate((element) => {
        const before = [...element.children];
        element.closest(".opengeo-workbench")?.dispatchEvent(new CustomEvent("workbench:render"));
        return before.every((node, index) => element.children[index] === node);
      }),
      true,
      "mobile controls were replaced during a workbench render"
    );
    for (const command of ["layers", "point", "path", "polygon", "overlay", "more"]) {
      await assertTouchTarget(
        toolbar.locator(`[data-primary-command="${command}"]`),
        `phone ${command} command`
      );
    }

    await touch(page, toolbar.locator('[data-primary-command="layers"]'));
    await page.locator(".gis-panel-left").waitFor({state: "visible"});
    assert.equal(await page.locator(".gis-panel-left .gis-layer-row").count(), 33);
    await assertDrawerAboveToolbar(page, "phone portrait");
    await touch(page, page.locator('.gis-mobile-toolbar [data-primary-command="layers"]'));
    await page.locator(".gis-panel-left").waitFor({state: "hidden"});

    await touch(page, page.locator('.gis-mobile-toolbar [data-primary-command="point"]'));
    const pointGuide = page.locator('.gis-map-authoring-guide[data-authoring-kind="Point"]');
    await pointGuide.waitFor();
    assert.equal(
      await page.locator('.gis-mobile-toolbar [data-primary-command="point"]').getAttribute("aria-pressed"),
      "true"
    );
    const cancelDrawing = pointGuide.getByRole("button", {name: "Cancel drawing", exact: true});
    await assertTouchTarget(cancelDrawing, "phone cancel drawing");
    await touch(page, cancelDrawing);
    await pointGuide.waitFor({state: "detached"});

    const actions = page.locator('.gis-mobile-toolbar [data-primary-command="more"]');
    await touch(page, actions);
    const commandSheet = page.getByRole("dialog", {name: "Actions", exact: true});
    await commandSheet.waitFor();
    await assertElementBounded(page, commandSheet, "phone command sheet");
    assert.equal(await commandSheet.evaluate((element) => element === document.activeElement), true);
    await assertTouchTarget(
      commandSheet.getByRole("button", {name: "Close actions", exact: true}),
      "phone close commands"
    );
    assert.deepEqual(
      await commandSheet.locator(".gis-mobile-command-essentials [data-primary-command]").evaluateAll((elements) => (
        elements.map((element) => element.dataset.primaryCommand)
      )),
      ["new-project", "open-project", "open-file", "add-data", "save", "save-as", "layer-up", "layer-down"]
    );
    await assertTouchTarget(
      commandSheet.locator('.gis-mobile-command-category[data-mobile-command-category="project"] > summary'),
      "phone project command category"
    );
    await touch(page, commandSheet.getByRole("button", {name: "Close actions", exact: true}));
    await commandSheet.waitFor({state: "detached"});
    assert.equal(
      await page.locator('.gis-mobile-toolbar [data-primary-command="more"]').evaluate(
        (element) => element === document.activeElement
      ),
      true,
      "phone command sheet did not restore focus"
    );
    await assertTopbarIsUnobscured(page, "phone portrait");

    await page.setViewportSize({width: 844, height: 390});
    await page.waitForTimeout(250);
    await assertViewportLayout(page, "short phone landscape", {mobile: true});
    await assertTopbarIsUnobscured(page, "short phone landscape");
    await touch(page, page.locator('.gis-mobile-toolbar [data-primary-command="layers"]'));
    await page.locator(".gis-panel-left").waitFor({state: "visible"});
    await assertDrawerAboveToolbar(page, "short phone landscape");
    await touch(page, page.locator('.gis-mobile-toolbar [data-primary-command="layers"]'));
    await page.locator(".gis-panel-left").waitFor({state: "hidden"});

    assertAudit(audit, {label: "mobile", minimumArchiveRequests: 1});
    assert.deepEqual(browserErrors, [], `mobile browser errors: ${browserErrors.join(" | ")}`);
    return {
      portrait: "bounded map, drawer, command sheet, and 44px touch targets",
      landscape: "bounded map and drawer",
      touch: "layers, point, cancel, more, and close passed",
      archiveRequests: audit.archive.length,
      massgisRequests: audit.massgis.length,
      basemapStyleRequests: audit.styles.length
    };
  } finally {
    await stopMap(page);
    await context.close();
  }
}

async function assertCombinedTree(page) {
  assert.equal(await page.locator(".gis-example-map-tree").count(), 0, "the map catalog duplicates the project layer panel");
  assert.equal(await page.locator(".gis-left-panel-actions").count(), 0, "the layer panel repeats global Add data and Catalog commands");
  assert.equal(await page.locator(".gis-panel-left > .gis-bookmark-strip, .gis-panel-left > .gis-search").count(), 0,
    "bookmarks or feature search sit outside the consolidated layer workflow");
  assert.deepEqual(
    await page.locator(".gis-layer-toolbar button").evaluateAll((controls) => controls.map((control) => control.getAttribute("aria-label"))),
    ["Add data to project layers", "Show all layers", "Hide all layers", "Expand all layer groups"],
    "the compact layer toolbar is incomplete"
  );
  const rows = page.locator(".gis-project-layer-group .gis-layer-row");
  assert.equal(await rows.count(), 33, "MassGIS project does not contain all 33 layer rows");
  assert.equal(await page.locator(".gis-layer-tree-group").count(), 6, "MassGIS layer folders are incomplete");
  assert.equal(await page.locator('.gis-workspace-select[aria-label="Switch public project or map"] option').count(), 32);
  const combinedGroup = page.locator(".gis-project-layer-group").first();
  assert.equal(await combinedGroup.locator(":scope > details > summary strong").innerText(), "Combined screening layers");
  assert.equal(await combinedGroup.locator(":scope > details > summary small").innerText(), "3/3 on");
  const combinedRows = combinedGroup.locator(".gis-layer-row");
  assert.deepEqual(await combinedRows.locator(".gis-layer-row-top > button").allTextContents(), [
    "Population characteristics",
    "Pollution burden",
    "MassEnviroScreen score"
  ]);
  assert.equal(await rows.locator('.gis-layer-row-top > input[type="checkbox"]:checked').count(), 3);
  const panelDensity = await page.locator(".gis-panel-left").evaluate((panel) => {
    const bounds = (selector) => panel.querySelector(selector)?.getBoundingClientRect().toJSON();
    const header = bounds(".gis-left-panel-header");
    const toolbar = bounds(".gis-layer-toolbar");
    const project = bounds(".gis-content-tree-root > details > summary");
    const firstLayer = bounds(".gis-layer-row");
    return {
      headerHeight: header?.height ?? Infinity,
      toolbarHeight: toolbar?.height ?? Infinity,
      firstLayerHeight: firstLayer?.height ?? Infinity,
      projectStartOffset: (project?.top ?? Infinity) - panel.getBoundingClientRect().top,
      treeStartOffset: (firstLayer?.top ?? Infinity) - panel.getBoundingClientRect().top
    };
  });
  assert.ok(panelDensity.headerHeight <= 44, `layer panel header is ${panelDensity.headerHeight}px tall`);
  assert.ok(panelDensity.toolbarHeight <= 40, `layer toolbar is ${panelDensity.toolbarHeight}px tall`);
  assert.ok(panelDensity.firstLayerHeight <= 34, `desktop layer row is ${panelDensity.firstLayerHeight}px tall`);
  assert.ok(panelDensity.projectStartOffset <= 88, `project tree begins ${panelDensity.projectStartOffset}px below the panel`);
  assert.ok(panelDensity.treeStartOffset <= 160, `first nested layer begins ${panelDensity.treeStartOffset}px below the panel`);
  const legends = combinedRows.locator(".gis-style-legend");
  assert.equal(await legends.count(), 3, "combined tree does not expose a legend for every layer");
  for (let index = 0; index < 3; index += 1) {
    const entries = legends.nth(index).locator(":scope > span");
    assert.equal(await entries.count(), 6, `combined legend ${index + 1} does not include five bins and no-data`);
    assert.deepEqual(await entries.locator(":scope > span:last-child").allTextContents(), [
      "< 20",
      "20 – < 40",
      "40 – < 60",
      "60 – < 80",
      "≥ 80",
      "No data"
    ]);
  }
  return panelDensity;
}

async function assertCombinedRenderStack(page) {
  const sharedSourceId = "shared-massgis-massenviroscreen-feature-layer-source";
  const expectedStack = [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_pollution_burden-outline",
    "massgis_population_characteristics-outline"
  ];
  await waitForMapLayers(page, expectedStack);
  const snapshot = await page.locator(".opengeo-workbench").evaluate((shell, layerIds) => {
    const map = shell.__opengeoMap;
    const stack = map.getStyle().layers.map(({id}) => id).filter((id) => (
      id.startsWith("massgis_") && map.getLayoutProperty(id, "visibility") !== "none"
    ));
    return {
      stack,
      layerTypes: layerIds.map((id) => map.getLayer(id)?.type ?? null),
      layerSources: layerIds.map((id) => map.getLayer(id)?.source ?? null),
      sharedSources: Object.keys(map.getStyle().sources).filter((id) => id.startsWith("shared-massgis-")),
      archivedFeatureCounts: layerIds.map((id) => shell.__opengeoData.get(
        shell.__opengeoLayers.find(({layerId}) => id.startsWith(`${layerId}-`))?.layerId
      )?.features?.length ?? 0),
      renderedCounts: layerIds.map((id) => map.queryRenderedFeatures({layers: [id]}).length),
      paint: [
        map.getPaintProperty(layerIds[0], "fill-color"),
        map.getPaintProperty(layerIds[2], "line-color"),
        map.getPaintProperty(layerIds[3], "line-color")
      ],
      opacity: [
        map.getPaintProperty(layerIds[0], "fill-opacity"),
        map.getPaintProperty(layerIds[1], "line-opacity"),
        map.getPaintProperty(layerIds[2], "line-opacity"),
        map.getPaintProperty(layerIds[3], "line-opacity")
      ]
    };
  }, expectedStack);

  assert.deepEqual(snapshot.stack, expectedStack, "MapLibre combined render stack is not deterministic");
  assert.deepEqual(snapshot.layerTypes, ["fill", "line", "line", "line"]);
  assert.deepEqual(snapshot.sharedSources, [sharedSourceId], "combined analysis did not register exactly one shared source");
  assert.deepEqual(
    snapshot.layerSources,
    expectedStack.map(() => sharedSourceId),
    "combined paint layers do not all reference the shared MassGIS source"
  );
  assert.equal(
    snapshot.archivedFeatureCounts.every((count) => count === expectedArchive.featureCount),
    true,
    "combined layers do not carry the complete reviewed archive"
  );
  assert.equal(snapshot.renderedCounts.every((count) => count > 0), true, "combined layers were registered but not rendered");
  assert.deepEqual(snapshot.opacity, [0.68, 0.68, 0.9, 0.9], "combined preset opacity did not reach MapLibre");
  for (const [expression, field] of [
    [snapshot.paint[0], "MassEnviroScore"],
    [snapshot.paint[1], "PollutionBurden"],
    [snapshot.paint[2], "PopCharacteristics"]
  ]) {
    assert.equal(JSON.stringify(expression).includes(`\"${field}\"`), true, `renderer omitted ${field}`);
  }
}

async function exerciseLayerToggles(page) {
  const populationLayerId = "massgis_population_characteristics-outline";
  const population = page.getByRole("checkbox", {name: "Show Population characteristics", exact: true});
  await population.uncheck();
  await waitForLayerVisibility(page, [populationLayerId], "none");
  assert.equal(
    await page.locator(".opengeo-workbench").evaluate(
      (shell) => shell.__opengeoMap.getLayoutProperty("massgis_pollution_burden-outline", "visibility")
    ),
    "visible",
    "individual visibility toggle changed a sibling layer"
  );
  await page.getByRole("checkbox", {name: "Show Population characteristics", exact: true}).check();
  await waitForLayerVisibility(page, [populationLayerId], "visible");

  const paintLayerIds = [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_pollution_burden-outline",
    "massgis_population_characteristics-outline"
  ];
  await page.getByRole("checkbox", {
    name: "Show all layers in Combined screening layers",
    exact: true
  }).uncheck();
  await waitForLayerVisibility(page, paintLayerIds, "none");
  assert.equal(
    await page.locator(".gis-project-layer-group .gis-layer-row input[type=checkbox]:checked").count(),
    0,
    "group visibility toggle did not update all rows"
  );
  await page.getByRole("checkbox", {
    name: "Show all layers in Combined screening layers",
    exact: true
  }).check();
  await waitForLayerVisibility(page, paintLayerIds, "visible");

  const exposureGroup = page.locator(".gis-layer-tree-group").filter({
    has: page.getByText("Environmental Exposures", {exact: true})
  });
  await exposureGroup.locator(":scope > summary").click();
  const pm25 = page.getByRole("checkbox", {name: "Show PM2.5 concentration", exact: true});
  await pm25.check();
  await waitForLayerVisibility(page, ["massgis_pm25_concentration-fill", "massgis_pm25_concentration-outline"], "visible");
  assert.equal(
    await page.locator('.gis-layer-row-top > input[type="checkbox"]:checked').count(),
    4,
    "a layer in another folder replaced the three visible combined layers"
  );
  await pm25.uncheck();
  await waitForLayerVisibility(page, ["massgis_pm25_concentration-fill", "massgis_pm25_concentration-outline"], "none");
}

async function exerciseGroupReorder(page) {
  const exposureLayerIds = massgisConfig.indicatorGroups[0].maps.map(({slug}) => massgisLayerId(slug));
  const remainingIndicatorLayerIds = indicatorLayerIds.slice(exposureLayerIds.length);
  const pm25 = page.getByRole("checkbox", {name: "Show PM2.5 concentration", exact: true});
  await pm25.check();
  await page.getByRole("button", {name: "Move Environmental Exposures group up", exact: true}).click();
  await assertProjectLayerOrder(
    page,
    [...exposureLayerIds, ...combinedLayerIds, ...remainingIndicatorLayerIds],
    [
      "massgis_massenviroscreen_score-fill",
      "massgis_massenviroscreen_score-outline",
      "massgis_pollution_burden-outline",
      "massgis_population_characteristics-outline",
      "massgis_pm25_concentration-fill",
      "massgis_pm25_concentration-outline"
    ]
  );
  await page.getByRole("button", {name: "Move Environmental Exposures group down", exact: true}).click();
  await pm25.uncheck();
  await assertProjectLayerOrder(page, allMassgisLayerIds, [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_pollution_burden-outline",
    "massgis_population_characteristics-outline"
  ]);
}

async function exerciseCombinedReorder(page) {
  const reorderedCombinedLayerIds = [
    "massgis_pollution_burden",
    "massgis_population_characteristics",
    "massgis_massenviroscreen_score"
  ];
  const reorderedLayerIds = [...reorderedCombinedLayerIds, ...indicatorLayerIds];
  await page.getByRole("button", {name: "Move Pollution burden up", exact: true}).click();
  await assertProjectLayerOrder(page, reorderedLayerIds, [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_population_characteristics-outline",
    "massgis_pollution_burden-outline"
  ]);
  assert.equal(
    await page.getByRole("button", {name: "Move Pollution burden up", exact: true}).isDisabled(),
    true,
    "the top configured sibling can cross its group boundary"
  );
  assert.equal(
    await page.getByRole("button", {name: "Move MassEnviroScreen score down", exact: true}).isDisabled(),
    true,
    "the bottom configured sibling can cross its group boundary"
  );
  return reorderedLayerIds;
}

async function saveAndReloadCombinedOrder(page, expectedLayerIds) {
  await page.getByRole("button", {name: "Save locally", exact: true}).click();
  const saved = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) => (
      candidate.startsWith("opengeo.public-demo.")
      && candidate.endsWith(".massgis-combined-cumulative-burden-analysis:layer-workspace-v1")
    ));
    return key ? {key, value: JSON.parse(localStorage.getItem(key))} : null;
  });
  assert.ok(saved, "combined browser draft was not written");
  assert.deepEqual(saved.value.layers.map(({layerId}) => layerId), expectedLayerIds);
  assert.deepEqual(saved.value.layers.map(({order}) => order), allMassgisLayerIds.map((_, index) => index));

  await page.reload({waitUntil: "domcontentloaded", timeout: 30_000});
  await waitForWorkbench(page, combinedPageId, 33);
  await assertProjectLayerOrder(page, expectedLayerIds, [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_population_characteristics-outline",
    "massgis_pollution_burden-outline"
  ]);
}

async function authorPointAtTop(page, configuredLayerIds) {
  await page.getByRole("button", {name: "Point", exact: true}).click();
  const map = page.locator(".gis-map");
  const box = await map.boundingBox();
  assert.ok(box, "map is unavailable for point authoring");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // Drawing already creates the point; metadata editing updates that feature.
  await page.waitForFunction(() => {
    const features = document.querySelector(".opengeo-workbench")
      ?.__opengeoData?.get("kml-places")?.features;
    return features?.length === 1 && features[0].geometry.type === "Point";
  });
  const editor = page.locator(".gis-places-editor[open]");
  const name = editor.locator('[data-kml-editing-field="name"]');
  await name.waitFor();
  await name.fill("Acceptance point");
  await editor.getByRole("button", {name: "Apply place edits", exact: true}).click();
  await page.getByRole("button", {name: "Edit Acceptance point", exact: true}).waitFor();
  await page.waitForFunction(() => (
    document.querySelector(".opengeo-workbench")?.__opengeoLayers?.[0]?.layerId === "kml-places"
  ));
  const expectedLayerIds = ["kml-places", ...configuredLayerIds];
  await assertProjectLayerOrder(page, expectedLayerIds, [
    "massgis_massenviroscreen_score-fill",
    "massgis_massenviroscreen_score-outline",
    "massgis_population_characteristics-outline",
    "massgis_pollution_burden-outline",
    "kml-places-polygons",
    "kml-places-lines",
    "kml-places-points",
    "kml-places-labels"
  ]);
  await page.waitForFunction(() => (
    document.querySelector(".opengeo-workbench")?.__opengeoMap
      ?.querySourceFeatures("kml-places-source")?.length === 1
  ), undefined, {timeout: 10_000});
  const kml = await page.locator(".opengeo-workbench").evaluate((shell) => ({
    features: shell.__opengeoMap.querySourceFeatures("kml-places-source").length,
    orderDisabled: [...shell.querySelectorAll('[data-layer-id="kml-places"] .gis-layer-order-controls button')]
      .map(({disabled}) => disabled)
  }));
  assert.equal(kml.features, 1, "authored point was not rendered from the KML layer source");
  assert.deepEqual(kml.orderDisabled, [true, true], "the ungrouped point layer can cross its root segment boundary");
}

async function assertProjectLayerOrder(page, expectedLayerIds, expectedMapBottomToTop) {
  await page.waitForFunction(({expectedLayerIds: expected, expectedMapBottomToTop: expectedMap}) => {
    const shell = document.querySelector(".opengeo-workbench");
    const map = shell?.__opengeoMap;
    const tree = [...shell?.querySelectorAll(".gis-content-tree-root .gis-layer-row") ?? []]
      .map(({dataset}) => dataset.layerId);
    const context = shell?.__opengeoLayers?.map(({layerId}) => layerId) ?? [];
    const mapStack = map?.getStyle?.().layers
      ?.map(({id}) => id)
      .filter((id) => (id.startsWith("massgis_") || id.startsWith("kml-places-"))
        && map.getLayoutProperty(id, "visibility") !== "none") ?? [];
    return JSON.stringify(tree) === JSON.stringify(expected)
      && JSON.stringify(context) === JSON.stringify(expected)
      && JSON.stringify(mapStack) === JSON.stringify(expectedMap);
  }, {expectedLayerIds, expectedMapBottomToTop}, {timeout: 10_000});
  const snapshot = await page.locator(".opengeo-workbench").evaluate((shell) => ({
    tree: [...shell.querySelectorAll(".gis-content-tree-root .gis-layer-row")].map(({dataset}) => dataset.layerId),
    context: shell.__opengeoLayers.map(({layerId}) => layerId),
    mapBottomToTop: shell.__opengeoMap.getStyle().layers
      .map(({id}) => id)
      .filter((id) => (id.startsWith("massgis_") || id.startsWith("kml-places-"))
        && shell.__opengeoMap.getLayoutProperty(id, "visibility") !== "none")
  }));
  assert.deepEqual(snapshot.tree, expectedLayerIds, "visible project tree diverged from the layer stack");
  assert.deepEqual(snapshot.context, expectedLayerIds, "workbench layer order diverged from the visible tree");
  assert.deepEqual(snapshot.mapBottomToTop, expectedMapBottomToTop, "MapLibre stack diverged from the project layer order");
}

async function exerciseRepaintIdentifyLifecycle(page) {
  const row = page.locator('.gis-layer-row[data-layer-id="massgis_pm25_concentration"]');
  await row.locator(".gis-layer-more > summary").click();
  await row.getByRole("button", {name: "Style layer", exact: true}).click();
  for (const paletteName of ["OpenGeo palette", "Risk palette"]) {
    await page.getByRole("button", {name: paletteName, exact: true}).click();
    await waitForMapLayers(page, ["massgis_pm25_concentration-fill", "massgis_pm25_concentration-outline"]);
  }
  const clickPoint = await page.locator(".opengeo-workbench").evaluate((shell) => {
    const map = shell.__opengeoMap;
    const point = map.project([-72.04, 42.15]);
    const rect = map.getCanvas().getBoundingClientRect();
    return {x: rect.left + point.x, y: rect.top + point.y};
  });
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.locator(".maplibregl-popup").waitFor();
  assert.equal(await page.locator(".maplibregl-popup").count(), 1, "repaint accumulated duplicate identify handlers");
}

async function assertPm25Presentation(page) {
  const rows = page.locator(".gis-project-layer-group .gis-layer-row");
  assert.equal(await rows.count(), 33);
  const row = page.locator('.gis-layer-row[data-layer-id="massgis_pm25_concentration"]');
  assert.equal(await row.locator(".gis-layer-row-top > button").innerText(), "PM2.5 concentration");
  assert.equal(await row.locator(".gis-style-legend > span").count(), 6);
  assert.equal(await rows.locator('.gis-layer-row-top > input[type="checkbox"]:checked').count(), 1);
  const stack = ["massgis_pm25_concentration-fill", "massgis_pm25_concentration-outline"];
  await waitForMapLayers(page, stack);
  const snapshot = await page.locator(".opengeo-workbench").evaluate((shell) => {
    const map = shell.__opengeoMap;
    return {
      stack: map.getStyle().layers.map(({id}) => id).filter((id) => (
        id.startsWith("massgis_") && map.getLayoutProperty(id, "visibility") !== "none"
      )),
      expression: map.getPaintProperty("massgis_pm25_concentration-fill", "fill-color"),
      opacity: [
        map.getPaintProperty("massgis_pm25_concentration-fill", "fill-opacity"),
        map.getPaintProperty("massgis_pm25_concentration-outline", "line-opacity")
      ],
      rendered: map.queryRenderedFeatures({layers: ["massgis_pm25_concentration-fill"]}).length
    };
  });
  assert.deepEqual(snapshot.stack, stack);
  assert.equal(JSON.stringify(snapshot.expression).includes('"EXPpctilePM25"'), true);
  assert.deepEqual(snapshot.opacity, [0.76, 0.76], "indicator preset opacity did not reach MapLibre");
  assert.equal(snapshot.rendered > 0, true, "PM2.5 archive polygons were not rendered");
}

async function waitForWorkbench(page, pageId, layerCount) {
  await page.locator(`.public-workbench-demo[data-active-page="${pageId}"] .opengeo-workbench`).waitFor({
    timeout: 20_000
  });
  await page.waitForFunction(({pageId: expectedPageId, layerCount: expectedLayerCount}) => {
    const root = document.querySelector(".public-workbench-demo");
    const shell = root?.querySelector(".opengeo-workbench");
    return root?.dataset.activePage === expectedPageId
      && shell?.__opengeoLayers?.length === expectedLayerCount
      && shell.__opengeoMap?.isStyleLoaded?.();
  }, {pageId, layerCount}, {timeout: 20_000});
}

async function waitForMapLayers(page, layerIds) {
  await page.waitForFunction((expected) => {
    const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
    return map?.isStyleLoaded?.() && expected.every((layerId) => map.getLayer(layerId));
  }, layerIds, {timeout: 20_000});
  await page.waitForTimeout(100);
}

async function waitForLayerVisibility(page, layerIds, visibility) {
  await page.waitForFunction(({layerIds: expectedLayerIds, visibility: expectedVisibility}) => {
    const map = document.querySelector(".opengeo-workbench")?.__opengeoMap;
    return expectedLayerIds.every((layerId) => (
      map?.getLayoutProperty(layerId, "visibility") === expectedVisibility
    ));
  }, {layerIds, visibility}, {timeout: 10_000});
}

async function assertViewportLayout(page, label, {mobile}) {
  const result = await page.evaluate(({mobile: compact}) => {
    const boundedSelectors = compact
      ? [".opengeo-workbench", ".gis-topbar", ".gis-map-column", ".gis-map", ".gis-mobile-toolbar"]
      : [".public-demo-notice", ".opengeo-workbench", ".gis-topbar", ".gis-panel-left", ".gis-map-column", ".gis-map"];
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const bounds = boundedSelectors.flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!element || !visible(element)) return [{selector, missing: true}];
      const rect = element.getBoundingClientRect();
      return [{selector, rect: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height}}];
    });
    const canvas = document.querySelector(".gis-map .maplibregl-canvas")?.getBoundingClientRect();
    const frame = document.querySelector(".gis-map")?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      bounds,
      canvas: canvas ? {left: canvas.left, top: canvas.top, width: canvas.width, height: canvas.height} : null,
      frame: frame ? {left: frame.left, top: frame.top, width: frame.width, height: frame.height} : null
    };
  }, {mobile});

  assert.equal(result.overflowX <= 1, true, `${label} has ${result.overflowX}px horizontal overflow`);
  for (const item of result.bounds) {
    assert.equal(item.missing, undefined, `${label} is missing visible ${item.selector}`);
    assert.equal(
      item.rect.left >= -1 && item.rect.top >= -1
        && item.rect.right <= result.width + 1 && item.rect.bottom <= result.height + 1,
      true,
      `${label} ${item.selector} escaped the viewport: ${JSON.stringify(item.rect)}`
    );
  }
  assert.ok(result.canvas && result.frame, `${label} map canvas is unavailable`);
  assert.equal(result.frame.width >= 260 && result.frame.height >= 150, true, `${label} map has no usable area`);
  assert.equal(
    Math.abs(result.canvas.left - result.frame.left) <= 1
      && Math.abs(result.canvas.top - result.frame.top) <= 1
      && Math.abs(result.canvas.width - result.frame.width) <= 2
      && Math.abs(result.canvas.height - result.frame.height) <= 2,
    true,
    `${label} canvas does not fill the map frame: ${JSON.stringify({canvas: result.canvas, frame: result.frame})}`
  );
}

async function assertDrawerAboveToolbar(page, label) {
  const [drawer, toolbar] = await Promise.all([
    page.locator(".gis-panel-left").boundingBox(),
    page.locator(".gis-mobile-toolbar").boundingBox()
  ]);
  assert.ok(drawer && toolbar, `${label} drawer or toolbar is not rendered`);
  assert.equal(drawer.x >= -1 && drawer.x + drawer.width <= (await page.evaluate(() => innerWidth)) + 1, true);
  assert.equal(drawer.y >= -1 && drawer.y + drawer.height <= toolbar.y + 1, true, `${label} drawer overlaps the toolbar`);
}

async function assertTopbarIsUnobscured(page, label) {
  const result = await page.locator(".gis-topbar").evaluate((topbar) => {
    const rect = topbar.getBoundingClientRect();
    const point = {x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 24)};
    const hit = document.elementFromPoint(point.x, point.y);
    return {
      unobscured: Boolean(hit && topbar.contains(hit)),
      hit: hit?.className ?? hit?.tagName ?? null,
      point
    };
  });
  assert.equal(result.unobscured, true, `${label} topbar is obscured by ${result.hit} at ${JSON.stringify(result.point)}`);
}

async function assertElementBounded(page, locator, label) {
  const box = await locator.boundingBox();
  const viewport = await page.evaluate(() => ({width: innerWidth, height: innerHeight}));
  assert.ok(box, `${label} is not rendered`);
  assert.equal(
    box.x >= -1 && box.y >= -1
      && box.x + box.width <= viewport.width + 1
      && box.y + box.height <= viewport.height + 1,
    true,
    `${label} escaped the viewport: ${JSON.stringify({box, viewport})}`
  );
}

async function assertTouchTarget(locator, label) {
  await locator.waitFor({state: "visible"});
  const box = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
  });
  assert.ok(box.width > 0 && box.height > 0, `${label} is not rendered`);
  assert.equal(box.width >= 44 && box.height >= 44, true, `${label} is smaller than 44px: ${JSON.stringify(box)}`);
}

async function touch(_page, locator) {
  await locator.tap();
}

async function auditedContext(browserInstance, origin, options) {
  const context = await browserInstance.newContext(options);
  const audit = {archive: [], massgis: [], styles: [], fonts: [], unexpected: [], validationErrors: []};
  await context.addCookies([{
    name: "private_session",
    value: "must-not-leak-to-massgis",
    domain: "services1.arcgis.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "None"
  }]);
  assert.equal(
    (await context.cookies(MASSGIS_FEATURE_LAYER_URL)).some(({name}) => name === "private_session"),
    true,
    "privacy test cookie was not installed"
  );
  await context.addInitScript(() => {
    if (location.hostname === "127.0.0.1") {
      if (sessionStorage.getItem("opengeo.massgisAcceptanceInitialized") !== "1") {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("opengeo.public-demo.")) localStorage.removeItem(key);
        }
        sessionStorage.setItem("opengeo.massgisAcceptanceInitialized", "1");
      }
      sessionStorage.setItem("opengeo.accessToken", "local-secret-must-not-leak");
    }
  });
  const localOrigin = new URL(origin).origin;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href === expectedArchiveUrl) {
      const record = {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: await request.allHeaders(),
        postData: request.postData()
      };
      audit.archive.push(record);
      try {
        validateArchiveRequest(record);
      } catch (error) {
        audit.validationErrors.push(error.message);
      }
      await route.continue();
      return;
    }
    if (url.origin === localOrigin) {
      await route.continue();
      return;
    }
    if (url.origin === "https://tiles.openfreemap.org"
      && url.pathname === "/styles/positron" && !url.search && !url.hash) {
      audit.styles.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {"access-control-allow-origin": "*", "cache-control": "no-store"},
        body: JSON.stringify({
          version: 8,
          name: "OpenGeo deterministic MassGIS acceptance basemap",
          sources: {},
          layers: [{id: "background", type: "background", paint: {"background-color": "#eef2f3"}}]
        })
      });
      return;
    }
    if (url.origin === "https://fonts.googleapis.com"
      && url.pathname === "/css2"
      && url.searchParams.get("family") === "Source Serif 4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900"
      && url.searchParams.get("display") === "swap"
      && [...url.searchParams.keys()].length === 2) {
      audit.fonts.push(request.url());
      await route.fulfill({
        status: 200,
        contentType: "text/css",
        headers: {"access-control-allow-origin": "*", "cache-control": "no-store"},
        body: "/* Deterministic acceptance uses system serif fallback. */"
      });
      return;
    }
    if (url.origin === new URL(MASSGIS_FEATURE_LAYER_URL).origin && url.pathname === massgisQueryPath) {
      const record = {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: await request.allHeaders(),
        postData: request.postData()
      };
      audit.massgis.push(record);
      try {
        validateMassgisRequest(record, localOrigin);
      } catch (error) {
        audit.validationErrors.push(error.message);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/geo+json",
        headers: {"access-control-allow-origin": "*", "cache-control": "no-store"},
        body: JSON.stringify(massgisFixture)
      });
      return;
    }
    audit.unexpected.push(request.url());
    await route.abort("blockedbyclient");
  });
  return {context, audit};
}

function validateMassgisRequest(record, localOrigin) {
  const url = new URL(record.url);
  const expectedParameters = {
    where: "1=1",
    outFields: expectedFields.join(","),
    returnGeometry: "true",
    returnZ: "false",
    returnM: "false",
    outSR: "4326",
    geometryPrecision: "5",
    orderByFields: "OBJECTID ASC",
    resultOffset: "0",
    resultRecordCount: "1000",
    returnExceededLimitFeatures: "true",
    f: "geojson"
  };
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "services1.arcgis.com");
  assert.equal(url.pathname, massgisQueryPath);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert.deepEqual([...url.searchParams.keys()].sort(), Object.keys(expectedParameters).sort());
  for (const [name, expected] of Object.entries(expectedParameters)) {
    assert.deepEqual(url.searchParams.getAll(name), [expected], `MassGIS query parameter ${name} changed`);
  }
  assert.equal([...url.searchParams.keys()].some((key) => sensitiveQueryKey.test(key)), false);
  assert.equal(record.method, "GET");
  assert.equal(record.resourceType, "fetch");
  assert.equal(record.postData, null);
  assert.equal(record.headers.authorization, undefined);
  assert.equal(record.headers.cookie, undefined);
  assert.equal(record.headers.referer, undefined);
  assert.equal(record.headers.origin, localOrigin);
  assert.equal(record.headers.accept, "application/geo+json, application/json;q=0.9");
  assert.equal(JSON.stringify(record).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(record).includes("local-secret"), false);
}

function validateArchiveRequest(record) {
  const url = new URL(record.url);
  assert.equal(url.href, expectedArchiveUrl);
  assert.equal(url.origin, "https://s3.us-east-1.amazonaws.com");
  assert.equal(url.pathname, expectedArchivePath);
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.equal(record.method, "GET");
  assert.equal(record.resourceType, "fetch");
  assert.equal(record.postData, null);
  assert.equal(record.headers.authorization, undefined);
  assert.equal(record.headers.cookie, undefined);
  assert.equal(record.headers.accept, "application/gzip, application/octet-stream;q=0.9");
  assert.equal(JSON.stringify(record).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(record).includes("local-secret"), false);
}

function assertAudit(audit, {label, minimumArchiveRequests}) {
  assert.equal(audit.archive.length >= minimumArchiveRequests, true, `${label} did not request the reviewed MassGIS archive`);
  assert.equal(audit.massgis.length, 0, `${label} bypassed the archive and queried MassGIS directly`);
  assert.deepEqual(audit.validationErrors, [], `${label} archive or source request contract failed`);
  assert.equal(audit.styles.length >= 1, true, `${label} did not request the reviewed OpenFreeMap style`);
  assert.deepEqual(audit.unexpected, [], `${label} attempted unreviewed external requests`);
}

function captureBrowserErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function stopMap(page) {
  if (page.isClosed()) return;
  await page.locator(".opengeo-workbench").evaluate((shell) => shell.__opengeoMap?.stop?.()).catch(() => {});
}

function twoPolygonFixture(fields) {
  return {
    type: "FeatureCollection",
    exceededTransferLimit: false,
    features: [
      massgisFeature(fields, 101, 18, [[
        [-72.18, 42.02], [-71.9, 42.02], [-71.9, 42.28], [-72.18, 42.28], [-72.18, 42.02]
      ]]),
      massgisFeature(fields, 102, 82, [[
        [-71.78, 42.05], [-71.48, 42.05], [-71.48, 42.32], [-71.78, 42.32], [-71.78, 42.05]
      ]])
    ]
  };
}

function massgisFeature(fields, objectId, baseValue, coordinates) {
  const properties = Object.fromEntries(fields.map((field, index) => [field, (baseValue + index * 7) % 101]));
  Object.assign(properties, {
    OBJECTID: objectId,
    GEOID: `25025000${objectId}`,
    NAME: `Acceptance block group ${objectId}`,
    COSUB: "Deterministic fixture",
    EXPpctilePM25: objectId === 101 ? 15 : 85,
    MassEnviroScore: objectId === 101 ? 10 : 90,
    PollutionBurden: objectId === 101 ? 30 : 70,
    PopCharacteristics: objectId === 101 ? 45 : 88
  });
  return {
    type: "Feature",
    id: objectId,
    properties,
    geometry: {type: "Polygon", coordinates}
  };
}

function createStaticServer(root) {
  return createServer(async (request, response) => {
    try {
      if (!request.url || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(405, {allow: "GET, HEAD"});
        response.end();
        return;
      }
      const filePath = staticFile(root, request.url);
      if (!filePath) {
        response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
        response.end("Not found");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentType(filePath),
        "content-length": body.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch (error) {
      response.writeHead(500, {"content-type": "text/plain; charset=utf-8"});
      response.end(error.stack);
    }
  });
}

function staticFile(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const relative = pathname === "/" ? "index.html" : normalize(pathname.replace(/^\/+/, ""));
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return existsSync(candidate) ? candidate : null;
}

function contentType(filePath) {
  return ({
    ".css": "text/css; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".woff2": "font/woff2"
  })[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function listen(httpServer) {
  return new Promise((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolvePromise);
  });
}

function close(httpServer) {
  return new Promise((resolvePromise, reject) => {
    httpServer.close((error) => error ? reject(error) : resolvePromise());
  });
}

function chromiumExecutable() {
  const executablePath = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable"
  ].filter(Boolean).find((candidate) => existsSync(candidate));
  return executablePath ? {executablePath} : {};
}
