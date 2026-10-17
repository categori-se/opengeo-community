import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {afterEach, beforeEach, describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {ProjectPrintStudio} from "../src/components/ProjectPrintStudio.js";
import {ProjectSites} from "../src/components/ProjectSites.js";
import {ProjectWorkspacePage} from "../src/components/ProjectWorkspacePage.js";
import {FixturePlatformAdapter, FIXTURE_PROJECTS} from "../src/lib/fixturePlatform.js";
import {ProjectPrintEditor, capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {definitionWithPrintLayouts, definitionForPrintFrame, newProjectPrintLayout, printLayerPresentation, projectPrintLayouts, validateProjectPrintLayouts} from "../src/lib/printLayouts.js";
import {canonicalJson} from "../src/lib/artifactCanonicalJson.js";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  user: "20000000-0000-4000-8000-000000000001",
  project: "50000000-0000-4000-8000-000000000001"
});
const catalog = JSON.parse(
  await readFile(new URL("../src/data/catalog.json", import.meta.url), "utf8")
);

let harness;

beforeEach(() => {
  harness = installDom();
});

afterEach(() => {
  harness.restore();
  harness.dom.window.close();
  harness = null;
});

describe("publication project surfaces", () => {
  it("retains exact Project print bindings and preserves canonical data and other extensions", () => {
    const map = printProjectFixture(), layout = newProjectPrintLayout(map, "layout-one");
    const value = {schemaVersion: "opengeo.project-print-layouts.1", projectId: map.id, layouts: [layout]};
    layout.frames[0].presentation[0].style.fill = "#00aa00";
    const definition = definitionWithPrintLayouts(map, value);
    assert.deepEqual(definition.layers, map.definition.layers);assert.deepEqual(definition.extensions.kept, {answer: 42});
    const reopened = projectPrintLayouts({...map, definition});assert.equal(reopened.layouts[0].frames[0].presentation[0].style.fill, "#00aa00");
    const view = definitionForPrintFrame(map, reopened.layouts[0].frames[0]);
    assert.equal(view.layers[0].style.fill, "#00aa00");assert.equal(view.layers[0].sourceUrl, map.definition.layers[0].sourceUrl);
    assert.equal(Object.hasOwn(view.layers[0], "filter"), false);assert.equal(Object.hasOwn(view.layers[0], "styleReference"), false);
    for (const mutate of [draft => {draft.projectId = IDS.project;}, draft => {draft.layouts[0].frames[0].presentation[0].sourceVersion = 99;},
      draft => {draft.layouts[0].frames[0].presentation[0].style.url = "https://example.org/other";},
      draft => {draft.layouts[0].frames[0].presentation[0].filter = ["execute", "bad"];},
      draft => {draft.layouts[0].frames[0].presentation[0].styleReference = {styleId: "unknown"};},
      draft => {Object.assign(draft.layouts[0].page, {widthMm: 1189, heightMm: 841});draft.layouts[0].dpi = 300;},
      draft => {draft.layouts[0].frames[0].image = "data:image/png;base64,private";}]) {
      const rejected = structuredClone(value);mutate(rejected);assert.throws(() => validateProjectPrintLayouts(rejected, map));
    }
  });

  it("captures and explicitly saves/reopens main and inset layouts without changing canonical Layer styling", async () => {
    let map = printProjectFixture(), writes = 0;
    const adapter = {organizationProvider: async () => IDS.organization, updateMap: async (project, id, payload) => {
      writes++;assert.equal(project, IDS.project);assert.equal(id, map.id);assert.equal(payload.expectedVersion, map.version);
      assert.deepEqual(payload.changes.definition.layers, map.definition.layers);
      map = {...map, version: map.version + 1, definition: payload.changes.definition};return structuredClone(map);
    }};
    const makeWorkbench = frame => {
      const workbench = document.createElement("section");
      const definition = frame ? definitionForPrintFrame(map, frame) : map.definition;
      workbench.getPrintContext = () => ({layers: definition.layers, view: frame?.view ?? map.definition.mapViews[0]});return workbench;
    };
    let testCamera = null;
    const capture = async context => {
      const selected = testCamera ?? context.view;
      const view = {center: [...selected.center], zoom: selected.zoom, pitch: selected.pitch, bearing: selected.bearing};
      const presentation = context.layers.map(printLayerPresentation);
      return {...printCaptureFixture(map), view, presentation, signature: canonicalJson({view, presentation})};
    };
    const root = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: makeWorkbench(), editFrame: makeWorkbench, canSave: true, captureMap: capture});document.body.append(root);
    const click = async title => {const button = [...root.querySelectorAll("button")].find(node => node.textContent === title);assert.ok(button, title);await button.onclick();};
    assert.equal(writes, 0);assert.equal(root.hasUnsavedChanges(), false);assert.doesNotMatch(root.textContent, /Open Publishing/);
    await click("Capture map frame");await click("Add inset map");await click("Edit selected map frame");await click("Capture map frame");
    testCamera = {center: [85, 28], zoom: 8, pitch: 0, bearing: 0};await click("Capture map frame");
    await click("Undo layout change");await click("Download paper SVG");assert.match(root.textContent, /Capture every map frame/);
    const frameChoice = root.querySelector('[aria-label="Map frame"]');frameChoice.value = "inset";frameChoice.dispatchEvent(new harness.dom.window.Event("change"));
    testCamera = null;await click("Edit selected map frame");await click("Capture map frame");
    await click("Save layout");assert.equal(writes, 1);assert.equal(root.hasUnsavedChanges(), false);
    const saved = projectPrintLayouts(map);assert.equal(saved.layouts[0].frames.length, 2);
    assert.equal(saved.layouts[0].frames[1].parentId, "main");assert.notEqual(saved.layouts[0].frames[0].view.zoom, saved.layouts[0].frames[1].view.zoom);
    assert.doesNotMatch(JSON.stringify(saved), /data:image|base64|https:/);
    for (const [label, value] of [["Page width (mm)", "320"], ["Page height (mm)", "240"], ["Orientation", "portrait"]]) {
      const input = root.querySelector(`[aria-label="${label}"]`);input.value = value;input.dispatchEvent(new harness.dom.window.Event("change"));
    }
    assert.equal(root.querySelector('[aria-label="Paper size"]').value, "Custom");
    assert.equal(root.querySelector('[aria-label="Page width (mm)"]').value, "240");
    assert.equal(root.querySelector('[aria-label="Page height (mm)"]').value, "320");
    const title = root.querySelector('[aria-label="Layout title"]');title.value = "Retained layout draft";title.dispatchEvent(new harness.dom.window.Event("change"));
    adapter.updateMap = async () => {throw Object.assign(Error("conflict"), {status: 409});};await click("Save layout");
    assert.equal(root.hasUnsavedChanges(), true);assert.match(root.textContent, /Project changed/);assert.equal(root.querySelector('[aria-label="Layout title"]').value, "Retained layout draft");
    let opened;
    const reopened = ProjectPrintEditor({state: {adapter, project: {id: IDS.project}, organization: {id: IDS.organization}, selectedMap: map},
      workbench: makeWorkbench(saved.layouts[0].frames[0]), editFrame: frame => {opened = frame;return makeWorkbench(frame);}, canSave: true});document.body.append(reopened);
    assert.equal(reopened.querySelector('[aria-label="Layout title"]').value, saved.layouts[0].title);
    await [...reopened.querySelectorAll("button")].find(node => node.textContent === "Edit selected map frame").onclick();
    assert.deepEqual(opened, saved.layouts[0].frames[0]);root.dispose();reopened.dispose();
  });

  it("uses one rendered state for pixels/camera and a local scale sample at world zoom", async () => {
    const mapRecord = printProjectFixture();let render, camera = [0, 0], calls = 0;
    mapRecord.definition.layers[0].style = {circleColor: "#06b6d4"};
    mapRecord.definition.layers[0].attribution = "Original survey credit";
    mapRecord.definition.layers[0].metadata = {curated: {attribution: "Reviewed survey credit"}};
    const map = {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
      getCanvas: () => ({width: 512, height: 256, clientWidth: 128, clientHeight: 64, toDataURL: () => "data:image/png;base64,aW1hZ2U="}),
      getCenter: () => ({lng: camera[0], lat: camera[1]}), getZoom: () => -2, getPitch: () => 0, getBearing: () => 0,
      getProjection: () => ({type: "mercator"}), getBounds: () => ({toArray: () => [[-180, -80], [180, 80]]}),
      getStyle: () => ({layers: [{id: "wetland-paint", type: "circle", paint: {"circle-color": ["case", ["has", "hover"], "#fff", "#06b6d4"]}}]}),
      project: ([lng, lat]) => ({x: (lng + 180) / 360 * 128, y: (80 - lat) / 160 * 64}),
      unproject: ([x]) => ({lng: ((x / 128 * 360 + 180) % 360) - 180, lat: 0}),
      once: (_event, callback) => {render = callback;}, triggerRepaint: () => {camera = [5, 0];calls++;render();}};
    const captured = await capturePrintMap({map, renderer: "maplibre", ready: true, project: mapRecord.definition,
      layers: mapRecord.definition.layers, handles: new Map([["wetlands", {layerIds: ["wetland-paint"]}]]), basemap: {attribution: "Basemap credit"}}, mapRecord);
    assert.deepEqual(captured.view.center, [5, 0]);assert.equal(calls, 1);
    assert.ok(Math.abs(captured.metresPerPixel - 2 * Math.PI * 6371008.8 / 128) < 0.1);
    assert.match(captured.imageSha256, /^[a-f0-9]{64}$/);
    assert.equal(captured.legend[0].color, "#06b6d4");
    assert(captured.attribution.includes("Original survey credit"));assert(captured.attribution.includes("Reviewed survey credit"));
    const layout = newProjectPrintLayout(mapRecord, "layout-one");layout.graticule = true;layout.sourceNotes = false;
    const svg = printPageSvg(layout, new Map([["layout-one:main", captured]]), "layout-one");
    assert.match(svg.textContent, /Basemap credit/);assert.equal(svg.getAttribute("width"), "297mm");
    assert.ok(svg.getElementsByTagNameNS("http://www.w3.org/2000/svg", "clipPath").length);assert.ok(svg.querySelector('g[clip-path] polyline'));
    assert.equal(svg.querySelector("image").getAttribute("width"), "215");
  });

  it("keeps the legacy Print URL useful through deliberate exact-map choices", async () => {
    const map = printProjectFixture();let requests = 0;
    const studio = ProjectPrintStudio({state: {project: {id: IDS.project}, organization: {id: IDS.organization}, maps: [], sites: [],
      adapter: {organizationProvider: async () => IDS.organization, listMaps: async (id, page) => {requests++;assert.equal(id, IDS.project);assert.equal(page.limit, 50);return [map];}}}});
    document.body.append(studio);assert.equal(requests, 0);assert.doesNotMatch(studio.textContent, /Open Publishing/);
    await [...studio.querySelectorAll("button")].find(button => button.textContent === "Load map Projects").onclick();
    const link = [...studio.querySelectorAll("a")].find(node => node.textContent === map.name);
    assert.equal(new URL(link.href).searchParams.get("composition"), map.id);assert.equal(new URL(link.href).searchParams.get("manage"), "print");
    assert.equal(requests, 1);studio.dispose();
  });
  it("links a zero-map publication project to its publication workspace", async () => {
    const calls = [];
    const adapter = publicationAdapter(calls);
    const page = ProjectWorkspacePage({adapter, projectId: IDS.project});
    document.body.append(page);

    const panel = await waitFor(() => page.querySelector('[data-project-use="publication"]'));
    assert.equal(panel.querySelector("h2")?.textContent, "Publication project");
    assert.match(panel.textContent, /Open Publishing to manage its source and sites/);
    assert.doesNotMatch(panel.textContent, /workspace is below/);
    const publishing = [...panel.querySelectorAll("a")]
      .find(({textContent}) => textContent === "Open publication workspace");
    assert.ok(publishing);
    assert.equal(
      publishing.getAttribute("href"),
      `/workspaces?project=${IDS.project}&manage=publishing#project-publishing`
    );
    assert.equal(calls.includes("sites"), true);
    assert.equal(calls.includes("source-projects"), true);
  });

  it("carries an exact resource target through the project publishing route", async () => {
    const calls = [];
    const target = {
      id: "90000000-0000-4000-8000-000000000090",
      slug: "research-map",
      title: "Research map",
      kind: "map",
      versionNumber: 3
    };
    const adapter = publicationAdapter(calls);
    adapter.listResources = async () => [target];
    adapter.listSites = async () => [];
    adapter.listObservableSourceProjects = async () => [];
    adapter.createSite = async () => {};
    const page = ProjectWorkspacePage({
      adapter,
      projectId: IDS.project,
      managementTarget: "publishing",
      siteResourceTarget: {resourceId: target.id, resourceVersion: 3}
    });
    document.body.append(page);

    const notice = await waitFor(() => page.querySelector(".project-resource-handoff"));
    assert.equal(notice.dataset.state, "ready");
    assert.equal(page.querySelector("#project-sites")?.classList.contains("project-route-target"), true);
    assert.equal(page.querySelector('[aria-label="Include Research map"]').checked, true);
  });

  it("renders flat and nested print settings used by persisted site revisions", () => {
    const state = {
      organization: {id: IDS.organization},
      project: {id: IDS.project},
      adapter: {},
      sites: [
        printSite("flat", "Flat settings", {
          printPageSize: "a3",
          printOrientation: "landscape"
        }),
        printSite("nested", "Nested settings", {
          print: {pageSize: "Letter", orientation: "portrait"}
        }),
        printSite("legacy", "Legacy nested settings", {
          printSettings: {printPageSize: "legal", printOrientation: "landscape"}
        })
      ]
    };

    const studio = ProjectPrintStudio({state});
    const cards = [...studio.querySelectorAll(".project-print-card")];

    assert.equal(cards.length, 3);
    assert.match(cards[0].textContent, /a3 · landscape · 1 page/);
    assert.match(cards[1].textContent, /Letter · portrait · 1 page/);
    assert.match(cards[2].textContent, /legal · landscape · 1 page/);
  });

  it("keeps primary print links direct and page downloads within each published site", () => {
    const published = {...printSite("atlas", "Atlas", {}), activeEdition: {id: "edition-1"}};
    const draft = printSite("draft", "Draft", {});
    const paths = (...parts) => `/${parts.join("/")}`;
    const studio = ProjectPrintStudio({state: {
      organization: {id: IDS.organization},
      project: {id: IDS.project},
      sites: [published, draft],
      adapter: {
        publicSitePrintUrl: (...parts) => `${paths(...parts)}/print.pdf`,
        publicSiteUrl: paths,
        publicSitePagePngUrl: (...parts) => `${paths(...parts)}.png`
      }
    }});
    const cards = [...studio.querySelectorAll(".project-print-card")];
    const direct = [...cards[0].querySelectorAll(".project-site-actions > a")]
      .filter((link) => !link.closest(".project-site-downloads"));
    assert.deepEqual(direct.map(({textContent}) => textContent), ["Open print PDF", "Open published site"]);
    const downloads = cards[0].querySelector("details");
    assert.equal(downloads.open, false);
    assert.equal(downloads.querySelector("summary").textContent, "Downloads");
    const png = downloads.querySelector("a");
    assert.equal(png.textContent, "PNG · Home");
    assert.equal(png.getAttribute("href"), `/${IDS.organization}/${IDS.project}/atlas/home.png`);
    assert.equal(png.getAttribute("rel"), "noopener noreferrer");
    assert.equal(cards[1].querySelector("details, .project-site-actions a"), null);
  });

  it("configures the next sealed edition without conflating authoring access", async () => {
    const calls = [];
    let refreshCount = 0;
    const site = printSite("research-atlas", "Research atlas", {});
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "Research atlas",
          description: "A governed publication",
          callerRole: "owner"
        },
        adapter: {
          listSites() {},
          createSite() {},
          async configureSitePublicationDestination(projectId, siteId, update) {
            calls.push({projectId, siteId, update});
          }
        },
        sites: [site],
        resources: []
      },
      refresh: async () => { refreshCount += 1; }
    });
    document.body.append(surface);

    const details = surface.querySelector(".project-site-destination");
    details.open = true;
    const reach = details.querySelector("select");
    const path = details.querySelector('input:not([type="checkbox"])');
    const primary = details.querySelector('input[type="checkbox"]');
    reach.value = "listed";
    reach.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    path.value = "Research Atlas 2026";
    primary.checked = true;
    [...details.querySelectorAll("button")]
      .find(({textContent}) => textContent === "Save destination")
      .click();

    await waitFor(() => calls.length === 1);
    assert.deepEqual(calls[0], {
      projectId: IDS.project,
      siteId: "site-research-atlas",
      update: {
        expectedRevision: 1,
        reach: "listed",
        listedSlug: "research-atlas-2026",
        isPrimary: true
      }
    });
    assert.equal(refreshCount, 1);
    assert.match(
      details.textContent,
      /Authoring access remains private.*next sealed edition/
    );
  });

  it("imports one bounded GeoMoose layout into the governed site print editor", async () => {
    const map = {
      id: "60000000-0000-4000-8000-000000000001",
      slug: "massgis-map",
      title: "MassGIS review",
      kind: "map",
      versionNumber: 3
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "MassGIS",
          description: "Reviewed map site",
          callerRole: "owner"
        },
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: [map]
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    assert.match(surface.textContent, /Import GeoMoose print layout/);
    const layout = {
      label: "letter-landscape",
      orientation: "landscape",
      page: "letter",
      units: "in",
      elements: [
        {type: "text", size: 18, fontStyle: "bold", x: 0.5, y: 0.7, text: "{{title}}"},
        {type: "map", x: 0.5, y: 0.75, width: 10, height: 7},
        {type: "rect", x: 0.5, y: 0.75, width: 10, height: 7, strokeWidth: 0.01}
      ]
    };
    const serialized = JSON.stringify(layout);
    const file = surface.querySelector('.project-positioned-layout input[type="file"]');
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [{
        name: "letter-landscape.json",
        size: new TextEncoder().encode(serialized).byteLength,
        text: async () => serialized
      }]
    });
    file.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    await waitFor(() => /2\/3 elements retained/.test(surface.textContent));

    const advanced = [...surface.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Advanced layout JSON")
      ?.querySelector("textarea");
    const converted = JSON.parse(advanced.value);
    assert.equal(converted.schemaVersion, "opengeo.print-layout.1.1.0");
    assert.deepEqual(converted.pages[0].elements.map(({type}) => type), ["text", "map_frame"]);
    assert.equal(converted.pages[0].elements[1].resourceId, map.id);
    assert.match(surface.textContent, /1 omitted; 6 declared differences/);
    const pageSize = [...surface.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Print page size")
      ?.querySelector("select");
    assert.equal(pageSize.value, "letter");
  });

  it("edits a draft without silently advancing pinned pages and saves navigation order", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const {projectId} = FIXTURE_PROJECTS[0];
    const source = (await adapter.listResources(projectId))[0];
    const supporting = await adapter.createResource(projectId, {
      kind: "document",
      slug: "supporting-evidence",
      visibility: "organization",
      metadata: {
        title: "Supporting evidence",
        abstract: "Methods and supporting material",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "OpenGeo fixture research team",
        keywords: ["evidence"],
        spatialExtent: null,
        profile: "opengeo.core.v1",
        extensions: {},
        translations: {}
      },
      content: {
        blocks: [{id: "methods", type: "markdown", markdown: "# Methods"}]
      },
      provenance: {source: "studio_native_resource"}
    });
    const created = await adapter.createSite(projectId, {
      slug: "editable-research-site",
      title: "Editable research site",
      description: "Draft before review",
      language: "en",
      theme: "paper",
      themeOptions: {
        accentColor: "#176b87",
        printPageSize: "a4",
        printOrientation: "landscape",
        printLayout: "flow",
        printLegend: "true",
        printNorthArrow: "true",
        printScaleBar: "true"
      },
      printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
      pages: [
        {
          slug: source.slug,
          navigationLabel: "Overview",
          resourceId: source.id,
          resourceVersion: source.versionNumber,
          isHome: true
        },
        {
          slug: supporting.slug,
          navigationLabel: "Evidence",
          resourceId: supporting.id,
          resourceVersion: supporting.versionNumber,
          isHome: false
        }
      ]
    });
    const advancedContent = structuredClone(source.content);
    advancedContent.blocks[0].markdown = `${advancedContent.blocks[0].markdown}\n\nNewer resource content.`;
    const advanced = await adapter.updateResource(projectId, source.id, {
      expectedVersion: source.versionNumber,
      visibility: source.visibility,
      metadata: {
        title: source.title,
        abstract: `${source.abstract} Updated independently.`,
        language: source.language,
        license: source.license,
        attribution: source.attribution,
        keywords: source.keywords,
        spatialExtent: source.spatialExtent,
        temporalStart: source.temporalStart,
        temporalEnd: source.temporalEnd,
        profile: source.metadataProfile,
        extensions: source.metadataExtensions,
        translations: source.translations
      },
      content: advancedContent,
      provenance: source.provenance,
      changeMessage: "Advance the resource independently of the draft site"
    });
    assert.equal(advanced.versionNumber, source.versionNumber + 1);

    let surface;
    const state = async () => ({
      organization: await adapter.getCurrentOrganization(),
      project: await adapter.getProject(projectId),
      adapter,
      sites: await adapter.listSites(projectId),
      resources: await adapter.listResources(projectId)
    });
    const refresh = async () => {
      const replacement = ProjectSites({state: await state(), refresh});
      surface.replaceWith(replacement);
      surface = replacement;
    };
    surface = ProjectSites({state: await state(), refresh});
    document.body.append(surface);

    const editor = surface.querySelector(".project-site-revision-editor");
    editor.open = true;
    const pinned = editor.querySelector(`[aria-label="${source.title} resource version"]`);
    assert.equal(pinned.value, String(source.versionNumber));
    assert.deepEqual(
      [...pinned.options].map(({textContent}) => textContent),
      [`Pinned v${source.versionNumber}`, `Current v${advanced.versionNumber}`]
    );
    const title = [...editor.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.textContent === "Site title")
      .querySelector("input");
    title.value = "Reviewed research atlas";
    editor.querySelector('[aria-label="Supporting evidence navigation label"]').value = "Methods";
    editor.querySelector('[aria-label="Move Supporting evidence earlier"]').click();
    findButton(editor, "Save draft revision").click();

    await waitFor(() => surface.textContent.includes("Reviewed research atlas · editable-research-site")
      || surface.querySelector("[data-revision-error]"));
    assert.equal(surface.querySelector("[data-revision-error]")?.dataset.revisionError, undefined,
      surface.textContent);
    const updated = await adapter.getSite(projectId, created.id);
    assert.equal(updated.versionNumber, 2);
    assert.equal(updated.title, "Reviewed research atlas");
    assert.deepEqual(updated.pages.map(({navigationLabel}) => navigationLabel), ["Methods", "Overview"]);
    assert.equal(updated.pages[1].resourceVersionNumber, source.versionNumber);
    assert.equal(updated.pages[1].isHome, true);
    assert.deepEqual(updated.pages[1].content, source.content);
    assert.notDeepEqual(updated.pages[1].content, advanced.content);
  });

  it("executes the fixture site journey through create, review, publish, and revoke controls", async () => {
    const adapter = new FixturePlatformAdapter(catalog);
    const {projectId} = FIXTURE_PROJECTS[0];
    const resource = (await adapter.listResources(projectId))[0];
    await adapter.transitionResource(projectId, resource.id, {
      expectedVersion: resource.versionNumber,
      targetState: "published",
      visibility: "public",
      reason: "Approve the fixture publication page"
    });

    let surface;
    const state = async () => ({
      organization: await adapter.getCurrentOrganization(),
      project: await adapter.getProject(projectId),
      adapter,
      sites: await adapter.listSites(projectId),
      resources: await adapter.listResources(projectId)
    });
    const refresh = async () => {
      const replacement = ProjectSites({state: await state(), refresh});
      surface.replaceWith(replacement);
      surface = replacement;
    };
    surface = ProjectSites({state: await state(), refresh});
    document.body.append(surface);

    findButton(surface, "Create draft site").click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="draft"]')
      ?? [...surface.querySelectorAll(".project-resource-feedback")].find(
        ({textContent}) => textContent.includes("failed safely")
      ));
    assert.ok(
      surface.querySelector('.project-site-card[data-state="draft"]'),
      surface.textContent
    );
    assert.doesNotMatch(surface.textContent, /unavailable in this fixture adapter/);

    const collaborators = surface.querySelector(".project-site-collaborators");
    collaborators.open = true;
    collaborators.querySelector('[aria-label="Collaborator email"]').value = "reviewer@example.test";
    collaborators.querySelector('[aria-label="Collaborator display name"]').value = "Publication Reviewer";
    collaborators.querySelector('[aria-label="Collaborator account access"]').value = "member";
    collaborators.querySelector('[aria-label="Collaborator project role"]').value = "reviewer";
    collaborators.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );
    await waitFor(() => collaborators.dataset.state === "pending");
    const invitation = (await adapter.listInvitations()).find(
      ({email}) => email === "reviewer@example.test"
    );
    assert.equal(invitation.projectId, projectId);
    assert.equal(invitation.projectRole, "reviewer");

    let destination = surface.querySelector(".project-site-destination");
    destination.open = true;
    const reach = destination.querySelector("select");
    const path = destination.querySelector('input:not([type="checkbox"])');
    const primary = destination.querySelector('input[type="checkbox"]');
    reach.value = "listed";
    reach.dispatchEvent(new harness.dom.window.Event("change", {bubbles: true}));
    path.value = "nepal-energy-fixture";
    primary.checked = true;
    findButton(destination, "Save destination").click();
    await waitFor(() => /Listed · account primary root/.test(surface.textContent));

    findButton(surface, "Submit revision for review").click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="review"]'));
    const publish = findButton(surface, "Publish reviewed edition");
    assert.equal(publish.disabled, false);
    publish.click();
    await waitFor(() => surface.querySelector('.project-site-card[data-state="published"]'));
    assert.match(surface.textContent, /memory-only fixture records this sealed edition/);
    assert.equal(findButton(surface, "Download portable ZIP"), null);

    findButton(surface, "Revoke public edition").click();
    await waitFor(() => !surface.textContent.includes("Revoke public edition"));
    const sites = await adapter.listSites(projectId);
    const editions = await adapter.listSiteEditions(projectId, sites[0].id);
    assert.equal(sites[0].activeEdition, null);
    assert.ok(editions[0].revokedAt);
  });

  it("shows editors a reviewer handoff instead of an unauthorized publish action", () => {
    const site = printSite("reviewed-site", "Reviewed site", {});
    site.state = "review";
    site.pages[0].resourceKind = "document";
    site.pages[0].resourceVersionNumber = 1;
    site.pages[0].resourceState = "published";
    site.pages[0].resourceVisibility = "public";
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Review", callerRole: "editor"},
        adapter: {listSites() {}, createSite() {}},
        sites: [site],
        resources: []
      },
      refresh: async () => {}
    });

    assert.match(surface.textContent, /awaiting a project owner or reviewer/);
    assert.equal(findButton(surface, "Publish reviewed edition"), null);
  });

  it("pins a targeted resource into a new site draft only after explicit creation", async () => {
    const target = {
      id: "90000000-0000-4000-8000-000000000091",
      slug: "field-observations-map",
      title: "Field observations map",
      kind: "map",
      versionNumber: 4
    };
    const other = {
      id: "90000000-0000-4000-8000-000000000092",
      slug: "project-overview",
      title: "Project overview",
      kind: "document",
      versionNumber: 2
    };
    const creations = [];
    let refreshCount = 0;
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {
          id: IDS.project,
          name: "Field atlas",
          description: "A governed spatial publication",
          callerRole: "owner"
        },
        adapter: {
          listSites() {},
          async createSite(projectId, draft) { creations.push({projectId, draft}); }
        },
        sites: [],
        resources: [other, target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 4},
      refresh: async () => { refreshCount += 1; }
    });
    document.body.append(surface);

    assert.equal(creations.length, 0);
    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "ready");
    assert.match(surface.textContent, /Field observations map v4 is selected/);
    assert.equal(surface.querySelector('[aria-label="Include Field observations map"]').checked, true);
    assert.equal(surface.querySelector('[aria-label="Include Project overview"]').checked, false);
    assert.equal(findButton(surface, "Create draft site").disabled, false);

    findButton(surface, "Create draft site").click();
    await waitFor(() => creations.length === 1);
    assert.equal(refreshCount, 1);
    assert.deepEqual(creations[0].draft.pages, [{
      slug: target.slug,
      navigationLabel: target.title,
      resourceId: target.id,
      resourceVersion: 4,
      isHome: true
    }]);
  });

  it("prepares one explicitly selected existing draft without mutating another draft", async () => {
    const updates = [];
    const home = {
      id: "90000000-0000-4000-8000-000000000096",
      slug: "home",
      title: "Project home",
      abstract: "Home page",
      kind: "document",
      versionNumber: 1
    };
    const target = {
      id: "90000000-0000-4000-8000-000000000097",
      slug: "field-map",
      title: "Field map",
      abstract: "Exact reviewed map",
      kind: "map",
      versionNumber: 3
    };
    const alpha = draftSite(
      "70000000-0000-4000-8000-000000000096",
      "Alpha report",
      home
    );
    const beta = draftSite(
      "70000000-0000-4000-8000-000000000097",
      "Beta report",
      home
    );
    const published = draftSite(
      "70000000-0000-4000-8000-000000000099",
      "Published report",
      home
    );
    published.state = "published";
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          async updateSite(projectId, siteId, update) {
            updates.push({projectId, siteId, update});
          }
        },
        sites: [alpha, beta, published],
        resources: [home, target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 3},
      refresh: async () => {}
    });
    document.body.append(surface);
    const notice = surface.querySelector(".project-resource-handoff");
    const destination = notice.querySelector('[aria-label="Resource site destination"]');
    assert.deepEqual([...destination.options].map(({value}) => value), [
      "new",
      alpha.id,
      beta.id
    ]);
    destination.value = alpha.id;
    findButton(notice, "Prepare destination").click();

    const newEditor = surface.querySelector('[data-site-destination="new"]');
    const alphaEditor = surface.querySelector(`[data-site-destination="${alpha.id}"]`);
    const betaEditor = surface.querySelector(`[data-site-destination="${beta.id}"]`);
    assert.equal(resourceInclude(newEditor, target.id).checked, false);
    assert.equal(resourceInclude(alphaEditor, target.id).checked, true);
    assert.equal(resourceInclude(betaEditor, target.id).checked, false);
    assert.equal(alphaEditor.open, true);
    assert.equal(betaEditor.open, false);
    assert.equal(updates.length, 0, "preparing a form must not create a revision");
    assert.match(notice.textContent, /selected only in Alpha report/);

    findButton(alphaEditor, "Save draft revision").click();
    await waitFor(() => updates.length === 1);
    assert.equal(updates[0].projectId, IDS.project);
    assert.equal(updates[0].siteId, alpha.id);
    assert.equal(updates[0].update.expectedVersion, 1);
    assert.deepEqual(
      updates[0].update.pages.map(({resourceId, resourceVersion}) => ({
        resourceId,
        resourceVersion
      })),
      [
        {resourceId: home.id, resourceVersion: 1},
        {resourceId: target.id, resourceVersion: 3}
      ]
    );
  });

  it("preserves an existing page pin when the targeted resource is already in the draft", () => {
    const target = {
      id: "90000000-0000-4000-8000-000000000098",
      slug: "current-map",
      title: "Current map",
      abstract: "Current map revision",
      kind: "map",
      versionNumber: 3
    };
    const site = draftSite(
      "70000000-0000-4000-8000-000000000098",
      "Pinned report",
      target,
      {pinnedVersion: 2}
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}, updateSite() {}},
        sites: [site],
        resources: [target]
      },
      initialResourceTarget: {resourceId: target.id, resourceVersion: 3},
      refresh: async () => {}
    });
    document.body.append(surface);
    const notice = surface.querySelector(".project-resource-handoff");
    const destination = notice.querySelector('[aria-label="Resource site destination"]');
    destination.value = site.id;
    findButton(notice, "Prepare destination").click();

    const editor = surface.querySelector(`[data-site-destination="${site.id}"]`);
    assert.equal(editor.querySelector('[aria-label="Current map resource version"]').value, "2");
    assert.match(notice.textContent, /already in this draft.*pinned version was preserved/);
  });

  it("does not substitute another page for a stale resource-to-site handoff", () => {
    const resource = {
      id: "90000000-0000-4000-8000-000000000093",
      slug: "current-map",
      title: "Current map",
      kind: "map",
      versionNumber: 5
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: [resource]
      },
      initialResourceTarget: {resourceId: resource.id, resourceVersion: 4},
      refresh: async () => {}
    });

    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "stale");
    assert.match(surface.textContent, /requested v4 was not selected/);
    assert.equal(surface.querySelector('[aria-label="Include Current map"]').checked, false);
    assert.equal(findButton(surface, "Create draft site").disabled, true);
    assert.equal(surface.querySelector('[aria-label="Resource site destination"]'), null);
  });

  it("keeps a resource-to-site handoff read-only for a project viewer", () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "viewer"},
        adapter: {listSites() {}, createSite() {}},
        sites: [],
        resources: []
      },
      initialResourceTarget: {
        resourceId: "90000000-0000-4000-8000-000000000094",
        resourceVersion: 1
      },
      refresh: async () => {}
    });

    assert.equal(surface.querySelector(".project-resource-handoff")?.dataset.state, "view_only");
    assert.match(surface.textContent, /current project role cannot create or revise a site/);
    assert.equal(surface.querySelector(".project-site-editor"), null);
    assert.equal(surface.querySelector('[aria-label="Resource site destination"]'), null);
  });

  it("creates one exact project-scoped collaborator invitation for an administrator", async () => {
    const invitations = [];
    const adapter = {
      listSites() {},
      createSite() {},
      async createInvitation(draft) {
        invitations.push(draft);
        return {
          id: "70000000-0000-4000-8000-000000000095",
          email: draft.email,
          displayName: draft.displayName,
          organizationRole: draft.organizationRole,
          projectId: draft.projectId,
          projectRole: draft.projectRole,
          status: "pending"
        };
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    panel.open = true;
    assert.deepEqual(
      [...panel.querySelector('[aria-label="Collaborator account access"]').options]
        .map(({value}) => value),
      ["member", "guest"]
    );
    assert.deepEqual(
      [...panel.querySelector('[aria-label="Collaborator project role"]').options]
        .map(({value}) => value),
      ["viewer", "reviewer", "editor"]
    );
    panel.querySelector('[aria-label="Collaborator email"]').value = " New.Editor@Example.test ";
    panel.querySelector('[aria-label="Collaborator display name"]').value = "New Editor";
    panel.querySelector('[aria-label="Collaborator account access"]').value = "member";
    panel.querySelector('[aria-label="Collaborator project role"]').value = "editor";
    panel.querySelector('[aria-label="Collaborator invitation expiry"]').value = "14";
    panel.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => invitations.length === 1);
    assert.deepEqual(invitations[0], {
      email: "new.editor@example.test",
      displayName: "New Editor",
      organizationRole: "member",
      projectId: IDS.project,
      projectRole: "editor",
      expiresInDays: 14
    });
    assert.equal(panel.dataset.state, "pending");
    assert.match(panel.textContent, /Access begins only after acceptance/);
  });

  it("reports an existing pending project invitation without claiming a duplicate", async () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          async createInvitation() {
            throw Object.assign(new Error("pending"), {code: "invitation_pending"});
          }
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    panel.querySelector('[aria-label="Collaborator email"]').value = "pending@example.test";
    panel.querySelector('[aria-label="Collaborator display name"]').value = "Pending Person";
    panel.querySelector("form").dispatchEvent(
      new harness.dom.window.Event("submit", {bubbles: true, cancelable: true})
    );

    await waitFor(() => panel.dataset.state === "error");
    assert.match(panel.textContent, /pending invitation already exists; no duplicate was created/);
    assert.equal(findButton(panel, "Create project invitation").disabled, false);
  });

  it("gives a project owner an administrator handoff instead of a doomed invitation form", () => {
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {listSites() {}, createSite() {}, createInvitation() {}},
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });

    const panel = surface.querySelector(".project-site-collaborators");
    assert.match(panel.textContent, /organization administrator must invite a new person/);
    assert.equal(panel.querySelector("form"), null);
  });

  it("lazily manages exact project roles for existing organization members", async () => {
    const owner = fixtureMember(
      "20000000-0000-4000-8000-000000000010",
      "Project Owner",
      "owner@example.test",
      "owner"
    );
    const reviewer = fixtureMember(
      "20000000-0000-4000-8000-000000000011",
      "Project Reviewer",
      "reviewer@example.test",
      "reviewer"
    );
    const candidate = fixtureMember(
      "20000000-0000-4000-8000-000000000012",
      "Existing Member",
      "member@example.test",
      "member"
    );
    const organizationMembers = [
      {...owner, role: "member"},
      {...reviewer, role: "member"},
      candidate
    ];
    const projectMembers = [owner, reviewer];
    const calls = [];
    const adapter = {
      listSites() {},
      createSite() {},
      async listOrganizationMembers(page) {
        calls.push(["list-organization", page]);
        return structuredClone(organizationMembers);
      },
      async listProjectMembers(projectId, page) {
        calls.push(["list-project", projectId, page]);
        return structuredClone(projectMembers);
      },
      async createProjectMember(projectId, userId, role) {
        calls.push(["create", projectId, userId, role]);
        const member = organizationMembers.find((entry) => entry.userId === userId);
        projectMembers.push({...member, role});
        return {userId, role};
      },
      async updateProjectMember(projectId, userId, role) {
        calls.push(["update", projectId, userId, role]);
        projectMembers.find((entry) => entry.userId === userId).role = role;
        return {userId, role};
      },
      async revokeProjectMember(projectId, userId) {
        calls.push(["revoke", projectId, userId]);
        projectMembers.splice(projectMembers.findIndex((entry) => entry.userId === userId), 1);
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    assert.equal(calls.length, 0, "Publishing must not eagerly load membership lists");
    findButton(panel, "Load current access").click();
    const addForm = await waitFor(() => panel.querySelector('[data-purpose="existing-project-member"]'));
    assert.deepEqual(
      [...addForm.querySelector('[aria-label="Existing member project role"]').options]
        .map(({value}) => value),
      ["viewer", "reviewer", "editor"]
    );
    assert.match(panel.querySelector(`[data-member-id="${owner.userId}"]`).textContent, /Ownership is managed/);
    assert.equal(findButton(panel.querySelector(`[data-member-id="${owner.userId}"]`), "Update"), null);

    addForm.querySelector('[aria-label="Existing organization member"]').value = candidate.userId;
    addForm.querySelector('[aria-label="Existing member project role"]').value = "editor";
    addForm.dispatchEvent(new harness.dom.window.Event("submit", {bubbles: true, cancelable: true}));
    await waitFor(() => calls.some(([kind]) => kind === "create"));
    assert.deepEqual(calls.find(([kind]) => kind === "create"), [
      "create",
      IDS.project,
      candidate.userId,
      "editor"
    ]);

    const reviewerRow = await waitFor(() => panel.querySelector(`[data-member-id="${reviewer.userId}"]`));
    reviewerRow.querySelector('[aria-label="Project Reviewer project role"]').value = "editor";
    findButton(reviewerRow, "Update").click();
    await waitFor(() => calls.some(([kind]) => kind === "update"));
    assert.deepEqual(calls.find(([kind]) => kind === "update"), [
      "update",
      IDS.project,
      reviewer.userId,
      "editor"
    ]);

    const candidateRow = await waitFor(() => panel.querySelector(`[data-member-id="${candidate.userId}"]`));
    findButton(candidateRow, "Remove").click();
    await waitFor(() => calls.some(([kind]) => kind === "revoke"));
    assert.deepEqual(calls.find(([kind]) => kind === "revoke"), [
      "revoke",
      IDS.project,
      candidate.userId
    ]);
  });

  it("keeps exact project invitation history and revocation in the administrator workflow", async () => {
    const exact = {
      id: "70000000-0000-4000-8000-000000000110",
      email: "pending@example.test",
      displayName: "Pending Reviewer",
      organizationRole: "member",
      projectId: IDS.project,
      projectRole: "reviewer",
      status: "pending"
    };
    const other = {...exact,
      id: "70000000-0000-4000-8000-000000000111",
      email: "other@example.test",
      projectId: "50000000-0000-4000-8000-000000000099"
    };
    const invitations = [exact, other];
    const revocations = [];
    const adapter = {
      listSites() {},
      createSite() {},
      createInvitation() {},
      listProjectMembers: async () => [],
      listOrganizationMembers: async () => [],
      listInvitations: async () => structuredClone(invitations),
      async revokeInvitation(invitationId) {
        revocations.push(invitationId);
        invitations.find(({id}) => id === invitationId).status = "revoked";
        return structuredClone(invitations.find(({id}) => id === invitationId));
      }
    };
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "admin"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter,
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-invitation-id="${exact.id}"]`));
    assert.match(row.textContent, /Pending Reviewer.*reviewer · pending/);
    assert.doesNotMatch(panel.querySelector(".project-site-invitation-history").textContent, /other@example/);
    findButton(row, "Revoke invitation").click();
    await waitFor(() => revocations.length === 1);
    assert.deepEqual(revocations, [exact.id]);
    const final = await waitFor(() => {
      const candidate = panel.querySelector(`[data-invitation-id="${exact.id}"]`);
      return candidate?.textContent.includes("revoked") ? candidate : null;
    });
    assert.match(final.textContent, /Final/);
  });

  it("shows an editor a read-only lazy project roster without organization enumeration", async () => {
    let projectReads = 0;
    let organizationReads = 0;
    const member = fixtureMember(
      "20000000-0000-4000-8000-000000000013",
      "Read Only Reviewer",
      "readonly@example.test",
      "reviewer"
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "editor"},
        adapter: {
          listSites() {},
          createSite() {},
          async listProjectMembers() {
            projectReads += 1;
            return [member];
          },
          async listOrganizationMembers() {
            organizationReads += 1;
            return [];
          }
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-member-id="${member.userId}"]`));
    assert.equal(projectReads, 1);
    assert.equal(organizationReads, 0);
    assert.match(row.textContent, /Read only/);
    assert.equal(row.querySelector("button"), null);
    assert.equal(panel.querySelector('[data-purpose="existing-project-member"]'), null);
  });

  it("reports a rejected project role change without claiming access changed", async () => {
    const reviewer = fixtureMember(
      "20000000-0000-4000-8000-000000000014",
      "Concurrent Reviewer",
      "concurrent@example.test",
      "reviewer"
    );
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Atlas", callerRole: "owner"},
        adapter: {
          listSites() {},
          createSite() {},
          listProjectMembers: async () => [reviewer],
          listOrganizationMembers: async () => [{...reviewer, role: "member"}],
          async updateProjectMember() {
            throw Object.assign(new Error("conflict"), {code: "project_membership_conflict"});
          },
          revokeProjectMember() {}
        },
        sites: [],
        resources: []
      },
      refresh: async () => {}
    });
    document.body.append(surface);
    const panel = surface.querySelector(".project-site-collaborators");
    findButton(panel, "Load current access").click();
    const row = await waitFor(() => panel.querySelector(`[data-member-id="${reviewer.userId}"]`));
    const update = findButton(row, "Update");
    update.click();
    await waitFor(() => panel.textContent.includes("project_membership_conflict"));
    assert.match(panel.textContent, /Project access was not changed/);
    assert.equal(update.disabled, false);
  });

  it("exposes API-backed public, portable, print, and revocation actions for a sealed edition", async () => {
    const calls = [];
    const site = printSite("field-atlas", "Field atlas", {});
    site.state = "published";
    site.publicationDestination = {
      ...site.publicationDestination,
      revision: 2,
      reach: "listed",
      listedSlug: "field-atlas",
      isPrimary: true
    };
    Object.assign(site.pages[0], {
      resourceId: "60000000-0000-4000-8000-000000000001",
      resourceKind: "map",
      resourceVersionNumber: 3,
      resourceState: "published",
      resourceVisibility: "public"
    });
    site.activeEdition = {
      id: "70000000-0000-4000-8000-000000000001",
      publicationReach: "listed",
      listedSlug: "field-atlas",
      unlistedToken: null,
      manifest: {
        references: [{
          resourceId: site.pages[0].resourceId,
          kind: "map",
          snapshot: {checksumSha256: "a".repeat(64)}
        }]
      }
    };
    const route = (name) => (...parts) => {
      calls.push({name, parts});
      return `/publication/${name}`;
    };
    const adapter = {
      kind: "api",
      listSites() {},
      createSite() {},
      publicSiteUrl: route("site"),
      publicSiteExportUrl: route("export"),
      publicSitePrintUrl: route("pdf"),
      publicSitePagePngUrl: route("png"),
      publicSiteMapSheetUrl: route("svg"),
      async revokeSiteEdition(projectId, siteId, editionId) {
        calls.push({name: "revoke", parts: [projectId, siteId, editionId]});
      }
    };
    let refreshCount = 0;
    const surface = ProjectSites({
      state: {
        organization: {id: IDS.organization, callerRole: "member"},
        project: {id: IDS.project, name: "Field atlas", callerRole: "owner"},
        adapter,
        sites: [site],
        resources: []
      },
      refresh: async () => { refreshCount += 1; }
    });
    const links = new Map(
      [...surface.querySelectorAll("a")].map((anchor) => [anchor.textContent, anchor])
    );

    assert.equal(links.get("Open listed site")?.getAttribute("href"), "/publication/site");
    assert.equal(links.get("Download portable ZIP")?.getAttribute("href"), "/publication/export");
    assert.equal(links.get("Download print PDF")?.getAttribute("href"), "/publication/pdf");
    assert.equal(links.get("Open whole-page PNG · Home")?.getAttribute("href"), "/publication/png");
    assert.equal(
      links.get("Open printable SVG map sheet · 60000000")?.getAttribute("href"),
      "/publication/svg"
    );
    findButton(surface, "Revoke public edition").click();
    await waitFor(() => calls.some(({name}) => name === "revoke"));
    assert.equal(refreshCount, 1);
  });
});

