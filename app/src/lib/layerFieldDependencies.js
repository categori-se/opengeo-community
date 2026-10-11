// Compare only dependencies this renderer can identify; unknown expressions block replacement.
export function layerFieldCompatibility(layer, schema, renderedParts = []) {
  const issues=[], dependencies=new Map();
  const use=(field,role,numeric=false)=>{
    if(typeof field!=="string" || !field) {issues.push(`Unresolved ${role} field.`);return;}
    const values=dependencies.get(field)??[];values.push({role,numeric});dependencies.set(field,values);
  };
  const style=layer.style??{};
  if(!layer.styleReference) {
    if(style.renderer==="category")use(style.categoryField,"category Style");
    if(style.renderer==="graduated")use(style.graduated?.field,"graduated Style",true);
    if(style.renderer==="status")use("status","status Style");
  }
  if(layer.labels?.enabled)use(layer.labels.field,"label");
  const expression=(value,role,legacy=false)=>{
    if(!Array.isArray(value))return;
    const [op,...args]=value;
    if(op==="literal")return;
    if(op==="get"||op==="has"){
      if(args.length!==1 || typeof args[0]!=="string") issues.push(`Unresolved ${role} expression.`);
      else use(args[0],role);
      return;
    }
    if(legacy && ["==","!=","<",">","<=",">=","in","!in","!has"].includes(op) && typeof args[0]==="string"){
      if(!args[0].startsWith("$"))use(args[0],role);
      return;
    }
    if(op==="properties")issues.push(`Unresolved ${role} property access.`);
    for(const arg of args)expression(arg,role,legacy);
  };
  expression(layer.filter,"filter",true);
  for(const part of renderedParts) {
    expression(part.filter,"filter",true);
    for(const value of Object.values(part.paint??{}))expression(value,"rendered Style");
    for(const value of Object.values(part.layout??{}))expression(value,"rendered label");
  }
  if(layer.styleReference && !renderedParts.length)issues.push("The pinned Style has not resolved.");
  const layers=schema?.layers;
  const fields=Array.isArray(layers)&&layers.length===1 ? layers[0]?.fields : null;
  if(!Array.isArray(fields) || fields.some(f=>typeof f?.name!=="string"||!f.name)
    || new Set(fields.map(f=>f.name)).size!==fields.length) {
    issues.push("A single unambiguous candidate field schema is unavailable.");
  }else{
    const known=new Map(fields.map(f=>[f.name,f]));
    for(const [name,uses] of dependencies) {
      if(!known.has(name))issues.push(`Missing field “${name}” used by ${[...new Set(uses.map(u=>u.role))].join(", ")}.`);
      else if(uses.some(u=>u.numeric) && !["Integer","Integer64","Real","Float","Double"].includes(known.get(name).type))
        issues.push(`Field “${name}” is not recorded as numeric for its graduated Style.`);
    }
  }
  return {compatible:!issues.length,issues:[...new Set(issues)],fields:[...dependencies.keys()]};
}
