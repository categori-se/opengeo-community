import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {initializeIntegratedStudioSession} from "./integrated-studio-built-shell.mjs";

const extension = "opengeoPrintLayouts";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// The existing development profile owns the real local API, retained SQL rows,
// browser, request/time ceilings and single permitted UI PATCH. No fixture adapter
// or transport substitution is installed here.
export async function exerciseDevelopmentPrint({page, context, origin, work, organization,
  readApi, seedProgress, printProgress, checkpointPrint}) {
  if (process.env.OPENGEO_COMMUNITY_PRINT_TEMPLATE_SMOKE === "1") {
    return exerciseDevelopmentTemplatePrint({page, context, origin, work, organization,
      readApi, seedProgress, printProgress, checkpointPrint});
  }
  const projectId = seedProgress.project, mapId = seedProgress.map?.id;
  assert.match(projectId, /^[0-9a-f-]{36}$/);
  assert.match(mapId, /^[0-9a-f-]{36}$/);
  const mapPath = `/projects/${projectId}/maps/${mapId}`;
  const svgPath = join(work, "print-reopened-layout.svg");
  const proofPath = join(work, "print-browser-proof.json");
  const checkpoint = async update => {
    Object.assign(printProgress, update);
    await checkpointPrint(update);
  };
  const proof = {mode: "retained-development-project-print", projectId, mapId,
    scope: "Compiled Studio, actual MapLibre pixels and real local API/SQL persistence; synthetic owner session and local cloud transport.",
    notProven: ["Production authentication/delivery", "Provider basemaps", "Independent human acceptance", "Full cartographic parity"],
    browserErrors: []};
  const writeProof = () => writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n");
  let reopened;
  try {
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    assert.equal(seedProgress.styledSaved, true);
    assert.equal(seedProgress.reopened, true);
    const metadata = seedProgress.fixture?.metadata;
    for (const field of ["title", "license", "attribution"]) {
      assert.equal(typeof metadata?.[field], "string");
      assert.ok(metadata[field].trim().length > 0 && metadata[field].length < 500);
    }
    assert.equal(metadata.license, "CC0-1.0");
    assert.equal(seedProgress.fixture.sha256, "b384b0990bc62a8a5339e801098f995989bd6a770fdbf5fe7f58025a2351c96c");
    assert.equal(seedProgress.fixture.featureNames.length, 5);
    const names = [...seedProgress.fixture.featureNames].sort();
    const baseline = printProgress.baselineMap ?? seedProgress.map;
    assert.equal(baseline.id, mapId);
    assert.equal(baseline.project_id, projectId);
    assert.equal(baseline.version, 2, "Only the retained pre-Print map revision is admitted");
    assert.equal(baseline.definition.layers.length, 1);
    assert.equal(baseline.definition.extensions?.[extension], undefined);
    const [layer] = baseline.definition.layers;
    assert.equal(layer.datasetId, seedProgress.datasetId);
    assert.equal(layer.datasetVersionId, seedProgress.datasetVersionId);
    assert.equal(layer.style.circleColor, "#2563eb");
    assert.equal(layer.opacity, 0.8);
    assert.equal(layer.visible, true);
    assert.equal(layer.geometryType, "Point");
    assert.equal(baseline.definition.basemaps.filter(item => item.visible !== false).length, 1);
    assert.equal(baseline.definition.basemaps.find(item => item.visible !== false).kind, "blank");
    const title = "Community facilities · A4 main and inset";
    const caption = `Source: ${metadata.title}. License: ${metadata.license}. Credit: ${metadata.attribution}.`;
    await checkpoint({status: "running", phase: "read-current-map", baselineMap: baseline,
      projectId, mapId, title, sourceMetadata: metadata});
    let savedMap = await readApi(mapPath);
    assert.equal(savedMap.id, mapId);
    assert.equal(savedMap.project_id, projectId);

    if (printProgress.saveAttempted) {
      // An interrupted/uncertain PATCH is reconciled only by this exact GET.
      // An unchanged or unexpected head is a stop, never permission to save again.
      assert.equal(printProgress.expectedVersion, baseline.version);
      assert.equal(typeof printProgress.layoutId, "string");
      assert.ok(printProgress.preparedLayout, "The pre-save layout checkpoint is required for readback");
      assertCommitted(savedMap, baseline, printProgress.preparedLayout);
      await checkpoint({phase: "save-reconciled-by-readback", saveConfirmed: true, savedMap,
        savedVersion: savedMap.version, committedWriteReplayed: false});
    } else {
      assert.deepEqual(savedMap, baseline, "The selected map must still match its retained receipt before editing");
      assert.equal(existsSync(svgPath), false, "A retained output must be reconciled, never overwritten");
      await checkpoint({phase: "open-selected-map"});
      await page.goto(`${origin}/workspaces?composition=${mapId}`);
      await renderedFrame(page, layer, names, false);
      const workbench = page.locator(".opengeo-workbench");
      await workbench.locator('.gis-menubar [data-menu="project"] > button').click();
      await workbench.getByRole("menuitem", {name: "Open Print Studio", exact: true}).click();
      await page.locator(".project-print-editor").waitFor();
      const selectedRoute = new URL(page.url());
      assert.equal(selectedRoute.searchParams.get("composition"), mapId);
      assert.equal(selectedRoute.searchParams.get("manage"), "print");
      const editor = page.locator(".project-print-editor");
      assert.equal(await editor.getByLabel("Layout", {exact: true}).locator("option").count(), 1);
      await editor.getByLabel("Layout title", {exact: true}).fill(title);
      await editor.getByLabel("Layout title", {exact: true}).blur();
      await editor.getByLabel("Paper size", {exact: true}).selectOption("A4");
      await editor.getByLabel("Orientation", {exact: true}).selectOption("landscape");
      await editor.getByLabel("Caption", {exact: true}).fill(caption);
      await editor.getByLabel("Caption", {exact: true}).blur();
      await capture(page, "main", "before-save");
      await editor.getByRole("button", {name: "Add inset map", exact: true}).click();
      await capture(page, "inset", "before-save");
      const prepared = await layoutFromStage(editor);
      assert.equal(prepared.layout.title, title);
      assert.equal(prepared.layout.caption, caption);
      assertLayout(prepared.layout, layer);
      assert.equal(prepared.captures.length, 2);
      assert.equal(await editor.locator('.print-stage svg g[clip-path] > image').count(), 2);
      const layoutId = await editor.getByLabel("Layout", {exact: true}).inputValue();
      assert.equal(layoutId, prepared.layout.id);
      // This durable checkpoint must precede the only permitted mutation.
      await checkpoint({phase: "save-layout", layoutId, expectedVersion: baseline.version,
        preparedLayout: prepared.layout, saveAttempted: true});
      const [response] = await Promise.all([
        page.waitForResponse(response => response.request().method() === "PATCH"
          && new URL(response.url()).pathname === `/api${mapPath}`),
        editor.getByRole("button", {name: "Save layout", exact: true}).click()
      ]);
      assert.equal(response.status(), 200, "Stop and reconcile the saved head; never replay the layout PATCH");
      await editor.locator(':scope > [role="status"]').filter({hasText: /Layout saved in Project revision/}).waitFor();
      savedMap = await readApi(mapPath);
      assertCommitted(savedMap, baseline, prepared.layout);
      await checkpoint({phase: "save-confirmed", saveConfirmed: true, savedVersion: savedMap.version, savedMap});
    }

    const expectedLayout = savedMap.definition.extensions[extension].layouts[0];
    proof.layoutId = expectedLayout.id;
    proof.expectedVersion = baseline.version;
    proof.savedVersion = savedMap.version;
    proof.canonicalDefinitionPreserved = true;
    proof.sourceMetadata = metadata;
    // A completed or interrupted download is inspected from retained bytes. It
    // never triggers another export just to repair an assertion or receipt.
    if (!printProgress.outputAttempted) {
      await checkpoint({phase: "fresh-print-host"});
      reopened = await context.newPage();
      reopened.setDefaultTimeout(15_000);
      reopened.on("pageerror", error => proof.browserErrors.push(error.message));
      await reopened.addInitScript(initializeIntegratedStudioSession, {organization, origin, actor: "owner"});
      await reopened.goto(`${origin}/workspaces?composition=${mapId}&manage=print`);
      const editor = reopened.locator(".project-print-editor");
      await editor.waitFor();
      assert.equal(await editor.getByLabel("Layout", {exact: true}).inputValue(), expectedLayout.id);
      assert.equal(await editor.getByLabel("Layout title", {exact: true}).inputValue(), title);
      assert.equal(await editor.locator(".print-stage svg image").count(), 0,
        "Fresh Print hosts must not retain private map pixels");
      const initial = await layoutFromStage(editor);
      assert.deepEqual(initial.layout, expectedLayout);
      await checkpoint({phase: "fresh-print-host-opened", freshReopened: true, reopenedCaptureCount: 0});
      await capture(reopened, "main", "after-reopen");
      await capture(reopened, "inset", "after-reopen");
      const captured = await layoutFromStage(editor);
      assertLayoutSettings(captured.layout, expectedLayout);
      assert.equal(captured.captures.length, 2);
      assert.ok(captured.captures.every(item => item.projectId === mapId && item.projectVersion === savedMap.version));
      await reopened.screenshot({path: join(work, "print-reopened-layout.png"), fullPage: true});
      await checkpoint({phase: "download-reopened-svg", reopenedCaptures: captured.captures,
        outputAttempted: true, outputPath: svgPath});
      const [downloaded] = await Promise.all([
        reopened.waitForEvent("download"),
        editor.getByRole("button", {name: "Download paper SVG", exact: true}).click()
      ]);
      await downloaded.saveAs(svgPath);
      const bytes = readFileSync(svgPath);
      await checkpoint({phase: "svg-downloaded", output: {path: svgPath, bytes: bytes.length, sha256: digest(bytes)}});
    } else {
      assert.equal(printProgress.freshReopened, true);
      assert.ok(existsSync(svgPath), "An SVG download was attempted but no complete file is retained; stop without redownloading");
    }
    const svgBytes = readFileSync(svgPath);
    assert.ok(svgBytes.length > 0 && svgBytes.length <= 24 * 1024 * 1024);
    if (printProgress.output) {
      assert.equal(printProgress.output.bytes, svgBytes.length);
      assert.equal(printProgress.output.sha256, digest(svgBytes));
    } else {
      await checkpoint({phase: "retained-svg-readback", output: {path: svgPath, bytes: svgBytes.length, sha256: digest(svgBytes)}});
    }
    const inspection = await inspectPrintSvg(reopened ?? page, svgBytes.toString("utf8"));
    assertPrintOutput(inspection, {savedMap, printProgress, seedProgress});
    assert.deepEqual(await readApi(mapPath), savedMap,
      "Reopening, recapturing and exporting must not change the saved map");
    assert.deepEqual(proof.browserErrors, []);
    Object.assign(proof, {status: "passed", frames: 2, independentViews: true, freshReopened: true,
      reopenedCaptureCount: 0, outputAfterFreshReopen: true, layoutSaves: 1,
      captureAttempts: printProgress.captureAttempts, captures: printProgress.captures,
      output: {...printProgress.output, inspection},
      visualLimitations: ["Map frames contain raster viewport captures with aspect-ratio letterboxing; higher page DPI does not add map detail.",
        "Synthetic source notes are copied explicitly from the retained fixture metadata into the layout caption; canonical data and metadata are unchanged."]});
    writeProof();
    await checkpoint({status: "passed", phase: "complete", outputVerified: true, reportPath: proofPath});
    return {...proof, savedMap};
  } catch (error) {
    Object.assign(proof, {status: "failed-stop", phase: printProgress.phase,
      saveAttempted: printProgress.saveAttempted === true, saveConfirmed: printProgress.saveConfirmed === true,
      layoutId: printProgress.layoutId, output: printProgress.output,
      error: {name: error.name, message: error.message}});
    writeProof();
    await checkpoint({status: "failed-stop", failedPhase: printProgress.phase,
      error: {name: error.name, message: error.message}, reportPath: proofPath});
    throw error;
  } finally {
    await reopened?.close();
  }

  async function capture(target, frameId, phase) {
    const editor = target.locator(".project-print-editor");
    await editor.getByLabel("Map frame", {exact: true}).selectOption(frameId);
    await editor.getByRole("button", {name: "Edit selected map frame", exact: true}).click();
    await checkpoint({phase: `${phase}-ready-${frameId}`});
    const rendered = await renderedFrame(target, seedProgress.map.definition.layers[0], seedProgress.fixture.featureNames, true);
    assert.ok((printProgress.captureAttempts ?? 0) < 6, "The cumulative six-capture ceiling is exhausted");
    await checkpoint({phase: `${phase}-capture-${frameId}`, captureAttempts: (printProgress.captureAttempts ?? 0) + 1});
    await editor.getByRole("button", {name: "Capture map frame", exact: true}).click();
    await editor.locator(':scope > [role="status"]').filter({hasText: /^Captured /}).waitFor();
    await checkpoint({captures: (printProgress.captures ?? 0) + 1,
      lastRenderedFrame: {phase, frameId, ...rendered}});
  }
}