function findButton(root, label) {
  return [...root.querySelectorAll("button")]
    .find(({textContent}) => textContent === label) ?? null;
}

function publicationAdapter(calls) {
  const record = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  const project = {
    id: IDS.project,
    name: "Published research atlas",
    description: "Observable Framework publication without a Studio map",
    status: "active",
    visibility: "published",
    callerRole: "owner"
  };
  return {
    kind: "api",
    selectOrganization() {},
    getSession: record("session", {
      userId: IDS.user,
      displayName: "Publication owner",
      memberships: [{organizationId: IDS.organization, role: "member"}],
      selectedOrganizationId: IDS.organization
    }),
    getCurrentOrganization: record("organization", {
      id: IDS.organization,
      name: "OpenGeo.tools",
      callerRole: "member"
    }),
    listProjects: record("projects", [project]),
    getProject: record("project", project),
    listMaps: record("maps", []),
    listDatasets: record("datasets", []),
    listSources: record("sources", []),
    listSites: record("sites", [{id: "site-publication", title: "Research atlas"}]),
    listObservableSourceProjects: record("source-projects", [{
      id: "source-publication",
      name: "Research atlas source"
    }]),
    listProjectDatasetConnectionBindings: record("dataset-connections", []),
    listProjectBasemapConnectionBindings: record("basemap-connections", [])
  };
}

