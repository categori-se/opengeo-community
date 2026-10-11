// Observable can attach a returned view after its construction microtask.
export function whenConnected(element, callback) {
  let cancelled = false, observer = null;
  const stop = () => {cancelled = true; observer?.disconnect();};
  const check = () => {
    if (cancelled || !element.isConnected) return;
    stop(); callback();
  };
  queueMicrotask(() => {
    if (cancelled) return;
    if (element.isConnected) {check(); return;}
    observer = new element.ownerDocument.defaultView.MutationObserver(check);
    observer.observe(element.ownerDocument.documentElement, {childList: true, subtree: true});
  });
  return stop;
}