// A separate, finite increment in the same retained runner. Historic Print
// checkpoints/counters remain untouched; committed saves are reconciled by GET.
async function exerciseDevelopmentTemplatePrint({page, context, origin, work, organization,
  readApi, seedProgress, printProgress, checkpointPrint}) {
  const baseline = printProgress.baselineMap ?? seedProgress.map;
  const accepted = JSON.parse(readFileSync(join(work, "print-smoke.json")));
  assert.equal(accepted.outputVerified, true);
  assert.deepEqual(baseline, accepted.savedMap);
  assert.equal(baseline.version, 3);
  const projectId = seedProgress.project, mapId = baseline.id;
  assert.equal(baseline.project_id, projectId);
  const collection = baseline.definition.extensions[extension];
  assert.equal(collection.layouts.length, 1);
  assert.equal(collection.templates, undefined);
  const original = collection.layouts[0], layer = baseline.definition.layers[0];
  assertLayout(original, layer);
  const title = "Community facilities · reusable print sheet";
  const mapPath = `/projects/${projectId}/maps/${mapId}`;
  const svgPath = join(work, "print-template-reopened-layout.svg");
  const proofPath = join(work, "print-template-browser-proof.json");
  const checkpoint = async update => {Object.assign(printProgress, update);await checkpointPrint(update);};
  const proof = {mode: "retained-development-print-template", projectId, mapId,
    scope: "Named source-free template, new bound layout, real local API/SQL save and compiled reopened output.",
    notProven: ["Production authentication/delivery", "Independent human acceptance", "Full cartographic parity"], browserErrors: []};
  const writeProof = () => writeFileSync(proofPath, JSON.stringify(proof, null, 2) + "\n");
  let reopened;
  try {
    assert.equal(new URL(origin).hostname, "127.0.0.1");
    assert.equal(seedProgress.styledSaved, true);
    assert.equal(seedProgress.reopened, true);
    await checkpoint({mode: "named-template-output", baselineMap: baseline, projectId, mapId, title,
      priorAcceptance: {coreApiRequestAttempts: seedProgress.apiRequestAttempts,
        coreActiveMilliseconds: seedProgress.activeMilliseconds,
        printApiRequestAttempts: accepted.apiRequestAttempts, printActiveMilliseconds: accepted.activeMilliseconds},
      phase: "read-current-map"});
    let savedMap = await readApi(mapPath);
    if (printProgress.saveAttempted) {
      assert.equal(printProgress.expectedVersion, 3);
      assert.ok(printProgress.preparedCollection, "Uncertain template saves require the exact checkpointed PATCH collection");
      assertTemplateCommitted(savedMap, baseline, printProgress);
      await checkpoint({phase: "save-reconciled-by-readback", saveConfirmed: true, savedMap,
        savedVersion: savedMap.version, committedWriteReplayed: false});
    } else {
      assert.deepEqual(savedMap, baseline, "The accepted revision-3 head must be unchanged before template editing");
      assert.equal(existsSync(svgPath), false, "Retained output must be inspected, never overwritten");
      await page.goto(`${origin}/workspaces?composition=${mapId}&manage=print`);
      const editor = page.locator(".project-print-editor");await editor.waitFor();
      await editor.getByLabel("Layout", {exact: true}).selectOption(original.id);
      assert.deepEqual((await layoutFromStage(editor)).layout, original);
      assert.equal(await editor.locator(".print-stage svg image").count(), 0);
      await editor.locator(".print-templates > summary").click();
      await editor.getByLabel("Template name", {exact: true}).fill(title);
      await editor.getByLabel("Template name", {exact: true}).blur();
      await editor.getByRole("button", {name: "Save layout as template", exact: true}).click();
      const templateId = await editor.getByLabel("Print template", {exact: true}).inputValue();
      assert.ok(templateId);
      await editor.getByRole("button", {name: "Create layout from template", exact: true}).click();
      const layoutId = await editor.getByLabel("Layout", {exact: true}).inputValue();
      assert.notEqual(layoutId, original.id);
      const prepared = await layoutFromStage(editor);
      assert.equal(prepared.layout.id, layoutId);
      assert.equal(prepared.layout.title, title);
      assert.equal(prepared.captures.every(item => item.captured === false), true);
      assert.equal(await editor.locator(".print-stage svg image").count(), 0);
      assertTemplateLayout(prepared.layout, original, baseline);
      await checkpoint({phase: "save-template-layout", templateId, layoutId, expectedVersion: 3,
        preparedLayout: prepared.layout, preparedTemplate: expectedSourceFreeTemplate(original, templateId, title), saveAttempted: true});
      const [response] = await Promise.all([
        page.waitForResponse(response => response.request().method() === "PATCH"
          && new URL(response.url()).pathname === `/api${mapPath}`),
        editor.getByRole("button", {name: "Save layout", exact: true}).click()
      ]);
      assert.equal(response.status(), 200, "Read back an uncertain commit; never repeat the template PATCH");
      await editor.locator(':scope > [role="status"]').filter({hasText: /Layout saved in Project revision 4/}).waitFor();
      savedMap = await readApi(mapPath);
      assertTemplateCommitted(savedMap, baseline, printProgress);
      await checkpoint({phase: "save-confirmed", saveConfirmed: true, savedMap, savedVersion: 4});
    }
    const expectedLayout = savedMap.definition.extensions[extension].layouts.find(item => item.id === printProgress.layoutId);
    Object.assign(proof, {layoutId: expectedLayout.id, templateId: printProgress.templateId,
      expectedVersion: 3, savedVersion: 4, canonicalDefinitionPreserved: true, originalLayoutPreserved: true});
    if (!printProgress.outputAttempted) {
      assert.equal(printProgress.captures ?? 0, 0,
        "A lost partially captured host cannot replay successful captures within this two-capture increment");
      reopened = await context.newPage();reopened.setDefaultTimeout(15_000);
      reopened.on("pageerror", error => proof.browserErrors.push(error.message));
      await reopened.addInitScript(initializeIntegratedStudioSession, {organization, origin, actor: "owner"});
      await checkpoint({phase: "fresh-template-host"});
      await reopened.goto(`${origin}/workspaces?composition=${mapId}&manage=print`);
      const editor = reopened.locator(".project-print-editor");await editor.waitFor();
      await editor.getByLabel("Layout", {exact: true}).selectOption(expectedLayout.id);
      assert.deepEqual((await layoutFromStage(editor)).layout, expectedLayout);
      assert.equal(await editor.locator(".print-stage svg image").count(), 0);
      await editor.locator(".print-templates > summary").click();
      await editor.getByLabel("Print template", {exact: true}).selectOption(printProgress.templateId);
      assert.equal(await editor.getByLabel("Template name", {exact: true}).inputValue(), title);
      assert.equal(await editor.getByLabel("Layout", {exact: true}).inputValue(), expectedLayout.id);
      const dimensions = await editor.getByLabel("Output dimensions", {exact: true}).textContent();
      assert.equal(dimensions, "297 × 210 mm; 1123 × 794 page pixels at 96 DPI");
      await checkpoint({phase: "fresh-template-host-opened", freshReopened: true, reopenedCaptureCount: 0,
        outputDimensions: dimensions, templateReopened: true});
      for (const frameId of ["main", "inset"]) {
        await editor.getByLabel("Map frame", {exact: true}).selectOption(frameId);
        await editor.getByRole("button", {name: "Edit selected map frame", exact: true}).click();
        await checkpoint({phase: `reopened-ready-${frameId}`});
        const rendered = await renderedFrame(reopened, layer, seedProgress.fixture.featureNames, true);
        assert.ok((printProgress.captureAttempts ?? 0) < 4 && (printProgress.captures ?? 0) < 2,
          "Template increment permits four capture attempts and two successful captures total");
        await checkpoint({phase: `reopened-capture-${frameId}`, captureAttempts: (printProgress.captureAttempts ?? 0) + 1});
        await editor.getByRole("button", {name: "Capture map frame", exact: true}).click();
        await editor.locator(':scope > [role="status"]').filter({hasText: /^Captured /}).waitFor();
        await checkpoint({captures: (printProgress.captures ?? 0) + 1, lastRenderedFrame: {frameId, ...rendered}});
      }
      const captured = await layoutFromStage(editor);
      assertLayoutSettings(captured.layout, expectedLayout);
      assert.equal(captured.captures.length, 2);
      assert.ok(captured.captures.every(item => item.projectId === mapId && item.projectVersion === 4));
      assert.equal(await editor.getByLabel("Captured map detail", {exact: true}).locator("li").count(), 2);
      await editor.getByLabel("Output format", {exact: true}).selectOption("svg");
      await reopened.screenshot({path: join(work, "print-template-reopened-layout.png"), fullPage: true});
      await checkpoint({phase: "download-template-svg", reopenedCaptures: captured.captures,
        outputAttempted: true, outputPath: svgPath});
      const [downloaded] = await Promise.all([reopened.waitForEvent("download"),
        editor.getByRole("button", {name: "Prepare selected output", exact: true}).click()]);
      await downloaded.saveAs(svgPath);
      const bytes = readFileSync(svgPath);
      await checkpoint({phase: "template-svg-downloaded", output: {path: svgPath, bytes: bytes.length, sha256: digest(bytes)}});
    } else {
      assert.equal(printProgress.freshReopened, true);
      assert.ok(existsSync(svgPath), "An attempted output without retained bytes must stop without redownloading");
    }
    const bytes = readFileSync(svgPath);
    assert.ok(bytes.length > 0 && bytes.length <= 24 * 1024 * 1024);
    if (printProgress.output) {
      assert.equal(bytes.length, printProgress.output.bytes);assert.equal(digest(bytes), printProgress.output.sha256);
    } else await checkpoint({output: {path: svgPath, bytes: bytes.length, sha256: digest(bytes)}});
    const inspection = await inspectPrintSvg(reopened ?? page, bytes.toString("utf8"));
    assertPrintTemplateOutput(inspection, {savedMap, printProgress, seedProgress});
    assert.deepEqual(await readApi(mapPath), savedMap, "Reopened capture/output must leave the saved revision unchanged");
    assert.deepEqual(proof.browserErrors, []);
    Object.assign(proof, {status: "passed", freshReopened: true, templateReopened: true,
      outputAfterFreshReopen: true, layoutSaves: 1, frames: 2, captureAttempts: printProgress.captureAttempts,
      captures: printProgress.captures, output: {...printProgress.output, inspection},
      visualLimitations: ["Both template frames start from the current Project camera; independent frame identities are retained.",
        "Map frames contain raster viewport captures; page DPI does not add captured map detail."]});
    writeProof();await checkpoint({status: "passed", phase: "complete", outputVerified: true, reportPath: proofPath});
    return {...proof, savedMap};
  } catch (error) {
    Object.assign(proof, {status: "failed-stop", phase: printProgress.phase,
      saveAttempted: printProgress.saveAttempted === true, saveConfirmed: printProgress.saveConfirmed === true,
      output: printProgress.output, error: {name: error.name, message: error.message}});
    writeProof();await checkpoint({status: "failed-stop", failedPhase: printProgress.phase,
      error: {name: error.name, message: error.message}, reportPath: proofPath});throw error;
  } finally {await reopened?.close();}
}