function printProjectFixture() {
  return {id: "70000000-0000-4000-8000-000000000001", projectId: IDS.project, name: "Regional wetland comparison", version: 3,
    definition: {schemaVersion: "opengeo.map-definition.1.3.0", projection: "mercator", spatialBody: {id: "earth"},
      extensions: {kept: {answer: 42}}, mapViews: [{center: [84, 27], zoom: 5, pitch: 0, bearing: 0}],
      layers: [{layerId: "wetlands", datasetId: "80000000-0000-4000-8000-000000000001", title: "Wetlands", sourceType: "imageserver-raster", sourceVersion: 2,
        sourceUrl: "https://example.org/ImageServer", sourceConfiguration: {}, visible: true, opacity: 1, style: {fill: "#123456"}, labels: {enabled: false}}]}};
}

function printCaptureFixture(map) {
  const view = {center: [84, 27], zoom: 5, pitch: 0, bearing: 0}, presentation = map.definition.layers.map(printLayerPresentation);
  return {dataUrl: "data:image/png;base64,aW1hZ2U=", width: 1024, height: 640, cssWidth: 512, cssHeight: 320, view, presentation,
    signature: canonicalJson({view, presentation}), legend: [{label: "Wetlands", color: "#123456"}], attribution: ["Provider credit"],
    lines: [], metresPerPixel: 100, flat: true, projectId: map.id, projectVersion: map.version, imageSha256: "a".repeat(64)};
}

