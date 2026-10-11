// Read the information already present on the Layer; opening details never fetches data.
export function LayerInfo({layer, metadata, open = false, onToggle = () => {}}) {
  const content = document.createElement('section');
  content.className = 'gis-layer-info';
  content.id = `layer-info-${crypto.randomUUID()}`;
  content.hidden = !open;
  const title = document.createElement('strong');
  title.textContent = layer.title || 'Untitled layer';
  content.append(title);
  for (const value of [metadata, layer.description, layer.attribution]) {
    if (!value) continue;
    const line = document.createElement('p'); line.textContent = value; content.append(line);
  }
  const fields = [
    ['Geometry', layer.geometryType],
    ['Source version', layer.sourceVersion],
    ['Style version', layer.styleReference?.versionNumber]
  ];
  const list = document.createElement('dl');
  for (const [label,value] of fields) {
    if (value == null || value === '') continue;
    const term=document.createElement('dt'), detail=document.createElement('dd');
    term.textContent=label;detail.textContent=String(value);list.append(term,detail);
  }
  if (list.childElementCount) content.append(list);
  const button=document.createElement('button');button.type='button';
  button.className='gis-layer-info-toggle';button.textContent='ⓘ';
  button.title=`Layer information: ${layer.title}`;
  button.setAttribute('aria-label',button.title);
  button.setAttribute('aria-controls',content.id);
  button.setAttribute('aria-expanded',String(open));
  button.addEventListener('click',event=>{
    event.stopPropagation();open=!open;content.hidden=!open;
    button.setAttribute('aria-expanded',String(open));onToggle(open);
  });
  return {button,content};
}
