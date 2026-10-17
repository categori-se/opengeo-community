import {directoryHref, projectHref} from "../lib/applicationRoutes.js";
import {ResourceStyleVersionEditor} from './ResourceStyleVersionEditor.js';
import {cartographicPatterns, patternImage, patternSld, savedPattern} from '../lib/cartographicPatterns.js';
import {createLandCoverStyle, landCoverPresets, landCoverModuleSource} from '../lib/landCoverStyle.js';
import {POINT_SYMBOLS, pointSymbolPreviewSvg, ensurePointSymbolAssets} from '../lib/pointSymbols.js';
import {pointSymbolStyleDefinition, savedPointSymbolStyle} from '../lib/layerStyleReference.js';
import {SymbologyGallery} from './SymbologyGallery.js';
import {symbologyCatalog, symbologyPreview} from '../lib/symbologyCatalog.js';

export function StyleLibrary({adapter, containers}) {
  const node=(tag,text='')=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const root=node('section');root.className='style-library';
  const note=node('p','Explore the symbol library, customize a point, line or area Style, and save it on a permitted resource. Choose the saved version in your Layer to reuse it.');
  const limit=node('p','Save a preset to a linked resource, then select its version in a polygon Layer’s Style panel. Other saved definitions remain available for inspection and download.');
  const library=node('select');library.ariaLabel='Data library';
  library.append(new Option('Choose a data library',''));
  for(const item of containers) library.append(new Option(item.name,item.id));
  const resources=node('select');resources.ariaLabel='Style resource';resources.append(new Option('Choose a resource',''));
  const more=node('button','Load more resources');more.type='button';more.hidden=true;
  const feedback=node('p');feedback.setAttribute('role','status');
  const manage=node('a','Manage or register resources');manage.hidden=true;
  const saved=node('div'), designer=node('section');designer.className='style-designer';
  let current=null, generation=0, disposed=false, offset=0, busy=false;
  let selectedLibrary='', selectedResource='', editing=null, needsReview=false, baseline='';
  let editingPoint=null, pointNeedsReview=false, updatePointActions=()=>{}, hasPointDraft=()=>false;
  let updatePresetActions=()=>{}, hasPresetDraft=()=>false;
  const entries=new Map();
  const button=text=>{const e=node('button',text);e.type='button';return e;};
  const title=node('input');title.ariaLabel='Style title';title.value='Untitled pattern';title.maxLength=240;
  const motif=node('select');motif.ariaLabel='Pattern';
  for(const item of cartographicPatterns) motif.append(new Option(item.title,item.id));
  const foreground=node('input');foreground.type='color';foreground.ariaLabel='Pattern color';foreground.value='#444444';
  const background=node('input');background.type='color';background.ariaLabel='Background color';background.value='#ffffff';
  const range=(aria,min,max,step,value)=>{const e=node('input');Object.assign(e,{type:'range',ariaLabel:aria,min:String(min),max:String(max),step:String(step),value:String(value)});return e;};
  const size=range('Pattern spacing',8,64,1,32), width=range('Pattern line width',.5,4,.1,1.4);
  const density=range('Pattern density',.5,4,.25,1), angle=range('Pattern direction',-180,180,5,0);
  const amplitude=range('Wave height',0,16,.5,8), curve=range('Wave curve',0,1,.05,.5), opacity=range('Pattern opacity',0,1,.05,1);
  const transparent=node('input');transparent.type='checkbox';transparent.ariaLabel='Transparent background';
  const transparentLabel=node('label','Transparent background');transparentLabel.prepend(transparent);
  const preview=node('div');preview.className='style-pattern-preview';preview.setAttribute('aria-label','Live pattern preview');
  const save=button('Save new Style'), copy=button('Save as copy'), newStyle=button('New style'), discard=button('Discard changes');
  const checkLatest=button('Check latest pattern version'), useLatest=button('Use latest pattern as edit base');
  const editStatus=node('span');editStatus.className='style-edit-status';editStatus.setAttribute('role','status');
  save.disabled=true;copy.disabled=true;discard.hidden=true;checkLatest.hidden=true;useLatest.hidden=true;
  const controls=[title,motif,foreground,background,size,width,density,angle,amplitude,curve,opacity,transparent];
  const draft=()=>({version:2,id:motif.value,foreground:foreground.value,background:background.value,size:Number(size.value),width:Number(width.value),transparent:transparent.checked,density:Number(density.value),angle:Number(angle.value),amplitude:Number(amplitude.value),curve:Number(curve.value),opacity:Number(opacity.value)});
  const signature=()=>JSON.stringify({name:title.value,pattern:draft()});
  const hasPatternDraft=()=>baseline!==''&&signature()!==baseline;
  const updateActions=()=>{
    save.textContent=editing?'Save changes':'Save new Style';
    save.disabled=busy||!current?.canUpdate||needsReview||!title.value.trim()||editing?.archived===true;
    copy.disabled=busy||!current?.canUpdate||!editing||!title.value.trim();
    newStyle.disabled=busy;discard.hidden=!hasPatternDraft()&&!needsReview;discard.disabled=busy;
    checkLatest.hidden=!needsReview;checkLatest.disabled=busy;useLatest.disabled=busy;
    editStatus.textContent=editing?`${editing.title} · version ${editing.versionNumber}${hasPatternDraft()?' · unsaved changes':''}`:hasPatternDraft()?'New style · unsaved changes':'New style';
    updatePointActions();
    updatePresetActions();
  };
  const render=()=>{preview.replaceChildren(patternImage(draft()));updateActions();};
  const presetButtons=[];
  const clearPreset=()=>presetButtons.forEach(button=>button.setAttribute('aria-pressed','false'));
  const outputs=new Map();
  const updateOutputs=()=>{for(const [input,{output,unit}] of outputs)output.textContent=`${input.value}${unit}`;};
  const setPattern=(p,name)=>{
    motif.value=p.id;foreground.value=p.foreground;background.value=p.background;title.value=name;
    for(const [input,key,fallback] of [[size,'size',32],[width,'width',1.4],[density,'density',1],[angle,'angle',0],[amplitude,'amplitude',8],[curve,'curve',.5],[opacity,'opacity',1]])input.value=String(p[key]??fallback);
    transparent.checked=p.transparent===true;updateOutputs();updateWaveControls();clearPreset();render();
  };
  let waveControls=[];
  function updateWaveControls(){for(const e of waveControls)e.hidden=motif.value!=='waves';}
  motif.addEventListener('change',()=>{clearPreset();updateWaveControls();render();});
  controls.filter(input=>input!==motif).forEach(input=>input.addEventListener('input',()=>{clearPreset();updateOutputs();render();}));
  const presets=node('details');presets.append(node('summary','Land-cover presets'));presets.className='style-presets';presets.setAttribute('aria-label','Cartographic presets');
  const reference=node('p','Blue water and green vegetation draw on ');
  const source=node('a','USGS topographic symbol conventions');source.href='https://www.usgs.gov/ngp-standards-and-specifications/us-topo-map-symbol-guide';
  reference.append(source,document.createTextNode('. Land-cover variants are editable conventions, not a classification standard. Adapt their contrast and spacing to your map.'));
  const grid=node('div');grid.className='style-preset-grid';
  const defaults=[
    {title:'Water',id:'waves',foreground:'#4e96bf',background:'#d5ebf5',description:'Blue waves for open water'},
    {title:'Lakes',id:'ripples',foreground:'#438fba',background:'#d8edf7',description:'Light blue water with short ripples'},
    {title:'Wetlands',id:'wetland',foreground:'#428aa8',background:'#e2eddf',description:'Blue reeds over a pale vegetation fill'},
    {title:'Marshes',id:'wetland',foreground:'#3d85ad',background:'#edf4f6',description:'Blue reeds over a pale water fill'},
    {title:'Forest',id:'forest',foreground:'#39724f',background:'#dcebd1',description:'Green woodland with tree symbols'}
  ];
  const names={water:'Water',lakes:'Lakes',wetlands:'Wetlands',marsh:'Marsh',forest:'Forest',grassland:'Grassland','built-areas':'Built areas',
    'deciduous-forest':'Deciduous forest','evergreen-forest':'Evergreen forest','mixed-forest':'Mixed forest',shrubland:'Shrubland',
    cropland:'Cropland',orchards:'Orchards','bare-ground':'Bare ground',rock:'Rock',sand:'Sand',snow:'Snow',ice:'Ice'};
  const descriptions={grassland:'Pale green grass symbols','built-areas':'Gray stipple for developed land',
    'deciduous-forest':'Light green, widely spaced trees','evergreen-forest':'Dark green, closely spaced trees','mixed-forest':'Mid-green woodland',
    shrubland:'Olive, widely spaced vegetation',cropland:'Golden agricultural rows',orchards:'Green, regularly spaced dots',
    'bare-ground':'Sparse brown stipple',rock:'Dense gray hatching',sand:'Fine gold stipple',snow:'Sparse blue marks on white',ice:'Pale blue hatching'};
  for(const [key,item] of Object.entries(landCoverPresets)) if(!['water','lakes','wetlands','marsh','forest'].includes(key)) {
    defaults.push({...item,id:item.pattern,title:names[key],description:descriptions[key]});
  }
  const selectPreset=(item,button)=>{
    if(busy)return;
    if(editing||hasStyleDraft()||hasPresetDraft()){feedback.textContent='Choose New style or finish the current edit before starting from a preset.';return;}
    setPattern({...item,transparent:false},item.title);
    clearPreset();button.setAttribute('aria-pressed','true');render();
    feedback.textContent=current?.canUpdate?`${item.title} selected. Save new Style to reuse this preset.`:`${item.title} selected. Choose a data library and resource to save it.`;
  };
  for(const item of defaults){
    const button=node('button');button.type='button';button.className='style-preset-card';
    button.setAttribute('aria-label',`${item.title} preset`);button.setAttribute('aria-pressed','false');
    const swatch=patternImage({...item,size:item.size??32,width:item.width??1.4,transparent:false});swatch.alt=`${item.title}: ${item.description}`;
    button.append(swatch,node('strong',item.title),node('span',item.description));
    button.addEventListener('click',()=>selectPreset(item,button));presetButtons.push(button);grid.append(button);
  }
  const guidance=node('details');guidance.append(node('summary','Style guidance and sources'),
    node('p','Use these colors and textures for land-cover categories. For quantities, choose a sequential or diverging palette. Adapt patterns to scale, keep context subdued and include a clear legend.'),
    node('p','For thematic maps, compare polygon rates rather than raw counts; represent point magnitudes with proportional symbol areas.'));
  const sources=node('ul');
  for(const [label,href] of [
    ['USGS topographic symbols (2005)','https://pubs.usgs.gov/gip/TopographicMapSymbols/topomapsymbols.pdf'],
    ['NPS map patterns','https://www.nps.gov/subjects/gisandmapping/map-symbols-patterns-for-nps-maps.htm'],
    ['Felt map symbology','https://felt.com/blog/map-symbology'],
    ['Esri thematic map design','https://learn.arcgis.com/en/projects/design-symbology-for-a-thematic-map/arcgis-pro/']
  ]) {const item=node('li'),link=node('a',label);link.href=href;item.append(link);sources.append(item);}
  guidance.append(sources);
  presets.append(reference,grid,guidance,node('p','Select a preset to edit it in the designer. Saving requires edit access to the selected resource.'));
  const landCover=node('details');landCover.className='style-presets';landCover.setAttribute('aria-label','Land-cover reference');landCover.append(node('summary','Map Folio · D3 and Plot patterns'));
  const landGrid=node('div');landGrid.className='style-preset-grid';
  for(const [key,item] of Object.entries(landCoverPresets)){
    const button=node('button');button.type='button';button.className='style-preset-card';button.setAttribute('aria-label',`${names[key]} reference preset`);button.setAttribute('aria-pressed','false');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 240 100');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${names[key]} pattern`);
    const style=createLandCoverStyle({document});style.install(svg);
    const rect=document.createElementNS('http://www.w3.org/2000/svg','rect');rect.setAttribute('width','240');rect.setAttribute('height','100');rect.setAttribute('fill',style.paint(key).fill);svg.append(rect);
    button.append(svg,node('strong',names[key]));button.addEventListener('click',()=>selectPreset({...item,id:item.pattern,title:names[key]},button));presetButtons.push(button);landGrid.append(button);
  }
  const examples=node('details');examples.append(node('summary','Use with D3 or Observable Plot'));
  examples.append(node('p','Download opengeo-landcover.js beside your notebook sources, then copy an example. Choose a class for each layer, or supply your own classifier.'));
  const snippets={
    D3:"import {createLandCoverStyle} from './opengeo-landcover.js';\nconst style = createLandCoverStyle({document});\nstyle.install(svg.node());\n// Apply a known class to this forest layer.\nstyle.applyD3(svg.selectAll('path.land'), () => 'forest');",
    Plot:"import {createLandCoverStyle} from './opengeo-landcover.js';\nconst style = createLandCoverStyle({document});\nconst svg = Plot.plot({marks: [\n  Plot.geo(features, style.plotGeoOptions(() => 'water'))\n]});\nstyle.install(svg);"
  };
  const copyStatus=node('p');copyStatus.setAttribute('role','status');
  const downloadModule=node('button','Download module');downloadModule.type='button';
  downloadModule.addEventListener('click',()=>{let url;const anchor=node('a');try{
    url=URL.createObjectURL(new Blob([landCoverModuleSource()],{type:'text/javascript;charset=utf-8'}));
    anchor.href=url;anchor.download='opengeo-landcover.js';document.body.append(anchor);anchor.click();copyStatus.textContent='Module downloaded. Use it with the examples below.';
  }catch{copyStatus.textContent='The module could not download. Try the download again.';}finally{anchor.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}});
  examples.append(downloadModule);
  for(const [name,text] of Object.entries(snippets)){
    const pre=node('pre'),code=node('code',text);pre.append(code);const copy=node('button',`Copy ${name} example`);copy.type='button';
    const clipboard=document.defaultView?.navigator.clipboard;copy.disabled=typeof clipboard?.writeText!=='function';
    copy.addEventListener('click',async()=>{try{await clipboard.writeText(text);copyStatus.textContent=`${name} example copied.`;}catch{copyStatus.textContent='Select the example text to copy it.';}});
    examples.append(node('h3',name==='Plot'?'Observable Plot':name),copy,pre);
  }
  examples.append(copyStatus);
  landCover.append(node('h2','Land-cover reference'),node('p','Map Folio colors extended for common land-cover classes, with local procedural patterns. Forest types, wetlands, agriculture, built areas, bare surfaces, snow and ice use distinct colors or spacing. These editable conventions do not classify data.'),landGrid,examples);
  baseline=signature();
  const label=(text,control)=>{const result=node('label',text);result.append(control);return result;};
  const measured=(text,input,unit)=>{const field=label(text,input),output=node('output');output.setAttribute('aria-label',`${text} value`);field.append(output);outputs.set(input,{output,unit});return field;};
  const points=node('section');points.className='style-point-designer';points.id='point-symbols';
  const pointTitle=node('input');pointTitle.ariaLabel='Point Style title';pointTitle.maxLength=240;pointTitle.value='Hospital';
  const pointSymbol=node('select');pointSymbol.ariaLabel='Point symbol';
  for(const item of POINT_SYMBOLS)pointSymbol.append(new Option(item.label,item.id));pointSymbol.value='hospital';
  const pointColor=node('input');pointColor.type='color';pointColor.ariaLabel='Point color';pointColor.value='#2563eb';
  const pointRadius=range('Point radius',2,24,1,8);
  const pointPreview=node('img');pointPreview.className='style-point-preview';pointPreview.alt='Point symbol preview';
  const pointSave=button('Save point Style'),pointNew=button('New point Style'),pointDiscard=button('Discard point changes');
  const pointCheck=button('Check latest point version'),pointUseLatest=button('Use latest point as edit base');
  const pointStatus=node('p');pointStatus.setAttribute('role','status');
  const pointLatestView=node('pre');pointLatestView.setAttribute('aria-label','Latest saved point Style for comparison');pointLatestView.hidden=true;
  const pointControls=[pointTitle,pointSymbol,pointColor,pointRadius];
  const pointDraft=()=>({pointSymbol:pointSymbol.value,circleColor:pointColor.value,circleRadius:Number(pointRadius.value)});
  const pointSignature=()=>JSON.stringify({name:pointTitle.value,style:pointDraft()});
  let pointBaseline=pointSignature(),pointLatest=null;
  let pointLoading=false,pointSelectionTicket=0,renderedPointSymbol=pointSymbol.value;
  hasPointDraft=()=>pointSignature()!==pointBaseline;
  updatePointActions=()=>{
    pointSave.textContent=editingPoint?'Save point changes':'Save point Style';
    pointSave.disabled=busy||pointLoading||!current?.canUpdate||pointNeedsReview||!pointTitle.value.trim()||editingPoint?.archived===true;
    pointControls.forEach(input=>input.disabled=busy||pointLoading);pointNew.disabled=busy||pointLoading;
    pointDiscard.hidden=!hasPointDraft()&&!pointNeedsReview;pointDiscard.disabled=busy||pointLoading;
    pointCheck.hidden=!pointNeedsReview;pointCheck.disabled=busy;pointUseLatest.disabled=busy;
  };
  const renderPoint=()=>{
    pointPreview.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pointSymbolPreviewSvg(pointDraft()))}`;
    pointPreview.alt=`${POINT_SYMBOLS.find(item=>item.id===pointSymbol.value)?.label??'Point'} symbol preview`;
    renderedPointSymbol=pointSymbol.value;
    updateOutputs();updatePointActions();
  };
  const setPoint=(style,name)=>{pointSymbol.value=style.pointSymbol;pointColor.value=style.circleColor;pointRadius.value=String(style.circleRadius);pointTitle.value=name;renderPoint();};
  const resetPoint=()=>{editingPoint=null;pointNeedsReview=false;pointLatest=null;pointUseLatest.hidden=true;pointLatestView.hidden=true;setPoint({pointSymbol:'hospital',circleColor:'#2563eb',circleRadius:8},'Hospital');pointBaseline=pointSignature();updatePointActions();};
  for(const input of pointControls.filter(input=>input!==pointSymbol))input.addEventListener('input',renderPoint);
  pointSymbol.addEventListener('change',async()=>{
    const ticket=++pointSelectionTicket,previous=renderedPointSymbol;
    pointLoading=true;updatePointActions();pointStatus.textContent='Loading symbol…';
    try{
      await ensurePointSymbolAssets(pointDraft());
      if(disposed||ticket!==pointSelectionTicket)return;
      renderPoint();pointStatus.textContent='Symbol ready. Save the Style to keep this choice.';
    }catch{
      if(disposed||ticket!==pointSelectionTicket)return;
      pointSymbol.value=previous;renderPoint();pointStatus.textContent='The symbol could not load. Your previous selection is unchanged.';
    }finally{if(!disposed&&ticket===pointSelectionTicket){pointLoading=false;updatePointActions();}}
  });
  const pointSettings=node('div');pointSettings.className='style-pattern-controls style-point-controls';
  pointSettings.append(label('Name',pointTitle),label('Symbol',pointSymbol),label('Color',pointColor),measured('Point radius',pointRadius,' px'));
  const pointActions=node('div');pointActions.className='style-designer-actions style-point-actions';
  pointActions.append(pointSave,pointNew,pointDiscard,pointCheck,pointUseLatest);
  pointUseLatest.hidden=true;
  points.append(node('h2','Point Style'),node('p','Choose a symbol from the gallery, then adjust its color and size. Save it on the resource linked to your Layer’s dataset and choose its version from the Layer’s saved Styles. Existing maps keep their selected version.'),pointSettings,pointPreview,pointActions,pointStatus,pointLatestView);
  const settings=node('div');settings.className='style-pattern-controls';
  waveControls=[measured('Wave height',amplitude,''),measured('Curve',curve,'')];
  settings.append(label('Name',title),label('Shape',motif),label('Ink',foreground),label('Background',background),measured('Spacing',size,' px'),measured('Density',density,'×'),measured('Direction',angle,'°'),measured('Stroke / dot size',width,' px'),...waveControls,measured('Ink opacity',opacity,''),transparentLabel);
  const actions=node('div');actions.className='style-designer-actions';actions.append(newStyle,save,copy,discard,checkLatest,useLatest,editStatus);
  designer.append(node('h2','Pattern designer'),settings,preview,actions);
  designer.id='style-pattern-designer';
  const presetDesigner=node('section');presetDesigner.className='symbology-gallery-preset-designer';presetDesigner.id='style-preset-designer';presetDesigner.hidden=true;
  const presetName=node('input');presetName.ariaLabel='Preset Style name';presetName.maxLength=240;
  const presetField=node('input');presetField.ariaLabel='Preset numeric field';presetField.maxLength=100;
  const presetFieldLabel=label('Numeric field',presetField);
  const presetPreview=node('div');presetPreview.className='symbology-gallery-preset-preview';
  const presetDefinition=node('pre');presetDefinition.setAttribute('aria-label','Preset Style definition');
  const presetDefinitionDetails=node('details');presetDefinitionDetails.append(node('summary','Inspect Style definition'),presetDefinition);
  const presetSave=button('Save as new Style'),presetDiscard=button('Discard preset changes');
  const presetStatus=node('p');presetStatus.setAttribute('role','status');
  const presetSettings=node('div');presetSettings.className='symbology-gallery-preset-fields';presetSettings.append(label('Name',presetName),presetFieldLabel);
  const presetActions=node('div');presetActions.className='symbology-gallery-preset-actions';presetActions.append(presetSave,presetDiscard);
  presetDesigner.append(node('h2','Line and area Style'),node('p','Customize this template, choose the resource linked to your Layer, and save a new Style. Select its saved version in the Layer’s Style panel.'),presetSettings,presetPreview,presetDefinitionDetails,presetActions,presetStatus);
  let presetEntry=null,presetBaseline='';
  const presetSignature=()=>JSON.stringify({entry:presetEntry?.id,name:presetName.value,field:presetField.value});
  hasPresetDraft=()=>Boolean(presetEntry)&&presetSignature()!==presetBaseline;
  const presetBytes=()=>{
    if(!presetEntry)throw Error('Choose a Style template');
    const field=presetField.value.trim(),original=presetEntry.recipe.field;
    if(original&&!/^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/.test(field))throw Error('Enter a valid numeric field name.');
    const definition=JSON.parse(presetEntry.recipe.definition);
    const bind=value=>{
      if(Array.isArray(value))return value.length===2&&value[0]==='get'&&value[1]===original?['get',field]:value.map(bind);
      if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,bind(item)]));
      return value;
    };
    const bound=original?bind(definition):definition;bound.name=presetName.value.trim();return JSON.stringify(bound,null,2);
  };
  updatePresetActions=()=>{
    let valid=true;
    if(presetEntry){try{presetDefinition.textContent=presetBytes();presetField.setCustomValidity('');}catch(error){valid=false;presetField.setCustomValidity(error.message);presetDefinition.textContent=error.message;}}
    presetSave.disabled=busy||!current?.canUpdate||!presetEntry||!presetName.value.trim()||!valid||!hasPresetDraft();
    presetDiscard.disabled=busy;presetName.disabled=presetField.disabled=busy;
  };
  for(const control of [presetName,presetField])control.addEventListener('input',updatePresetActions);
  const clearPresetDraft=()=>{presetEntry=null;presetBaseline='';presetDesigner.hidden=true;updatePresetActions();};
  presetDiscard.addEventListener('click',()=>{if(!busy){clearPresetDraft();feedback.textContent='Unsaved preset changes discarded.';}});
  presetSave.addEventListener('click',async()=>{
    if(busy||!current?.canUpdate||!presetEntry||!presetName.value.trim()||!hasPresetDraft())return;
    if(hasStyleDraft()||hasPatternDraft()||needsReview||hasPointDraft()||pointNeedsReview){presetStatus.textContent='Save or discard the other Style draft before saving this preset.';return;}
    let definition;try{definition=presetBytes();}catch(error){presetStatus.textContent=error.message;return;}
    const scope=current;lock(true);
    try{
      const created=await adapter.createResourceStyle(scope.projectId,scope.resourceId,{slug:`preset-${crypto.randomUUID()}`,title:presetName.value.trim(),format:'maplibre',definition});
      if(disposed)return;
      if(!matches(created,scope)||created.format!=='maplibre'||created.definition!==definition||created.versionNumber!==1)throw Error('Style identity changed');
      saved.append(card(created,true,scope));presetBaseline=presetSignature();applyFilter();presetStatus.textContent=`Saved ${created.title} · version ${created.versionNumber}. Select this version in your Layer’s saved Styles.`;
    }catch{current=null;presetStatus.textContent='The save could not be confirmed. Your draft is unchanged; reload the resource before trying again.';}
    finally{lock(false);}
  });
  const galleryNotice=node('p');galleryNotice.className='symbology-gallery-selection-notice';galleryNotice.setAttribute('role','status');
  const canChooseGallery=()=>!busy&&!pointLoading&&!hasStyleDraft()&&!hasPatternDraft()&&!needsReview&&!hasPointDraft()&&!pointNeedsReview&&!hasPresetDraft();
  const gallery=SymbologyGallery({entries:symbologyCatalog(),preview:symbologyPreview,onChoose:async entry=>{
    if(!canChooseGallery()){
      galleryNotice.textContent='Save or discard the current Style draft before choosing another item.';return false;
    }
    const recipe=entry.recipe;
    let editor;
    if(recipe?.kind==='point'){
      await ensurePointSymbolAssets(recipe.style);
      if(disposed)return false;
      if(!canChooseGallery()){galleryNotice.textContent='Save or discard the current Style draft before choosing another item.';return false;}
      editingPoint=null;pointNeedsReview=false;pointLatest=null;pointUseLatest.hidden=true;pointLatestView.hidden=true;
      setPoint(recipe.style,entry.title);editor=points;
    }else if(recipe?.kind==='pattern'){
      editing=null;needsReview=false;useLatest.hidden=true;setPattern(recipe.pattern,entry.title);editor=designer;
    }else if(recipe?.kind==='maplibre'){
      presetEntry=entry;presetBaseline='';presetName.value=recipe.title??entry.title;presetField.value=recipe.field??'';
      presetFieldLabel.hidden=!recipe.field;presetFieldLabel.firstChild.textContent=recipe.fieldLabel?'Numeric field · '+recipe.fieldLabel:'Numeric field';
      presetPreview.replaceChildren(symbologyPreview(entry));presetDesigner.hidden=false;presetStatus.textContent='';updatePresetActions();editor=presetDesigner;
    }else{
      galleryNotice.textContent=`${entry.title} is a source reference. Inspect its preview, source and terms in the gallery; it does not create an editable map Style.`;return true;
    }
    const jump=node('a','Customize selected Style');jump.href=`#${editor.id}`;
    galleryNotice.replaceChildren(document.createTextNode(`${entry.title} is ready. `),jump,document.createTextNode(current?.canUpdate?' Save the new Style below.':' Choose a data library and resource below to save it.'));
    return true;
  }});
  const scopeBar=node('div');scopeBar.className='style-library-scope';scopeBar.append(label('Data library',library),label('Resource',resources),more,manage);
  const filter=node('input');filter.type='search';filter.placeholder='Find saved styles';filter.ariaLabel='Find saved styles';
  const showDeleted=node('input');showDeleted.type='checkbox';showDeleted.ariaLabel='Show deleted styles';
  const deletedLabel=label('Show deleted',showDeleted), savedToolbar=node('div');savedToolbar.className='style-saved-toolbar';
  savedToolbar.append(node('h2','Saved styles'),filter,deletedLabel);saved.className='style-saved-list';
  root.append(note,gallery,galleryNotice,scopeBar,points,designer,presetDesigner,savedToolbar,feedback,saved,presets,landCover,limit);
  updateOutputs();updateWaveControls();render();renderPoint();
  const hasStyleDraft=()=>[...saved.querySelectorAll('.resource-style-version-editor')].some(editor=>editor.hasUnsavedChanges?.());
  const currentHref=directoryHref({view:'styles',adapterKind:adapter.kind});
  root.shouldBlockNavigation=()=>busy||pointLoading||hasStyleDraft()||hasPatternDraft()||needsReview||hasPointDraft()||pointNeedsReview||hasPresetDraft();
  root.currentHref=()=>currentHref;
  root.dispose=()=>{disposed=true;generation++;gallery.dispose();};
  const blockSelection=()=>{
    // A new local symbol can be designed before choosing where to save it.
    if(!busy&&!hasStyleDraft()&&!editing&&!editingPoint&&!selectedResource)return false;
    if(!busy&&!hasStyleDraft()&&!editing&&!editingPoint&&!hasPointDraft()&&!pointNeedsReview&&!hasPresetDraft())return false;
    if(!root.shouldBlockNavigation())return false;
    library.value=selectedLibrary;resources.value=selectedResource;
    feedback.textContent='Finish reviewing or saving your Style draft before changing libraries or resources.';
    return true;
  };
  async function loadResources(reset=false) {
    const ticket=++generation, projectId=library.value;
    if(reset){offset=0;resources.replaceChildren(new Option('Choose a resource',''));saved.replaceChildren();entries.clear();current=null;editing=null;needsReview=false;if(editingPoint)resetPoint();updateActions();}
    manage.hidden=!projectId;
    if(!projectId)return;
    manage.href=projectHref(projectId,{adapterKind:adapter.kind,management:'resources'});
    more.disabled=true;
    try {
      const page=await adapter.listResources(projectId,{limit:50,offset});
      if(disposed||ticket!==generation)return;
      for(const item of page) if(['dataset','map','service'].includes(item.kind)&&item.state!=='archived') resources.append(new Option(item.title,item.id));
      offset+=page.length;more.hidden=page.length<50||offset>=10000;
      feedback.textContent=resources.options.length>1?'Choose a resource to view and save its Styles.':'No eligible resources on this page. Load more or register a dataset, map or service resource.';
    } catch {if(!disposed&&ticket===generation)feedback.textContent='Resources could not load. Select the library again to retry.';}
    finally {if(ticket===generation)more.disabled=false;}
  }
  library.addEventListener('change',()=>{
    if(blockSelection())return;
    selectedLibrary=library.value;selectedResource='';void loadResources(true);
  });more.addEventListener('click',()=>void loadResources());
  const lock=value=>{
    busy=value;library.disabled=resources.disabled=more.disabled=showDeleted.disabled=value;
    controls.forEach(input=>input.disabled=value);updateActions();
  };
  const matches=(style, scope)=>style&&style.resourceId===scope.resourceId&&typeof style.id==='string'&&Number.isSafeInteger(style.versionNumber)&&style.versionNumber>0;
  function applyFilter(){const term=filter.value.trim().toLowerCase();for(const {entry,style} of entries.values())entry.hidden=!!term&&!`${style.title} ${style.slug} ${style.format}`.toLowerCase().includes(term);}
  filter.addEventListener('input',applyFilter);
  function startNew(){editing=null;needsReview=false;useLatest.hidden=true;setPattern({id:'hatch',foreground:'#444444',background:'#ffffff'},'Untitled pattern');baseline=signature();updateActions();title.focus();}
  newStyle.addEventListener('click',()=>{
    if(hasStyleDraft()||hasPatternDraft()||needsReview||hasPresetDraft()){feedback.textContent='Save or discard your current draft before starting a new style.';return;}startNew();
  });
  discard.addEventListener('click',()=>{
    if(editing){setPattern(savedPattern(editing),editing.title);needsReview=false;useLatest.hidden=true;baseline=signature();updateActions();}
    else startNew();feedback.textContent='Unsaved pattern changes discarded.';
  });
  function card(style, canUpdate, scope = current) {
    const entry=node('article');entry.className='style-saved-row';
    const heading=node('h3'), thumbnail=node('div'), row=node('div');row.className='style-saved-row-header';thumbnail.className='style-saved-thumbnail';
    const edit=button('Edit pattern'),editPoint=button('Edit point symbol'), duplicate=button('Duplicate'), remove=button('Delete'), restore=button('Restore');
    const confirmation=node('div');confirmation.className='style-delete-confirm';confirmation.hidden=true;
    const confirmDelete=button('Confirm delete'), cancelDelete=button('Cancel');
    confirmation.append(node('span','Delete this style from the library? Existing maps keep their saved versions.'),confirmDelete,cancelDelete);
    const showSaved=updated=>{
      heading.textContent=`${updated.title} · ${updated.format} · v${updated.versionNumber}${updated.archived?' · deleted':''}`;
      const p=savedPattern(updated),point=savedPointSymbolStyle(updated);
      const pointImage=point?symbologyPreview({title:updated.title,recipe:{kind:'point',style:point}}):null;
      thumbnail.replaceChildren(p?patternImage(p):pointImage??node('span','Definition'));
      edit.hidden=!p||!canUpdate||updated.archived===true;duplicate.hidden=!canUpdate||updated.archived===true;
      editPoint.hidden=!point||Boolean(point.categorySymbols)||!canUpdate||updated.archived===true;
      remove.hidden=!canUpdate||updated.archived===true||typeof adapter.archiveResourceStyle!=='function';
      restore.hidden=!canUpdate||updated.archived!==true||typeof adapter.restoreResourceStyle!=='function';
      if(editing?.id===updated.id&&updated.versionNumber!==editing.versionNumber){needsReview=true;feedback.textContent='A newer style version was saved. Your pattern draft is unchanged; check the latest version before saving.';updateActions();}
      if(editingPoint?.id===updated.id&&updated.versionNumber!==editingPoint.versionNumber){pointNeedsReview=true;pointStatus.textContent='A newer point Style exists. Your draft is unchanged; check the latest version before saving.';updatePointActions();}
    };
    showSaved(style);row.append(thumbnail,heading,edit,editPoint,duplicate,remove,restore);entry.append(row,confirmation);
    const definitionEditor=ResourceStyleVersionEditor({adapter,projectId:scope.projectId,resourceId:scope.resourceId,style,canUpdate:canUpdate&&!style.archived,onStyleChange:showSaved});
    entry.append(definitionEditor);entries.set(style.id,{entry,style,scope});
    edit.addEventListener('click',()=>{
      if(busy)return;
      if(hasStyleDraft()||hasPatternDraft()||needsReview||hasPointDraft()||pointNeedsReview||hasPresetDraft()){feedback.textContent='Save or discard the current draft before editing another style.';return;}
      const p=savedPattern(style);if(!p)return;editing=structuredClone(style);needsReview=false;useLatest.hidden=true;setPattern(p,style.title);baseline=signature();updateActions();title.focus();
    });
    editPoint.addEventListener('click',async()=>{
      if(busy)return;
      if(hasStyleDraft()||hasPatternDraft()||needsReview||hasPointDraft()||pointNeedsReview||hasPresetDraft()){pointStatus.textContent='Save or discard the current draft before editing another Style.';return;}
      const point=savedPointSymbolStyle(style);if(!point||point.categorySymbols)return;
      try{await ensurePointSymbolAssets(point);}catch{pointStatus.textContent='This symbol could not load. Your current Style is unchanged.';return;}
      if(disposed||!canChooseGallery())return;
      editingPoint=structuredClone(style);pointNeedsReview=false;pointUseLatest.hidden=true;pointLatestView.hidden=true;setPoint(point,style.title);pointBaseline=pointSignature();updatePointActions();pointTitle.focus();
    });
    duplicate.addEventListener('click',async()=>{
      if(busy||!canUpdate||hasStyleDraft())return;lock(true);
      try{const created=await adapter.createResourceStyle(scope.projectId,scope.resourceId,{slug:`style-${crypto.randomUUID()}`,title:`${style.title} copy`,format:style.format,definition:style.definition});
        if(disposed)return;if(!matches(created,scope))throw Error('Style identity changed');saved.append(card(created,canUpdate,scope));applyFilter();feedback.textContent='Style copy saved.';
      }catch{feedback.textContent='The copy could not be confirmed. Reload saved styles before trying again.';current=null;}finally{lock(false);}
    });
    remove.addEventListener('click',()=>{if(busy)return;if(hasStyleDraft()||(editing?.id===style.id&&(hasPatternDraft()||needsReview))||(editingPoint?.id===style.id&&(hasPointDraft()||pointNeedsReview))){feedback.textContent='Save or discard the current draft before deleting this style.';return;}confirmation.hidden=false;confirmDelete.focus();});
    cancelDelete.addEventListener('click',()=>{confirmation.hidden=true;remove.focus();});
    const changeArchive=async archived=>{
      if(busy)return;lock(true);
      try{const method=archived?'archiveResourceStyle':'restoreResourceStyle';const updated=await adapter[method](scope.projectId,scope.resourceId,style.id,{expectedVersion:style.versionNumber});
        if(disposed)return;if(!matches(updated,scope)||updated.id!==style.id||updated.versionNumber!==style.versionNumber||updated.archived!==archived)throw Error('Style identity changed');
        Object.assign(style,updated);confirmation.hidden=true;
        if(editing?.id===style.id)startNew();if(editingPoint?.id===style.id)resetPoint();
        const replacement=card(style,canUpdate,scope);entry.replaceWith(replacement);if(archived&&!showDeleted.checked){replacement.remove();entries.delete(style.id);}applyFilter();
        feedback.textContent=archived?'Style deleted from the library. Saved map versions remain available.':'Style restored.';
      }catch(error){feedback.textContent=error?.code==='resource_style_version_conflict'?'A newer version exists. Refresh saved styles before deleting or restoring.':'The change could not be confirmed. Refresh saved styles to check its state.';}finally{lock(false);}
    };
    confirmDelete.addEventListener('click',()=>void changeArchive(true));restore.addEventListener('click',()=>void changeArchive(false));
    return entry;
  }
  async function loadStyles(){
    const ticket=++generation;current=null;updateActions();
    if(!resources.value){saved.replaceChildren();entries.clear();return;}
    const projectId=library.value,resourceId=resources.value;
    try{
      const [styles,capabilities]=await Promise.all([adapter.listResourceStyles(projectId,resourceId,{includeArchived:showDeleted.checked}),adapter.getResourceCapabilities(projectId,resourceId)]);
      if(disposed||ticket!==generation)return;
      current={projectId,resourceId,canUpdate:capabilities.canUpdate};entries.clear();saved.replaceChildren(...styles.map(style=>card(style,current.canUpdate)));applyFilter();updateActions();
      feedback.textContent=styles.length?`${styles.length} saved styles.`:'No saved styles here. Create one in the designer above.';
    }catch{if(!disposed&&ticket===generation)feedback.textContent='Styles could not load. Select the resource again to retry.';}
  }
  resources.addEventListener('change',async()=>{if(blockSelection())return;selectedResource=resources.value;editing=null;needsReview=false;if(editingPoint)resetPoint();void loadStyles();});
  showDeleted.addEventListener('change',()=>{if(busy||hasStyleDraft()||hasPatternDraft()||needsReview||hasPointDraft()||pointNeedsReview||hasPresetDraft()){showDeleted.checked=!showDeleted.checked;feedback.textContent='Save or discard the current draft before changing the list.';return;}void loadStyles();});
  async function savePattern(asCopy=false){
    if(busy||!current?.canUpdate||!title.value.trim()||(!asCopy&&needsReview))return;
    if(hasStyleDraft()||hasPresetDraft()){feedback.textContent='Finish editing or discard the other Style draft before saving a pattern.';return;}
    const scope=current, previous=editing;lock(true);
    try{
      const definition=patternSld(draft(),title.value.trim());
      const style=previous&&!asCopy?await adapter.updateResourceStyle(scope.projectId,scope.resourceId,previous.id,{expectedVersion:previous.versionNumber,format:previous.format,title:title.value.trim(),definition,changeMessage:'Updated in pattern designer'}):await adapter.createResourceStyle(scope.projectId,scope.resourceId,{slug:`pattern-${crypto.randomUUID()}`,title:title.value.trim(),format:'sld_1_1',definition});
      if(disposed)return;if(!matches(style,scope)||style.format!=='sld_1_1'||!savedPattern(style)||(previous&&!asCopy&&(style.id!==previous.id||style.versionNumber!==previous.versionNumber+1)))throw Error('Style version changed');
      const old=entries.get(style.id)?.entry,replacement=card(style,true,scope);if(old)old.replaceWith(replacement);else saved.append(replacement);
      editing=structuredClone(style);baseline=signature();needsReview=false;useLatest.hidden=true;applyFilter();feedback.textContent=`Saved ${style.title} · version ${style.versionNumber}. Existing maps keep their chosen version.`;
    }catch(error){if(previous&&!asCopy){needsReview=true;feedback.textContent=error?.code==='resource_style_version_conflict'?'Someone saved a newer version. Your draft is unchanged. Check the latest version.':'Save could not be confirmed. Your draft is unchanged. Check the latest version before saving again.';}
      else{feedback.textContent='Save could not be confirmed. Your draft is unchanged. Reload saved styles before trying again.';current=null;}
    }finally{lock(false);}
  }
  save.addEventListener('click',()=>void savePattern());copy.addEventListener('click',()=>void savePattern(true));
  let latest=null;
  checkLatest.addEventListener('click',async()=>{
    if(busy||!editing||!current)return;lock(true);latest=null;useLatest.hidden=true;
    try{const records=await adapter.listResourceStyles(current.projectId,current.resourceId,{includeArchived:true});const found=records.find(style=>style.id===editing.id);
      if(!matches(found,current)||found.format!==editing.format||found.versionNumber<editing.versionNumber||found.archived)throw Error('Style unavailable');
      latest=structuredClone(found);useLatest.hidden=false;feedback.textContent=`Saved version ${found.versionNumber}: ${found.title}. Your pattern draft is unchanged. Use this version as the edit base after comparing its saved definition.`;
      const old=entries.get(found.id)?.entry;if(old&&!old.querySelector('.resource-style-version-editor')?.hasUnsavedChanges?.())old.replaceWith(card(found,current.canUpdate));
    }catch{feedback.textContent='The latest version is unavailable or deleted. Your draft is unchanged.';}finally{lock(false);}
  });
  useLatest.addEventListener('click',()=>{if(busy||!latest)return;editing=latest;latest=null;needsReview=false;useLatest.hidden=true;feedback.textContent='Latest version selected as the edit base. Your draft is unchanged; Save changes creates a new version.';updateActions();});

  pointNew.addEventListener('click',()=>{
    if(busy||hasStyleDraft()||hasPointDraft()||pointNeedsReview||hasPresetDraft()){pointStatus.textContent='Save or discard your Style draft before starting a new Style.';return;}resetPoint();
  });
  pointDiscard.addEventListener('click',()=>{
    if(busy)return;
    if(editingPoint){setPoint(savedPointSymbolStyle(editingPoint),editingPoint.title);pointNeedsReview=false;pointUseLatest.hidden=true;pointLatestView.hidden=true;pointBaseline=pointSignature();updatePointActions();}
    else resetPoint();pointStatus.textContent='Unsaved point changes discarded.';
  });
  pointSave.addEventListener('click',async()=>{
    if(busy||!current?.canUpdate||pointNeedsReview||!pointTitle.value.trim())return;
    if(hasStyleDraft()||hasPresetDraft()){pointStatus.textContent='Finish editing or discard the other Style draft before saving point symbols.';return;}
    const scope=current,previous=editingPoint,definition=pointSymbolStyleDefinition(pointDraft(),pointTitle.value.trim());lock(true);
    try{
      const updated=previous?await adapter.updateResourceStyle(scope.projectId,scope.resourceId,previous.id,{expectedVersion:previous.versionNumber,format:'maplibre',title:pointTitle.value.trim(),definition,changeMessage:'Updated point symbols'}):await adapter.createResourceStyle(scope.projectId,scope.resourceId,{slug:`point-${crypto.randomUUID()}`,title:pointTitle.value.trim(),format:'maplibre',definition});
      if(disposed)return;
      if(!matches(updated,scope)||updated.format!=='maplibre'||updated.definition!==definition||!savedPointSymbolStyle(updated)||(previous&&(updated.id!==previous.id||updated.versionNumber!==previous.versionNumber+1)))throw Error('Style identity changed');
      const old=entries.get(updated.id)?.entry,replacement=card(updated,true,scope);if(old)old.replaceWith(replacement);else saved.append(replacement);
      editingPoint=structuredClone(updated);pointBaseline=pointSignature();pointNeedsReview=false;pointUseLatest.hidden=true;pointLatestView.hidden=true;applyFilter();pointStatus.textContent=`Saved ${updated.title} · version ${updated.versionNumber}. Existing maps keep their chosen version.`;
    }catch(error){
      if(previous){pointNeedsReview=true;pointStatus.textContent=error?.code==='resource_style_version_conflict'?'Someone saved a newer point Style. Your draft is unchanged. Check the latest version.':'The save could not be confirmed. Your draft is unchanged; check the latest version before saving again.';}
      else{current=null;pointStatus.textContent='The save could not be confirmed. Your draft is unchanged; reload the resource before trying again.';}
    }finally{lock(false);}
  });
  pointCheck.addEventListener('click',async()=>{
    if(busy||!editingPoint||!current)return;lock(true);pointLatest=null;pointUseLatest.hidden=true;pointLatestView.hidden=true;
    try{
      const records=await adapter.listResourceStyles(current.projectId,current.resourceId,{includeArchived:true}),found=records.find(item=>item.id===editingPoint.id);
      const point=savedPointSymbolStyle(found);
      if(!matches(found,current)||found.format!=='maplibre'||found.versionNumber<editingPoint.versionNumber||found.archived||!point||point.categorySymbols)throw Error('Style unavailable');
      pointLatest=structuredClone(found);pointLatestView.textContent=`Version ${found.versionNumber}: ${found.title}\n\n${found.definition}`;pointLatestView.hidden=false;pointUseLatest.hidden=false;pointStatus.textContent=`Saved version ${found.versionNumber}: ${found.title}. Review its saved definition below. Your point draft is unchanged.`;
    }catch{pointStatus.textContent='The latest point Style is unavailable. Your draft and edit base are unchanged.';}finally{lock(false);}
  });
  pointUseLatest.addEventListener('click',()=>{
    if(busy||!pointLatest)return;editingPoint=pointLatest;pointLatest=null;pointNeedsReview=false;pointUseLatest.hidden=true;pointStatus.textContent='Latest version selected as the edit base. Your point draft is unchanged; Save point changes creates a new version.';updatePointActions();
  });

  return root;
}