function printSite(slug, title, themeOptions) {
  return {
    id: `site-${slug}`,
    slug,
    title,
    state: "draft",
    versionNumber: 1,
    themeOptions,
    pages: [{slug: "home", navigationLabel: "Home"}],
    activeEdition: null,
    publicationDestination: {
      revision: 1,
      reach: "unpublished",
      listedSlug: slug,
      isPrimary: false,
      configuredBy: IDS.user,
      configuredAt: "2026-08-30T12:00:00Z"
    }
  };
}

function draftSite(id, title, resource, {pinnedVersion = resource.versionNumber} = {}) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    id,
    slug,
    title,
    description: `${title} description`,
    language: "en",
    theme: "paper",
    state: "draft",
    versionNumber: 1,
    themeOptions: {
      accentColor: "#176b87",
      printPageSize: "a4",
      printOrientation: "landscape",
      printLayout: "flow"
    },
    printLayout: {schemaVersion: "opengeo.print-layout.1.1.0", pages: []},
    pages: [{
      slug: resource.slug,
      navigationLabel: resource.title,
      position: 0,
      isHome: true,
      resourceId: resource.id,
      resourceTitle: resource.title,
      resourceKind: resource.kind,
      resourceVersionNumber: pinnedVersion,
      resourceState: "published",
      resourceVisibility: "public"
    }],
    activeEdition: null,
    publicationDestination: {
      revision: 1,
      reach: "unpublished",
      listedSlug: slug,
      isPrimary: false,
      configuredBy: IDS.user,
      configuredAt: "2026-09-02T12:00:00Z"
    }
  };
}

function fixtureMember(userId, displayName, email, role) {
  return {userId, displayName, email, role};
}

function resourceInclude(editor, resourceId) {
  return [...editor.querySelectorAll(".project-site-page-selector")]
    .find((row) => row.dataset.resourceId === resourceId)
    .querySelector(':scope > input[type="checkbox"]');
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for publication workspace state");
}

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: `https://studio.opengeo.tools/workspaces?project=${IDS.project}`
  });
  const replacements = {
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return {
    dom,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}
