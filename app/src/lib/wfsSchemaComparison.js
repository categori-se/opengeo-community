const XSD = "http://www.w3.org/2001/XMLSchema";
const GML = new Set(["http://www.opengis.net/gml", "http://www.opengis.net/gml/3.2"]);

// Interpret only a bounded, local declaration. Never resolve imports or execute XML.
export function compareWfsSchemas(before, after, collectionRef, DOMParserClass) {
  try {
    const left = declaration(before, collectionRef, DOMParserClass);
    const right = declaration(after, collectionRef, DOMParserClass);
    if (left.namespace !== right.namespace) throw Error("Collection namespace changed");
    const changes = [];
    for (const [name, field] of left.fields) {
      const next = right.fields.get(name);
      if (!next) changes.push({kind: "removed", name, before: field, after: null});
      else if (JSON.stringify(field) !== JSON.stringify(next)) changes.push({kind: "changed", name, before: field, after: next});
    }
    for (const [name, field] of right.fields) {
      if (!left.fields.has(name)) changes.push({kind: "added", name, before: null, after: field});
    }
    return {available: true, namespace: left.namespace, changes};
  } catch {
    return {available: false};
  }
}

function declaration(text, collectionRef, Parser) {
  if (typeof text !== "string" || text.length > 32768 || /<!DOCTYPE|<!ENTITY/i.test(text) || typeof Parser !== "function") throw Error("Unsupported document");
  const local = typeof collectionRef === "string" ? collectionRef.split(":").at(-1) : "";
  if (!local) throw Error("Missing collection");
  const doc = new Parser().parseFromString(text, "application/xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || root?.namespaceURI !== XSD || root.localName !== "schema") throw Error("Invalid schema");
  const namespace = root.getAttribute("targetNamespace");
  if (!namespace) throw Error("Missing namespace");
  const children = (node, name) => [...node.children].filter(n => n.namespaceURI === XSD && n.localName === name);
  const exactly = values => {if (values.length !== 1) throw Error("Ambiguous declaration"); return values[0];};
  const feature = exactly(children(root, "element").filter(n => n.getAttribute("name") === local));
  let type;
  if (feature.hasAttribute("type")) {
    const name = qualified(feature, feature.getAttribute("type"));
    if (name.namespace !== namespace) throw Error("Imported collection type");
    type = exactly(children(root, "complexType").filter(n => n.getAttribute("name") === name.local));
  } else type = exactly(children(feature, "complexType"));
  let parent = type;
  const content = children(type, "complexContent");
  if (content.length) {
    const extension = exactly(children(exactly(content), "extension"));
    const base = qualified(extension, extension.getAttribute("base"));
    if (!GML.has(base.namespace) || base.local !== "AbstractFeatureType") throw Error("Unresolved inherited fields");
    parent = extension;
  }
  const sequence = exactly(children(parent, "sequence"));
  // Choices, groups and nested/anonymous field types cannot be summarized faithfully here.
  if (children(parent, "choice").length || children(parent, "group").length) throw Error("Unsupported group");
  const fields = new Map();
  for (const node of sequence.children) {
    if (node.namespaceURI === XSD && node.localName === "annotation") continue;
    if (node.namespaceURI !== XSD || node.localName !== "element" || node.hasAttribute("ref")) throw Error("Unsupported field");
    const name = node.getAttribute("name");
    if (!name || fields.has(name) || fields.size >= 200) throw Error("Ambiguous or large schema");
    const fieldType = qualified(node, node.getAttribute("type"));
    const min = node.getAttribute("minOccurs") ?? "1";
    const max = node.getAttribute("maxOccurs") ?? "1";
    const nullable = node.getAttribute("nillable") ?? "false";
    if (!/^\d+$/.test(min) || !/^(\d+|unbounded)$/.test(max) || !["true","false","0","1"].includes(nullable)) throw Error("Invalid cardinality");
    fields.set(name, {type: `{${fieldType.namespace}}${fieldType.local}`, minOccurs: min, maxOccurs: max, nillable: nullable === "true" || nullable === "1"});
  }
  return {namespace, fields};
}

function qualified(node, value) {
  if (!value || !/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(value)) throw Error("Invalid type");
  const parts = value.split(":");
  const namespace = node.lookupNamespaceURI(parts.length === 2 ? parts[0] : null);
  if (!namespace) throw Error("Unresolved type");
  return {namespace, local: parts.at(-1)};
}
