// Source stays in the browser. The public shell receives it only over a private
// MessageChannel, never in a URL, upload, cookie or capability exchange.
export const FRAMEWORK_DRAFT_URL = 'https://preview.studio.opengeo.tools/authorize/draft.html';
export const FRAMEWORK_DRAFT_MAX_BYTES = 32 * 1024 * 1024;

export function createFrameworkDraftPreview(frame) {
  let active;
  function dispose() {
    if (!active) return;
    const previous = active; active = null;
    previous.finish();
    frame.removeAttribute('src'); frame.removeAttribute('srcdoc');
    // Discard the old browsing context and its queued blank-page load before
    // installing the next shell's single load handler.
    if (frame.parentNode && frame.isConnected) {
      const parent = frame.parentNode, sibling = frame.nextSibling;
      frame.remove(); parent.insertBefore(frame, sibling);
    }
  }
  return {dispose, render(html, isCurrent = () => true, attachments = []) {
    dispose();
    if (!Array.isArray(attachments) || attachments.length > 128
      || attachments.some((file, index) => !(file.blob instanceof Blob) || file.blob.size < 1
        || file.path !== `/attachment/${index}`)
      || attachments.reduce((sum, file) => sum + file.blob.size, 0) > 64 * 1024 * 1024) {
      return Promise.reject(Error('Draft attachments exceed the supported 64 MiB inventory.'));
    }
    if (typeof html !== 'string' || new TextEncoder().encode(html).byteLength > FRAMEWORK_DRAFT_MAX_BYTES) {
      return Promise.reject(Error('Draft preview exceeds 32 MiB. Use Saved build.'));
    }
    if (!isCurrent() || !frame.isConnected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      let sent = false;
      const session = active = {finish(error) {
        clearTimeout(timer); channel.port1.close(); channel.port2.close();
        frame.removeEventListener('load', onLoad);
        error ? reject(error) : resolve();
      }};
      const current = () => active === session && frame.isConnected && isCurrent();
      const timer = setTimeout(() => {
        session.finish(Error('Draft preview did not start. Use Saved build.'));
        if (active === session) {active = null; frame.removeAttribute('src');}
      }, 12000);
      function onLoad() {
        if (!current()) {if (active === session) dispose(); return;}
        // '*' is required for an opaque sandbox. The exact frame window and
        // transferred port, not a window-wide message listener, bind the reply.
        frame.contentWindow.postMessage('opengeo-framework-draft-connect', '*', [channel.port2]);
      }
      channel.port1.onmessage = ({data}) => {
        if (!current()) {if (active === session) dispose(); return;}
        if (data === 'ready' && !sent) {
          sent = true; channel.port1.postMessage({kind: 'render', revision: 1, html,
            ...(attachments.length ? {attachments} : {})});
        } else if (sent && data?.kind === 'rendered' && data.revision === 1) session.finish();
        else if (data?.kind === 'error') session.finish(Error('Draft preview was rejected. Use Saved build.'));
      };
      frame.removeAttribute('srcdoc');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.referrerPolicy = 'no-referrer';
      frame.addEventListener('load', onLoad, {once: true});
      frame.src = FRAMEWORK_DRAFT_URL;
    });
  }};
}
