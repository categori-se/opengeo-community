# Import a GeoNode publication

Open a Project, choose **Resources**, and open **Import GeoNode package**. Paste a package identifying GeoNode 5.1.0 and import it for review. A Project owner or editor can import up to 50 resources and 200 relationships in a 256 KiB package. Importing never publishes content or copies remote data.

Supported GeoStory titles and text become editable native reading blocks. Review the conversion report: unsupported maps, media, interactive sections and formatting remain preserved in the source definition with explicit losses. Check source rights and attribution before publishing. Reimporting identical source keeps the existing resource identities and authored edits; the report distinguishes a proposed conversion from content actually committed.

Use the normal source-version editor, review and publication workflow. A supported title/text publication can be exported as a portable edition without a GeoNode or MapStore runtime.

[The authored example](../parity/fixtures/geonode/geonode-5.1-authored-publication.json) and [migration acceptance](../parity/reports/geonode-publication-acceptance.json) record the tested profile. Broader publishing/administration parity, configured production delivery, unsupported conversion shapes and scale remain open; this is not whole-GeoNode compatibility.
