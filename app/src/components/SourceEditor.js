export function SourceEditor({adapter, source, organizationId, userId, onSaved = null}) {
  const root = document.createElement("section"); root.className = "source-access-editor";
  if (!source.capabilities?.manageClassification || typeof adapter.updateSource !== "function") return root;
  const heading = document.createElement("h4"); heading.textContent = "Source access";
  const note = document.createElement("p");
  note.textContent = "Changes access classification while retaining the source revision, provider reference and metadata. Public access requires reviewed, published Catalog metadata for this exact source revision.";
  const label = document.createElement("label"), choice = document.createElement("select");
  label.textContent = "Source access "; choice.setAttribute("aria-label", "Source access");
  for (const value of ["internal", "restricted", "confidential", "public"]) {
    const option = document.createElement("option"); option.value = option.textContent = value; choice.append(option);
  }
  label.append(choice);
  const reviewedLabel = document.createElement("label"), reviewed = document.createElement("input"); reviewed.type = "checkbox";
  reviewed.setAttribute("aria-label", "Public source eligibility reviewed");
  reviewedLabel.append(reviewed, " I reviewed this source's terms and exact published Catalog metadata for public access.");
  const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "Apply access";
  const status = document.createElement("p"); status.setAttribute("role", "status");
  root.append(heading, note, label, reviewedLabel, apply, status);
  let current = structuredClone(source), busy = false, invalid = false;
  const update = () => {
    const publicDecision = choice.value === "public" && choice.value !== current.classification;
    reviewedLabel.hidden = !publicDecision;
    choice.disabled = reviewed.disabled = busy || invalid || !current.capabilities?.manageClassification;
    apply.disabled = choice.disabled || choice.value === current.classification || (publicDecision && !reviewed.checked);
  };
  const reset = () => {choice.value = current.classification; reviewed.checked = false; update();};
  const assertSession = async () => {
    const session = await adapter.getSession();
    if (session.userId !== userId || session.selectedOrganizationId !== organizationId) {
      throw Object.assign(Error("Source account changed"), {code: "source_context_changed"});
    }
  };
  choice.addEventListener("change", () => {reviewed.checked = false; update();});
  reviewed.addEventListener("change", update);
  apply.addEventListener("click", async () => {
    if (apply.disabled || busy || !root.isConnected) return;
    const original = structuredClone(current), target = choice.value, publicEligibilityReviewed = reviewed.checked;
    busy = true; update(); status.textContent = "Applying source access…";
    try {
      await assertSession();
      if (!root.isConnected) return;
      const updated = await adapter.updateSource(original.projectId, original.datasetId, {
        expectedVersion: original.versionNumber, expectedClassification: original.classification,
        classification: target, publicEligibilityReviewed
      });
      await assertSession();
      if (!root.isConnected) return;
      if (updated.datasetId !== original.datasetId || updated.projectId !== original.projectId
        || updated.versionNumber !== original.versionNumber || updated.sourceUrl !== original.sourceUrl
        || updated.sourceType !== original.sourceType || updated.ownerUserId !== original.ownerUserId
        || JSON.stringify(updated.configuration) !== JSON.stringify(original.configuration)
        || updated.classification !== target) throw Object.assign(Error("Source identity changed"), {code: "source_identity_changed"});
      current = structuredClone(updated); reset();
      await onSaved?.(updated);
      if (root.isConnected) status.textContent = "Source access saved. Source revision and provider reference are unchanged.";
    } catch (error) {
      if (!root.isConnected) return;
      if (error?.code === "source_context_changed" || error?.code === "source_identity_changed") {
        invalid = true; choice.replaceChildren(); reviewed.checked = false;
        status.textContent = "Reopen this source in the current account before continuing.";
      } else if (["external_source_classification_conflict", "external_source_version_conflict"].includes(error?.code)) {
        try {
          await assertSession();
          const fresh = await adapter.getSource(original.projectId, original.datasetId);
          await assertSession();
          if (!root.isConnected) return;
          if (fresh.datasetId !== original.datasetId || fresh.projectId !== original.projectId) throw Error("Source identity changed");
          current = structuredClone(fresh); reset();
          status.textContent = "Source access changed in another session. Review the current source before applying another decision.";
        } catch {
          invalid = true; choice.replaceChildren(); reviewed.checked = false;
          status.textContent = "Reopen this source before continuing.";
        }
      } else {
        reviewed.checked = false;
        status.textContent = error?.code === "external_source_public_metadata_required"
          ? "Publish reviewed Catalog metadata with terms, attribution and this exact source revision before choosing public access."
          : `Source access was not saved (${error?.code ?? "unexpected_error"}).`;
      }
    } finally {busy = false; if (root.isConnected) update();}
  });
  reset(); return root;
}
