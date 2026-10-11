/* SPROG – vælg dansk/engelsk (okt. 2026). Indlæses på alle interne sider.
   Valget gemmes i browseren og på brugeren, så det følger med på tværs af enheder. */
(function(){
"use strict";
var KEY='ab_lang';
function get(){try{return localStorage.getItem(KEY)==='en'?'en':'da';}catch(e){return 'da';}}
function tok(){try{return localStorage.getItem('gm_token');}catch(e){return null;}}
function set(l,save){
  try{localStorage.setItem(KEY,l);}catch(e){}
  var t=tok();
  var go=function(){location.reload();};
  if(save&&t)fetch('/api/me/lang',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+t},body:JSON.stringify({lang:l})}).then(go,go);else go();
}
window.abSetLang=function(l){set(l==='en'?'en':'da',true);};
window.abLang=get;
var st=document.createElement('style');
st.textContent='.ab-lang{display:inline-flex;border:1px solid rgba(0,0,0,.12);border-radius:999px;overflow:hidden;background:#fff;font:700 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;flex:none;margin-left:6px;vertical-align:middle}.ab-lang button{border:0;background:none;padding:6px 9px;cursor:pointer;color:#6B6259;font:inherit;letter-spacing:.04em}.ab-lang button.on{background:#241F1A;color:#fff}.topbar-actions .ab-lang{align-self:flex-start;margin:6px 0 2px}.ab-lang.fixed{position:fixed;top:14px;right:14px;z-index:50;box-shadow:0 2px 8px rgba(0,0,0,.08)}';
document.head.appendChild(st);
function make(fixed){var w=document.createElement('div');w.className='ab-lang'+(fixed?' fixed':'');w.setAttribute('data-no-i18n','');w.title='Sprog / Language';var cur=get();
  w.innerHTML='<button type="button" data-l="da" class="'+(cur==='da'?'on':'')+'">DA</button><button type="button" data-l="en" class="'+(cur==='en'?'on':'')+'">EN</button>';
  w.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||b.dataset.l===get())return;set(b.dataset.l,true);});return w;}
function place(){
  if(document.querySelector('.ab-lang'))return true;
  var host=document.querySelector('.nav .nav-left')||document.querySelector('#topbar-actions');
  if(host){host.appendChild(make(false));return true;}
  if(document.body&&/^\/(index\.html|set-password|login)?$/.test(location.pathname)){document.body.appendChild(make(true));return true;}
  return false;
}
function boot(){var n=0;var iv=setInterval(function(){if(place()||++n>40)clearInterval(iv);},250);place();
  // Følg brugerens gemte valg (fx hvis det er skiftet på en anden enhed)
  var t=tok();if(!t)return;
  try{if(sessionStorage.getItem('ab_lang_synced'))return;sessionStorage.setItem('ab_lang_synced','1');}catch(e){}
  fetch('/api/me/lang',{headers:{Authorization:'Bearer '+t}}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(d&&(d.lang==='da'||d.lang==='en')&&d.lang!==get()){try{localStorage.setItem(KEY,d.lang);}catch(e){}location.reload();}
  }).catch(function(){});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);else boot();
})();
