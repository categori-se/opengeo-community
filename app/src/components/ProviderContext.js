import {appendProviderContext, contextProviders, providerExplore, recordedProviderContexts} from "../lib/providerContext.js";
export function ProviderContext({geometry, getKnowledge, setKnowledge, onPending, feedback, canEdit}) {
  const root = document.createElement("section"); root.className = "provider-context";
  const heading = text("h4", "Street imagery context");
  root.append(heading, text("p", "Explore with a provider, then record a useful observation. Coverage, capture details and rights remain unverified until supported by evidence. Opening a provider leaves Studio."));
  for (const [key, value] of Object.entries(contextProviders)) {
    root.append(external(`Explore ${value.name}`, providerExplore(key, geometry)), external(`${value.name} terms and attribution`, value.terms));
  }
  const recorded = document.createElement("div"); root.append(recorded);
  root.refresh = () => {
    try {
      const references = recordedProviderContexts(getKnowledge());
      const list = document.createElement("ul");
      for (const reference of references) {
        const item = text("li", "");
        item.append(external(`${reference.name} observation ${reference.identifier}`, reference.href),
          text("p", `Recorded attribution: ${reference.attribution ?? "not recorded"}. Relationship confidence: ${reference.confidence ?? "unknown"}. Provider availability and rights have not been verified by Studio.`));
        list.append(item);
      }
      recorded.replaceChildren(text("p", references.length ? "Provider references in this Geographic tag draft" : "No provider observations recorded."), list);
    } catch { recorded.replaceChildren(text("p", "Provider references cannot be read until the knowledge JSON is valid.")); }
  };
  root.refresh();
  root.append(text("p", "KartaView exploration uses the saved point when available. Other geometry opens the provider home page."));
  if (!canEdit) return root;
  const provider = document.createElement("select"); provider.setAttribute("aria-label", "Context provider");
  for (const [key, value] of Object.entries(contextProviders)) {const option = text("option", value.name);option.value=key;provider.append(option);}
  const identifier = input("Provider observation identifier");identifier.maxLength=30;identifier.inputMode="numeric";
  const attribution = input("Observation attribution, if known");attribution.maxLength=2000;
  const confidence = input("Observation relationship confidence");confidence.type="number";confidence.min="0";confidence.max="1";confidence.step="any";
  for (const control of [identifier, attribution, confidence]) control.addEventListener("input",()=>onPending(true));
  const add = text("button", "Add provider reference to draft");add.type="button";
  add.addEventListener("click",()=>{
    try {
      setKnowledge(appendProviderContext(getKnowledge(),{provider:provider.value,identifier:identifier.value.trim(),attribution:attribution.value,confidence:confidence.value===""?null:Number(confidence.value)}));
      identifier.value=attribution.value=confidence.value="";onPending(false);root.refresh();
      feedback("Provider reference added to the draft. Save Geographic tag to retain it.");
    } catch(error) {feedback(error.message);}
  });
  const clear=text("button","Clear pending observation");clear.type="button";clear.addEventListener("click",()=>{identifier.value=attribution.value=confidence.value="";onPending(false);});
  root.append(provider,identifier,attribution,confidence,text("p","Use the numeric image key for Mapillary or photo ID for KartaView. KartaView references open provider metadata; no images are copied."),add,clear);
  return root;
}
function text(tag,value){const element=document.createElement(tag);element.textContent=value;return element;}
function input(label){const element=document.createElement("input");element.setAttribute("aria-label",label);element.placeholder=label;return element;}
function external(label,href){const element=text("a",label);element.href=href;element.target="_blank";element.rel="noopener noreferrer";element.referrerPolicy="no-referrer";return element;}