async function renderedFrame(page, layer, names, print) {
  const selector = print ? ".project-print-editor .opengeo-workbench" : ".opengeo-workbench";
  await page.waitForFunction(({selector, layerId, names, print}) => {
    const shell = document.querySelector(selector), context = shell?.getPrintContext?.();
    const map = context?.map ?? shell?.__opengeoMap;
    const layers = context?.layers ?? shell?.__opengeoLayers;
    const selected = layers?.find(item => item.layerId === layerId);
    const paint = `${layerId}-points`;
    if (!map?.isStyleLoaded() || map.areTilesLoaded() === false || map.isMoving() || !map.getLayer(paint)
      || context && (!context.ready || context.renderer !== "maplibre") || !selected) return false;
    const rendered = new Set(map.queryRenderedFeatures({layers: [paint]}).map(feature => feature.properties.name));
    const sourceFeatures = shell.__opengeoData?.get(layerId)?.features ?? [];
    const sourceNames = new Set(sourceFeatures.map(feature => feature.properties.name));
    const visible = print
      ? sourceFeatures.length === names.length && names.every(name => sourceNames.has(name))
        && names.some(name => rendered.has(name))
      : names.every(name => rendered.has(name));
    return visible && selected.style.circleColor === "#2563eb"
      && selected.opacity === 0.8 && map.getPaintProperty(paint, "circle-opacity") === 0.8;
  }, {selector, layerId: layer.layerId, names, print});
  return page.locator(selector).evaluate((shell, layerId) => {
    const context = shell.getPrintContext?.(), map = context?.map ?? shell.__opengeoMap;
    const center = map.getCenter();
    return {renderer: context?.renderer ?? "maplibre", center: [center.lng, center.lat], zoom: map.getZoom(),
      pitch: map.getPitch(), bearing: map.getBearing(),
      sourceNames: [...new Set((shell.__opengeoData?.get(layerId)?.features ?? []).map(feature => feature.properties.name))].sort(),
      renderedNames: [...new Set(map.queryRenderedFeatures({layers: [`${layerId}-points`]}).map(feature => feature.properties.name))].sort()};
  }, layer.layerId);
}

