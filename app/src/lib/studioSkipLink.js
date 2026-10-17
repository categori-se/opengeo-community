// Retained workspaces place application navigation inside Framework's main.
// Resolve the currently visible content target when the link is activated.
export function installStudioSkipLink(document) {
  const skip = document.querySelector('.studio-skip-link');
  if (!skip) return () => {};
  const activate = event => {
    const target = [...document.querySelectorAll('[data-studio-skip-target]')]
      .find(node => !node.closest('[hidden]') && node.getClientRects().length);
    if (!target) return; // Static shell's main remains a working fallback.
    event.preventDefault();
    target.focus();
    target.scrollIntoView({block: 'start'});
  };
  skip.addEventListener('click', activate);
  return () => skip.removeEventListener('click', activate);
}
