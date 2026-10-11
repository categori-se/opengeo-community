/** Match the saved compiler's admitted layout without executing project config.
 * The selected page's parent is not necessarily the Framework project root.
 */
export function publicationSourceRoot(entryPath, paths = []) {
  if (typeof entryPath !== 'string') return '';
  if (/\.md$/i.test(entryPath)) {
    return entryPath.startsWith('src/') && paths.includes('package.json') ? 'src' : '';
  }
  // Static and native notebook publications use the entry directory as their
  // admitted tree. Do not widen their attachment boundary to the repository.
  const slash=entryPath.lastIndexOf('/');
  return slash<0?'':entryPath.slice(0,slash);
}