async function layoutFromStage(editor) {
  return JSON.parse(await editor.locator(".print-stage svg > metadata").textContent());
}

function withoutPrint(definition) {
  const canonical = structuredClone(definition);
  delete canonical.extensions[extension];
  return canonical;
}

function assertCommitted(map, baseline, layout) {
  assert.equal(map.id, baseline.id);
  assert.equal(map.project_id, baseline.project_id);
  assert.equal(map.version, baseline.version + 1, "Unknown/conflicting layout save: readback only; do not repeat PATCH");
  assert.deepEqual(withoutPrint(map.definition), baseline.definition);
  assert.deepEqual(map.definition.extensions[extension], {
    schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]});
  assert.doesNotMatch(JSON.stringify(map.definition.extensions[extension]), /data:image|base64|https?:|credentials|ticket|dataUrl/);
}

function assertTemplateLayout(layout, original, baseline) {
  for (const key of ["page", "dpi", "legend", "legendFormat", "northArrow", "scaleBar", "graticule", "sourceNotes", "caption"])
    assert.deepEqual(layout[key], original[key], `Template layout must preserve ${key}`);
  assert.equal(layout.frames.length, 2);
  const camera = baseline.definition.mapViews[0];
  for (const [index, frame] of layout.frames.entries()) {
    const {view: _view, presentation: _presentation, ...geometry} = original.frames[index];
    const {view, presentation, ...actualGeometry} = frame;
    assert.deepEqual(actualGeometry, geometry);
    assert.deepEqual(view, {center: camera.center, zoom: camera.zoom, pitch: camera.pitch ?? 0, bearing: camera.bearing ?? 0});
    assert.deepEqual(presentation, original.frames[0].presentation,
      "A template must bind current canonical Project presentation rather than carry another map's references");
  }
  assert.equal(layout.dataFrames, undefined);
}

