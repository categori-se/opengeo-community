import {validateMapFilter} from "../lib/mapFilter.js";
export function MapFilterEditor({layer,fields,onApply}){
 const root=el("section");root.append(el("h3","Map filter"),el("p","Filter this Layer's displayed features. Save the Project to retain the filter; source data is unchanged. Numeric comparisons require number values; text is not converted. Imported advanced filters may be unsupported."));
 const field=select("Filter field",fields.map(v=>[v,v]));
 const op=select("Filter operator",[["==","Equals"],["!=","Does not equal"],[">","Greater than"],["<","Less than"],[">=","At least"],["<=","At most"],["in","Is one of"],["not_in","Is not one of"]]);
 const type=select("Filter value type",[["string","Text"],["number","Number"],["boolean","Boolean"],["null","Null"]]);
 const value=el("textarea");value.rows=1;value.setAttribute("aria-label","Filter value");
 const label=el("label","Filter value");label.append(value);root.append(label);
 const hint=el("p");root.append(hint);
 op.onchange=()=>{const list=["in","not_in"].includes(op.value);value.rows=list?3:1;hint.textContent=list?"Enter one value per line, up to 64 values. Choose Text or Number; all values use the same type.":"";};
 const current=el("pre",JSON.stringify(layer.filter??null,null,2)),status=el("p");status.setAttribute("role","status");
 const apply=el("button","Apply map filter");apply.type="button";
 apply.onclick=()=>{
  try{
   if(!field.value)throw Error("Choose an available field.");
   const list=["in","not_in"].includes(op.value);
   if(list){
    if(!["string","number"].includes(type.value))throw Error("Lists support Text or Number values.");
    const values=value.value.split(/\r?\n/);
    if(values.some(v=>type.value==="number"?!v.trim():!v))throw Error("Enter one value per line without empty lines.");
    const items=type.value==="number"?values.map(v=>Number(v)):values;
    const membership=["in",["get",field.value],["literal",items]];
    const filter=validateMapFilter(op.value==="not_in"?["!",membership]:membership);
    onApply(filter);current.textContent=JSON.stringify(filter,null,2);status.textContent="Filter applied to this draft. Save the Project to retain it.";return;
   }
   let scalar=value.value;
   if(type.value==="number"){if(!scalar.trim()||!Number.isFinite(Number(scalar)))throw Error("Enter a finite number.");scalar=Number(scalar);}
   if(type.value==="boolean"){if(!["true","false"].includes(scalar))throw Error("Enter true or false.");scalar=scalar==="true";}
   if(type.value==="null")scalar=null;
   const filter=validateMapFilter([op.value,["get",field.value],scalar]);
   onApply(filter);current.textContent=JSON.stringify(filter,null,2);status.textContent="Filter applied to this draft. Save the Project to retain it.";
  }catch(error){status.textContent=error.message;}
 };
 const clear=el("button","Clear map filter");clear.type="button";clear.onclick=()=>{onApply(null);current.textContent="null";status.textContent="Filter cleared in this draft."};
 const saved=layer.filter;
 if(saved){
  let expression=saved,operation=saved[0];
  if(operation==="!"&&saved[1]?.[0]==="in"){expression=saved[1];operation="not_in";}
  const name=typeof expression[1]==="string"?expression[1]:expression[1]?.[0]==="get"?expression[1][1]:null;
  const list=["in","not_in"].includes(operation);
  const raw=expression[2],items=list&&raw?.[0]==="literal"?raw[1]:null;
  const editable=fields.includes(name)&&[...op.options].some(o=>o.value===operation)
   &&(!list||(Array.isArray(items)&&items.length>0&&items.every(v=>typeof v!=="string"||(v.length>0&&!/[\r\n]/.test(v)))));
  if(editable){
   field.value=name;op.value=operation;
   const scalar=list?items[0]:raw;type.value=scalar===null?"null":typeof scalar;
   value.value=list?items.join("\n"):scalar===null?"":String(scalar);op.onchange();
  }else{
   status.textContent="The saved filter is retained below. Applying these controls will replace it.";
   apply.textContent="Replace map filter";
  }
 }
 root.append(current,apply,clear,status);return root;
 function select(title,values){const wrapper=el("label",title),input=el("select");input.setAttribute("aria-label",title);for(const [v,t]of values){const o=el("option",t);o.value=v;input.append(o);}wrapper.append(input);root.append(wrapper);return input;}
}
function el(tag,text=""){const node=document.createElement(tag);node.textContent=text;return node;}
