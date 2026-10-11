/** Show retained map HTML in an isolated view; importing this helper runs no map. */
export function createView({html, title = 'Map', height = 560, width = '100%', invalidation, signal,
  document: ownerDocument = globalThis.document} = {}) {
  if (typeof html !== 'string' || !html) throw new TypeError('Map HTML must be non-empty text.');
  if (!ownerDocument?.createElement) throw new Error('A browser document is required to show this map.');
  const root = ownerDocument.createElement('div');
  const frame = ownerDocument.createElement('iframe');
  frame.title = String(title);
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.width = typeof width === 'number' ? `${width}px` : String(width);
  frame.style.height = typeof height === 'number' ? `${height}px` : String(height);
  frame.style.border = '0';
  frame.srcdoc = html;
  root.append(frame);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    frame.srcdoc = '';
    root.remove();
  };
  Object.defineProperty(root, 'dispose', {value: dispose});
  if (signal?.aborted) dispose();
  else signal?.addEventListener('abort', dispose, {once: true});
  if (invalidation) Promise.resolve(invalidation).then(dispose, dispose);
  return root;
}