function assertTemplateCommitted(map, baseline, progress) {
  assert.equal(map.id, baseline.id);assert.equal(map.project_id, baseline.project_id);
  assert.equal(map.version, 4, "Unknown/conflicting template save: GET/readback only; do not repeat PATCH");
  assert.deepEqual(withoutPrint(map.definition), withoutPrint(baseline.definition));
  const originalCollection = baseline.definition.extensions[extension], original = originalCollection.layouts[0];
  const prepared = progress.preparedCollection;
  assert.ok(prepared);
  assert.deepEqual(map.definition.extensions[extension], prepared);
  assert.equal(prepared.templates.length, 1);
  const template = prepared.templates[0];
  assert.equal(template.id, progress.templateId);assert.equal(template.name, progress.title);
  const expectedTemplate = expectedSourceFreeTemplate(original, progress.templateId, progress.title);
  assert.deepEqual(progress.preparedTemplate, expectedTemplate);
  assert.deepEqual(template, expectedTemplate, "Template persistence must contain source-free geometry and configuration only");
  assertTemplateLayout(progress.preparedLayout, original, baseline);
  assert.deepEqual(prepared, {...originalCollection,
    layouts: [original, progress.preparedLayout], templates: [expectedTemplate]});
  assert.equal(progress.preparedLayout.id, progress.layoutId);
  assert.equal(progress.preparedLayout.title, progress.title);
  assert.doesNotMatch(JSON.stringify(prepared), /data:image|base64|https?:|credentials|ticket|dataUrl/);
}

