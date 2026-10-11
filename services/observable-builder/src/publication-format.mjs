export const PUBLICATION_CONFIG = 'opengeo.publication.json';
export const PUBLICATION_SCHEMA = 'opengeo.publication.1';

// This file is part of the exact revision manifest, so selecting a format is
// versioned with the source rather than being a mutable build-time preference.
export function publicationFormat(entryPath, files, read) {
  const inferred = /\.md$/i.test(entryPath) ? 'framework' : /\.ipynb$/i.test(entryPath) ? 'jupyter' : 'html';
  const prefix = entryPath.includes('/') ? entryPath.slice(0, entryPath.lastIndexOf('/') + 1) : '';
  const file = files.find(file => file.path === prefix + PUBLICATION_CONFIG);
  if (!file) return inferred;
  if (file.sizeBytes > 4096 || file.contentType !== 'application/json') throw Error('Invalid publication format record');
  const config = JSON.parse(read(file).toString('utf8'));
  if (!config || Array.isArray(config) || Object.keys(config).sort().join(',') !== 'entry,format,schema'
    || config.schema !== PUBLICATION_SCHEMA || config.entry !== entryPath.slice(prefix.length)
    || !['framework', 'html', 'map', 'notebook', 'jupyter'].includes(config.format)
    || (inferred === 'framework' ? config.format !== 'framework' : inferred === 'jupyter' ? config.format !== 'jupyter' : !['html', 'map', 'notebook'].includes(config.format))) {
    throw Error('Publication format does not match its entry');
  }
  return config.format;
}
