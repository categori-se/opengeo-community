const KEY = 'opengeo.public-demo.layer-catalog.v1';
const MAX_CHARS = 2_000_000;
const day = () => {const now=new Date();return [now.getFullYear(),now.getMonth()+1,now.getDate()].join('-');};
const valid = entry => Array.isArray(entry) && entry.length===2 && typeof entry[0]==='string'
  && entry[0].length<=200 && entry[1]?.layer?.datasetId===entry[0]
  && typeof entry[1].layer.title==='string' && entry[1].layer.title.length<=1000
  && (entry[1].geojson===null || entry[1].geojson?.type==='FeatureCollection');
export function readBrowserLayerCatalog(storage) {
  try {
    const raw=storage?.getItem(KEY);if(!raw)return new Map();
    if(raw.length>MAX_CHARS){storage.removeItem(KEY);return new Map();}
    const value=JSON.parse(raw);
    if(value.day!==day() || !Array.isArray(value.entries) || value.entries.length>100 || !value.entries.every(valid)) {
      storage.removeItem(KEY);return new Map();
    }
    return new Map(value.entries);
  }catch{return new Map();}
}
export function writeBrowserLayerCatalog(storage, entries) {
  try {
    const values=[...entries];if(values.length>100 || !values.every(valid))return false;
    const raw=JSON.stringify({day:day(),entries:values});
    if(raw.length>MAX_CHARS || !storage)return false;
    storage.setItem(KEY,raw);return true;
  }catch{return false;}
}
export function clearBrowserLayerCatalog(storage) {try {storage?.removeItem(KEY);}catch{}}
