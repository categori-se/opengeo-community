// Keep a failed startup inside one app-owned state so Observable does not repeat
// the same attachment error in every dependent cell.
export async function loadStudioPage(load, {
  retry = () => location.reload(),
  reportError = (error) => console.error("Studio page could not open.", error)
} = {}) {
  try {
    return await load();
  } catch (error) {
    reportError(error);
    const root = document.createElement("section");
    root.className = "platform-state studio-page-error";
    root.setAttribute("role", "alert");
    const title = document.createElement("h1");
    title.textContent = "This page couldn’t load";
    const message = document.createElement("p");
    message.textContent = "Please check your connection and try again.";
    const actions = document.createElement("div");
    actions.className = "platform-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "platform-button";
    button.textContent = "Try again";
    button.addEventListener("click", retry);
    const home = document.createElement("a");
    home.className = "platform-button secondary";
    home.href = "/";
    home.textContent = "Go to home";
    actions.append(button, home);
    root.append(title, message, actions);
    return root;
  }
}
