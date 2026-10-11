/* ══════════════════════════════════════════════════════════════
   SPROG – oversætter portalen til engelsk i browseren (okt. 2026).
   Indlæses kun, når brugeren har valgt engelsk. Ordbogen (i18n-en.json)
   er lavet ud fra alle tekster i admin.html/employee.html og ligger
   foran denne kode som window.__I18N_DICT. Teksterne skiftes ud, idet
   siden tegnes (MutationObserver), så der ikke rettes i selve koden.
   Data, som brugerne selv skriver (noter, navne, adresser, felter),
   oversættes ikke: kun tekster, der står i ordbogen, skiftes ud.
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";
var D=window.__I18N_DICT||{};
var EDGE=/^([\s"'·•–—:(),→|\/«»▾▴▸►]*)([\s\S]*?)([\s"'·•–—:(),→|\/«»▾▴▸►]*)$/;
var SPLIT=/(\s*[·•|–—:()\/"«»→▾▸]\s*|\s+\d[\d.,:\/%-]*\s*|^\d[\d.,:\/%-]*\s*)/;
var cache=Object.create(null);
var VALS=Object.create(null);for(var _k in D){var _v=D[_k];if(_v!==_k)VALS[_v]=1;}
var DA=/[æøåÆØÅ]|\b(og|i|på|til|med|af|for|er|det|den|der|som|en|et|ikke|skal|kan|har|fra|ved|om|men|eller|at|de|vi|jeg|du|nye?|alle)\b/i;
function look(k){
  if(!k)return null;
  var v=D[k];if(v!==undefined)return v;
  // Prøv uden afsluttende ? . ! … og uden emoji foran
  var m=k.match(/^(.*?)([?.!…]+)$/);if(m&&D[m[1]]!==undefined)return D[m[1]]+m[2];
  var e=k.match(/^([←-⯿\uD83C-􏰀-\uDFFF️‍\s]+)(.+)$/);if(e&&D[e[2]]!==undefined)return e[1]+D[e[2]];
  return null;
}
function tr(t){
  if(!t||t.length>1500)return null;
  if(!/[A-Za-zÆØÅæøå]/.test(t))return null;
  if(t in cache)return cache[t];
  if(VALS[t.trim()]){cache[t]=null;return null;} // allerede engelsk (undgå dobbelt-oversættelse)
  var out=null,m=t.match(EDGE);
  if(m){var v=look(m[2]);if(v!=null)out=m[1]+v+m[3];}
  if(out==null&&t.length<=400){
    var parts=t.split(SPLIT),hit=false,rest=false;
    for(var i=0;i<parts.length;i++){var p=parts[i];if(!p||!/[A-Za-zÆØÅæøå]{2}/.test(p))continue;var pm=p.match(EDGE);var pv=pm&&look(pm[2]);if(pv!=null){parts[i]=pm[1]+pv+pm[3];hit=true;}else if(DA.test(p))rest=true;}
    // Kun hvis resten ikke ligner dansk (fx navne og tal) – ellers er det brugerens egen tekst
    if(rest)hit=false;
    if(hit)out=parts.join('');
  }
  cache[t]=out;return out;
}
window.abT=function(s){var r=tr(String(s==null?'':s));return r==null?s:r;};
var SKIP='script,style,textarea,code,pre,[contenteditable=""],[contenteditable="true"],[data-no-i18n],.ql-editor,.ask-a,.ask-q,.crmpx-note-body';
var done=new WeakMap();
function skip(el){try{return !!(el&&el.closest&&el.closest(SKIP));}catch(e){return false;}}
function doText(n){
  var p=n.parentNode;if(!p||p.nodeType!==1||skip(p))return;
  var cur=n.data;if(done.get(n)===cur)return;
  var r=tr(cur);if(r!=null&&r!==cur){done.set(n,r);n.data=r;}else done.set(n,cur);
}
var ATTRS=['placeholder','title','aria-label','data-tip'];
function doAttrs(el){
  if(skip(el))return;
  for(var i=0;i<ATTRS.length;i++){var a=ATTRS[i];if(el.hasAttribute&&el.hasAttribute(a)){var v=el.getAttribute(a),r=tr(v);if(r!=null&&r!==v)el.setAttribute(a,r);}}
  if(el.tagName==='INPUT'&&/^(button|submit|reset)$/i.test(el.type)){var vv=el.value,rv=tr(vv);if(rv!=null&&rv!==vv)el.value=rv;}
}
var FILT={acceptNode:function(n){if(n.nodeType===1)return (n.matches&&n.matches(SKIP))?2:1;return 1;}};
function walk(root){
  if(!root)return;
  if(root.nodeType===3){doText(root);return;}
  if(root.nodeType!==1&&root.nodeType!==11&&root.nodeType!==9)return;
  if(root.nodeType===1){if(skip(root))return;doAttrs(root);}
  var w=document.createTreeWalker(root,5,FILT),n;
  while((n=w.nextNode())){if(n.nodeType===3){var p=n.parentNode;var cur=n.data;if(done.get(n)===cur)continue;var r=tr(cur);if(r!=null&&r!==cur){done.set(n,r);n.data=r;}else done.set(n,cur);}else doAttrs(n);}
}
var mo=new MutationObserver(function(list){
  for(var i=0;i<list.length;i++){var m=list[i];
    if(m.type==='childList'){for(var j=0;j<m.addedNodes.length;j++)walk(m.addedNodes[j]);}
    else if(m.type==='characterData')doText(m.target);
    else if(m.type==='attributes'&&m.target.nodeType===1)doAttrs(m.target);
  }
});
mo.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:ATTRS.concat(['value'])});
walk(document.documentElement);
// Titel, dialogbokse og datoer
document.documentElement.lang='en';
var oa=window.alert,oc=window.confirm,op=window.prompt;
window.alert=function(m){return oa.call(window,window.abT(m));};
window.confirm=function(m){return oc.call(window,window.abT(m));};
window.prompt=function(m,d){return op.call(window,window.abT(m),d);};
function loc(l){return (typeof l==='string'&&/^da/i.test(l))||(Array.isArray(l)&&/^da/i.test(l[0]))?'en-GB':l;}
['toLocaleDateString','toLocaleTimeString','toLocaleString'].forEach(function(f){var o=Date.prototype[f];Date.prototype[f]=function(l,opt){return o.call(this,loc(l),opt);};});
try{var ODF=Intl.DateTimeFormat;var NDF=function(l,o){return new ODF(loc(l),o);};NDF.prototype=ODF.prototype;NDF.supportedLocalesOf=ODF.supportedLocalesOf;Intl.DateTimeFormat=NDF;}catch(e){}
var t0=setInterval(function(){var t=document.title,r=tr(t);if(r!=null&&r!==t)document.title=r;},1500);
})();
