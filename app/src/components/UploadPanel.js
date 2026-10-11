export function UploadPanel({workspace, role}) {
  const form = document.createElement("form");
  form.className = "upload-panel";
  form.addEventListener("submit", (event) => event.preventDefault());

  const canUpload = ["owner", "admin", "manager", "editor"].includes(role);
  const title = document.createElement("strong");
  title.textContent = "Register a dataset";
  form.append(title);

  form.append(field("Dataset title", input("text", "Road network update")));
  form.append(field("Classification", select(["internal", "restricted", "public"])));
  form.append(field("File", input("file")));

  const note = document.createElement("p");
  note.className = "note";
  note.textContent = canUpload
    ? `Uploads for ${workspace.title} will request a signed S3 URL before the browser sends bytes.`
    : "Your role can read this workspace, but it cannot request upload URLs.";
  form.append(note);

  const button = document.createElement("button");
  button.type = "submit";
  button.disabled = !canUpload;
  button.textContent = canUpload ? "Request upload URL" : "Upload unavailable";
  form.append(button);

  return form;
}

function field(label, control) {
  const wrapper = document.createElement("label");
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

function input(type, value = "") {
  const control = document.createElement("input");
  control.type = type;
  if (value && type !== "file") control.value = value;
  return control;
}

function select(options) {
  const control = document.createElement("select");
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option;
    element.textContent = option;
    control.append(element);
  }
  return control;
}