function expectedSourceFreeTemplate(original, id, name) {
  const expectedTemplate = {schemaVersion: "opengeo.print-template.1", id, name};
  for (const key of ["page", "dpi", "legend", "northArrow", "scaleBar", "graticule", "sourceNotes", "caption"])
    expectedTemplate[key] = structuredClone(original[key]);
  if (Object.hasOwn(original, "legendFormat")) expectedTemplate.legendFormat = original.legendFormat;
  expectedTemplate.frames = original.frames.map(({view: _view, presentation: _presentation, ...geometry}) => geometry);
  return expectedTemplate;
}

function assertLayout(layout, layer) {
  assert.equal(layout.page.size, "A4");
  assert.equal(layout.page.orientation, "landscape");
  assert.equal(layout.page.widthMm, 297);
  assert.equal(layout.page.heightMm, 210);
  assert.equal(layout.legend, true);
  assert.equal(layout.sourceNotes, true);
  assert.equal(layout.frames.length, 2);
  assert.equal(layout.frames[0].id, "main");
  assert.equal(layout.frames[0].parentId, null);
  assert.equal(layout.frames[1].id, "inset");
  assert.equal(layout.frames[1].parentId, "main");
  assert.notEqual(layout.frames[0].view.zoom, layout.frames[1].view.zoom);
  for (const frame of layout.frames) {
    assert.equal(frame.presentation.length, 1);
    assert.equal(frame.presentation[0].layerId, layer.layerId);
    assert.equal(frame.presentation[0].datasetId, layer.datasetId);
    assert.equal(frame.presentation[0].datasetVersionId, layer.datasetVersionId);
    assert.equal(frame.presentation[0].sourceVersion, layer.sourceVersion);
    assert.equal(frame.presentation[0].style.circleColor, "#2563eb");
    assert.equal(frame.presentation[0].opacity, 0.8);
  }
}

function assertLayoutSettings(actual, expected) {
  // MapLibre can round-trip longitude through its transform. All other settings
  // remain exact; disclose the sub-pixel camera comparison in the inspection.
  const normalized = structuredClone(actual);
  assert.equal(normalized.frames.length, expected.frames.length);
  for (const [index, frame] of normalized.frames.entries()) {
    const wanted = expected.frames[index].view;
    for (const [value, target] of [[frame.view.center[0], wanted.center[0]], [frame.view.center[1], wanted.center[1]],
      [frame.view.zoom, wanted.zoom], [frame.view.pitch, wanted.pitch], [frame.view.bearing, wanted.bearing]]) {
      assert.ok(Math.abs(value - target) <= 1e-7, "Reopened frame camera changed beyond floating-point tolerance");
    }
    frame.view = structuredClone(wanted);
  }
  assert.deepEqual(normalized, expected);
}

export function assertPrintOutput(inspection, {savedMap, printProgress, seedProgress}) {
  const baseline = printProgress.baselineMap;
  assertCommitted(savedMap, baseline, printProgress.preparedLayout);
  const expectedLayout = savedMap.definition.extensions[extension].layouts[0];
  assertInspectedPrintOutput(inspection, {savedMap, printProgress, seedProgress, expectedLayout});
}

export function assertPrintTemplateOutput(inspection, {savedMap, printProgress, seedProgress}) {
  assertTemplateCommitted(savedMap, printProgress.baselineMap, printProgress);
  const expectedLayout = savedMap.definition.extensions[extension].layouts.find(item => item.id === printProgress.layoutId);
  assertInspectedPrintOutput(inspection, {savedMap, printProgress, seedProgress, expectedLayout});
}

function assertInspectedPrintOutput(inspection, {savedMap, printProgress, seedProgress, expectedLayout}) {
  const baseline = printProgress.baselineMap;
  const layer = baseline.definition.layers[0], metadata = seedProgress.fixture.metadata;
  assert.equal(inspection.width, "297mm");
  assert.equal(inspection.height, "210mm");
  assert.equal(inspection.viewBox, "0 0 297 210");
  assert.equal(inspection.paperBackground, "white");
  assert.equal(inspection.mapImages.length, 2);
  assert.equal(inspection.externalImages, 0);
  assert.equal(inspection.clipPaths, 2);
  assert.equal(inspection.textOutsidePage, 0);
  assert.equal(inspection.matchingBlueLegend, true);
  const visibleText = inspection.text.replace(/\s+/g, " ");
  for (const value of [printProgress.title, "Legend", layer.title, metadata.title, metadata.license, metadata.attribution,
    `Project ${savedMap.id} · revision ${savedMap.version}`])
    assert.ok(visibleText.includes(value.replace(/\s+/g, " ")), value);
  assertLayoutSettings(inspection.metadata.layout, expectedLayout);
  assert.deepEqual(inspection.metadata.captures, printProgress.reopenedCaptures);
  for (const [index, image] of inspection.mapImages.entries()) {
    const captureRecord = inspection.metadata.captures[index];
    assert.equal(image.sha256, captureRecord.imageSha256);
    assert.equal(image.width, captureRecord.width);
    assert.equal(image.height, captureRecord.height);
    assert.equal(image.clippedInsideFrame, true);
    assert.ok(image.bluePixels > 0, "Each reopened frame must contain actual blue point pixels");
  }
}

export async function inspectPrintSvg(page, text) {
  return page.evaluate(async text => {
    const document = new DOMParser().parseFromString(text, "image/svg+xml");
    if (document.querySelector("parsererror")) throw Error("The downloaded SVG is not valid XML");
    const svg = document.documentElement;
    const metadata = JSON.parse(svg.querySelector("metadata").textContent);
    const groups = [...svg.querySelectorAll("g[clip-path]")];
    const mapImages = [];
    for (const [index, group] of groups.entries()) {
      const imageNode = group.querySelector(":scope > image"), href = imageNode?.getAttribute("href");
      if (!href?.startsWith("data:image/png;base64,")) throw Error("A map frame must contain an embedded PNG");
      const bytes = Uint8Array.from(atob(href.split(",")[1]), value => value.charCodeAt(0));
      const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
      const image = new Image();image.src = href;await image.decode();
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = image.naturalWidth;canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d");context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let bluePixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (pixels[offset + 2] > 180 && pixels[offset + 2] > pixels[offset] + 50
          && pixels[offset + 2] > pixels[offset + 1] + 40 && pixels[offset + 3] > 100) bluePixels++;
      }
      const id = group.getAttribute("clip-path").match(/^url\(#([^)]+)\)$/)?.[1];
      const clip = [...svg.querySelectorAll("clipPath")].find(item => item.id === id)?.querySelector("rect");
      const bounds = node => ["x", "y", "width", "height"].map(name => Number(node?.getAttribute(name)));
      const [x, y, width, height] = bounds(imageNode), clipping = bounds(clip), frame = metadata.layout.frames[index];
      const clippedInsideFrame = Boolean(clip) && clipping.every((value, i) => Math.abs(value - [x, y, width, height][i]) < 1e-7)
        && x >= frame.xMm - 1e-7 && y >= frame.yMm - 1e-7
        && x + width <= frame.xMm + frame.widthMm + 1e-7 && y + height <= frame.yMm + frame.heightMm + 1e-7;
      mapImages.push({sha256, width: image.naturalWidth, height: image.naturalHeight, bluePixels, clippedInsideFrame});
    }
    const textNodes = [...svg.querySelectorAll("text")];
    // Measure rendered text in paper coordinates. Local coordinates can be
    // negative inside translated/rotated groups, as for a north-arrow label.
    const host = globalThis.document.createElement("div");
    host.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden";
    globalThis.document.body.append(host);
    host.append(svg);
    let textBounds;
    try {
      const paperMatrix = svg.getScreenCTM().inverse();
      textBounds = textNodes.map(node => {
        const {x, y, width, height} = node.getBBox();
        const matrix = paperMatrix.multiply(node.getScreenCTM());
        const points = [[x,y],[x+width,y],[x,y+height],[x+width,y+height]]
          .map(([x,y]) => new DOMPoint(x,y).matrixTransform(matrix));
        return {text: node.textContent, xMin: Math.min(...points.map(p => p.x)),
          xMax: Math.max(...points.map(p => p.x)), yMin: Math.min(...points.map(p => p.y)),
          yMax: Math.max(...points.map(p => p.y))};
      });
    } finally { host.remove(); }
    return {width: svg.getAttribute("width"), height: svg.getAttribute("height"), viewBox: svg.getAttribute("viewBox"),
      paperBackground: svg.querySelector(":scope > rect")?.getAttribute("fill"), metadata, mapImages,
      clipPaths: svg.querySelectorAll("clipPath").length,
      externalImages: [...svg.querySelectorAll("image")].filter(node => !node.getAttribute("href")?.startsWith("data:image/")).length,
      matchingBlueLegend: [...svg.querySelectorAll(":scope > rect")].some(node => node.getAttribute("fill") === "#2563eb"),
      text: textNodes.map(node => node.textContent).join(" "),
      textBounds, textOutsidePage: textBounds.filter(box => box.xMin < -1e-7 || box.xMax > 297 + 1e-7
        || box.yMin < -1e-7 || box.yMax > 210 + 1e-7).length,
      cameraComparisonTolerance: 1e-7};
  }, text);
}
