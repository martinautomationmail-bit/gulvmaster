/* ══════════════════════════════════════════════════════════════
   NOTER — Notion-lignende noteprogram under Videnscenter (overført fra
   Arkitekt & Boligrenovering-portalen, nov. 2026). Gulv Master-tilføjelse:
   admin ser medarbejdernes private sider under "👀 Medarbejdernes sider".
   Indsættes i admin.html's hovedscript (bruger api/esc/toast/me/
   navPushHash derfra). Server: notes.js.

   Indholdet er en liste af blokke. Lister/toggles bruger "indent" (som
   Notion visuelt), kolonner er en blok med cols:[[blokke],[blokke]].
   Hele noteprogrammet er markeret data-no-i18n og styrer selv dansk/
   engelsk via L(), så brugerens tekst aldrig bliver "oversat" i farten.
   ══════════════════════════════════════════════════════════════ */
(function(){
"use strict";
var EN=false;try{EN=localStorage.getItem('ab_lang')==='en';}catch(e){}
function L(da,en){return EN?en:da;}
var MAC=/Mac|iPhone|iPad/.test(navigator.platform||'');
var MOD=MAC?'⌘':'Ctrl+';
var S={built:false,tree:[],byId:{},kids:{},fav:[],people:null,page:null,pending:{},saveT:null,saving:false,again:false,
  undo:[],redo:[],snap:'',snapT:null,sel:[],exp:{},drag:null,tdrag:null,menu:null,lastColor:null,routeKey:''};
try{S.exp=JSON.parse(localStorage.getItem('nt_exp')||'{}')||{};}catch(e){}
function $(s,r){return (r||document).querySelector(s);}
function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));}
function uid(){return Math.random().toString(36).slice(2,8)+Date.now().toString(36).slice(-4);}
function H(s){return esc(s);}
function clone(o){return JSON.parse(JSON.stringify(o));}
function cssUrl(u){return 'url(&quot;'+H(String(u||'').replace(/["\\\n\r]/g,function(c){return encodeURIComponent(c);}))+'&quot;)';}
function plain(html){var d=document.createElement('div');d.innerHTML=html||'';return d.textContent||'';}
function fmtSize(n){n=+n||0;return n>1048576?(n/1048576).toFixed(1)+' MB':n>1024?Math.round(n/1024)+' KB':n+' B';}
var MON_DA=['jan.','feb.','mar.','apr.','maj','jun.','jul.','aug.','sep.','okt.','nov.','dec.'],MON_EN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(d){d=new Date(d);if(isNaN(d))return '';return EN?(MON_EN[d.getMonth()]+' '+d.getDate()+', '+d.getFullYear()):(d.getDate()+'. '+MON_DA[d.getMonth()]+' '+d.getFullYear());}
function fmtDT(d){d=new Date(d);if(isNaN(d))return '';return fmtDate(d)+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
function rel(ts){var d=new Date(ts),s=(Date.now()-d)/1000;if(isNaN(s))return '';if(s<60)return L('lige nu','just now');if(s<3600)return Math.floor(s/60)+L(' min. siden',' min ago');if(s<86400)return Math.floor(s/3600)+L(' t. siden','h ago');if(s<86400*7)return Math.floor(s/86400)+L(' d. siden','d ago');return fmtDate(d);}
function isoLocal(d){d=new Date(d);var p=function(n){return String(n).padStart(2,'0');};return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());}
function ymd(d){return isoLocal(d).slice(0,10);}

// ── konstanter ──────────────────────────────────────────────
var TXT={p:1,h1:1,h2:1,h3:1,bullet:1,num:1,todo:1,toggle:1,th1:1,th2:1,th3:1,quote:1,callout:1,remind:1};
function isTxt(t){return !!TXT[t];}
function isTog(t){return t==='toggle'||t==='th1'||t==='th2'||t==='th3';}
var COLORS=[['',L('Standard','Default')],['gray',L('Grå','Gray')],['brown',L('Brun','Brown')],['orange','Orange'],['yellow',L('Gul','Yellow')],['green',L('Grøn','Green')],['blue',L('Blå','Blue')],['purple',L('Lilla','Purple')],['pink',L('Pink','Pink')],['red',L('Rød','Red')]];
var GRADS={sunset:'linear-gradient(135deg,#f6d365,#fda085)',terracotta:'linear-gradient(135deg,#e8a87c,#b2552a)',sand:'linear-gradient(135deg,#f5ede1,#d9c3a5)',ocean:'linear-gradient(135deg,#89f7fe,#66a6ff)',forest:'linear-gradient(135deg,#a8e063,#56ab2f)',night:'linear-gradient(135deg,#232526,#414345)',rose:'linear-gradient(135deg,#fbc2eb,#a6c1ee)',sky:'linear-gradient(135deg,#e0eafc,#cfdef3)',mint:'linear-gradient(135deg,#d4fc79,#96e6a1)',peach:'linear-gradient(135deg,#ffecd2,#fcb69f)',dusk:'linear-gradient(135deg,#355c7d,#6c5b7b,#c06c84)',stone:'linear-gradient(135deg,#d7d2cc,#304352)',blueprint:'linear-gradient(0deg,rgba(255,255,255,.08) 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,rgba(255,255,255,.08) 1px,transparent 1px) 0 0/24px 24px,#1f4e79',paper:'linear-gradient(0deg,rgba(0,0,0,.04) 1px,transparent 1px) 0 0/100% 28px,#faf6ee',olive:'linear-gradient(135deg,#c9d6a3,#6b7f3a)',clay:'linear-gradient(135deg,#f3d9c4,#c97b5a,#8c4a2f)'};
function coverCss(u,pos){if(!u)return '';if(/^gradient:/.test(u))return 'background:'+(GRADS[u.slice(9)]||GRADS.sand);return 'background-image:'+cssUrl(u)+';background-size:cover;background-position:center '+(pos==null?50:pos)+'%';}
var EMOJI={
  [L('Arbejde','Work')]:'📝 📄 📑 📋 📌 📍 📎 🗂️ 📁 📂 🗃️ 📊 📈 📉 🗓️ 📅 ⏰ ⏱️ ✅ ☑️ ✔️ ❗ ❓ 💡 🔔 📣 💬 🗨️ 📞 ✉️ 📧 📦 🏷️ 🔖 🧾 💰 💳 🧮 🔑 🔒 🔓 🛠️ 🔧 🔨 ⚙️ 🧰 🎯 🚀 🏆 🎓 📚 📖 ✏️ 🖊️ 🖌️ 🖍️ 📐 📏 🧭 🗺️',
  [L('Byggeri og bolig','Building & home')]:'🏠 🏡 🏘️ 🏢 🏗️ 🧱 🪵 🪟 🚪 🛁 🚿 🚽 🛋️ 🛏️ 🪑 🍳 🔌 💡 🪜 🧹 🎨 🖼️ 🪴 🌳 🏛️ 🏭 🚧 ⚠️ 🔥 💧 ❄️ ☀️ 🌧️ 🚚 🚐 🧯 🦺 ⛑️ 🔩 🪛 🪚 🧲 🧪 📷 🎥',
  [L('Smileys og folk','Smileys & people')]:'😀 😃 😄 😁 😊 🙂 😉 😍 🤩 😎 🤓 🧐 🤔 😅 😂 🙃 😴 😬 😮 😢 😡 🤯 🥳 👋 👍 👎 👏 🙌 🙏 💪 ✌️ 🤝 👀 🧠 👤 👥 👷 🧑‍💼 🧑‍🔧 🧑‍🎨 🧑‍💻',
  [L('Natur og ting','Nature & things')]:'🌱 🌿 🍀 🌸 🌻 🌲 🍂 🌊 ⛰️ 🌙 ⭐ 🌈 ⚡ 🍎 🍋 🍕 ☕ 🍰 🎉 🎁 🎈 🧩 🎵 🎧 📱 💻 🖥️ ⌨️ 🖨️ 🕹️ ⚽ 🚗 ✈️ 🚲 🏖️ 🌍',
  [L('Symboler','Symbols')]:'❤️ 🧡 💛 💚 💙 💜 🖤 🤍 ⭐ ✨ 💥 💯 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟧 🟨 🟩 🟦 🟪 ➡️ ⬅️ ⬆️ ⬇️ 🔄 ➕ ➖ ✖️ ♻️ ⛔ 🚫 ℹ️ 🆕 🆗 🔝'
};
var ALL_EMOJI=Object.keys(EMOJI).reduce(function(a,k){return a.concat(EMOJI[k].split(' '));},[]);

// Slash-menuen. k=nøgle, i=ikon, t=titel, d=beskrivelse, w=søgeord
var SLASH=[
  {g:L('Grundblokke','Basic blocks'),items:[
    {k:'p',i:'Aa',t:L('Tekst','Text'),d:L('Almindelig tekst','Just start writing'),w:'text tekst paragraph afsnit'},
    {k:'page',i:'📄',t:L('Side','Page'),d:L('Ny underside i denne side','Embed a sub-page'),w:'page side underside'},
    {k:'h1',i:'H1',t:L('Overskrift 1','Heading 1'),d:L('Stor overskrift','Big section heading'),w:'h1 heading overskrift title'},
    {k:'h2',i:'H2',t:L('Overskrift 2','Heading 2'),d:L('Mellem overskrift','Medium heading'),w:'h2 heading overskrift'},
    {k:'h3',i:'H3',t:L('Overskrift 3','Heading 3'),d:L('Lille overskrift','Small heading'),w:'h3 heading overskrift'},
    {k:'bullet',i:'•',t:L('Punktliste','Bulleted list'),d:L('Simpel punktopstilling','A simple bulleted list'),w:'bullet liste punkt list ul'},
    {k:'num',i:'1.',t:L('Nummereret liste','Numbered list'),d:L('Liste med tal','A list with numbering'),w:'num nummer numbered liste ol'},
    {k:'todo',i:'☑',t:L('To-do-liste','To-do list'),d:L('Opgaver med afkrydsning','Track tasks with checkboxes'),w:'todo to-do opgave check tjekliste checkbox'},
    {k:'toggle',i:'▸',t:L('Toggle-liste','Toggle list'),d:L('Indhold der kan foldes ud','Toggles can hide content'),w:'toggle fold skjul collapse'},
    {k:'th1',i:'▸H1',t:L('Toggle-overskrift 1','Toggle heading 1'),d:L('Overskrift der kan foldes ud','Collapsible heading'),w:'toggle heading overskrift'},
    {k:'th2',i:'▸H2',t:L('Toggle-overskrift 2','Toggle heading 2'),d:L('Overskrift der kan foldes ud','Collapsible heading'),w:'toggle heading overskrift'},
    {k:'th3',i:'▸H3',t:L('Toggle-overskrift 3','Toggle heading 3'),d:L('Overskrift der kan foldes ud','Collapsible heading'),w:'toggle heading overskrift'},
    {k:'quote',i:'❝',t:L('Citat','Quote'),d:L('Fremhæv et citat','Capture a quote'),w:'quote citat'},
    {k:'callout',i:'💡',t:L('Fremhævet boks','Callout'),d:L('Boks med ikon der skiller sig ud','Make writing stand out'),w:'callout boks fremhæv info vigtigt note'},
    {k:'divider',i:'—',t:L('Skillelinje','Divider'),d:L('Del siden op','Visually divide blocks'),w:'divider div linje hr skille'},
    {k:'table',i:'▦',t:L('Tabel','Table'),d:L('Simpel tabel','Add a simple table'),w:'table tabel'},
    {k:'link',i:'↗',t:L('Link til side','Link to page'),d:L('Henvis til en anden side','Link to an existing page'),w:'link side page henvis'}
  ]},
  {g:L('Medier','Media'),items:[
    {k:'image',i:'🖼',t:L('Billede','Image'),d:L('Upload eller indsæt link','Upload or embed with a link'),w:'image billede foto picture img'},
    {k:'video',i:'🎬',t:'Video',d:L('Upload eller YouTube/Vimeo/Loom','Upload or YouTube/Vimeo/Loom'),w:'video film'},
    {k:'audio',i:'🎧',t:L('Lyd','Audio'),d:L('Lydfil eller optagelse','Upload an audio file'),w:'audio lyd mp3 optagelse'},
    {k:'file',i:'📎',t:L('Fil','File'),d:L('Vedhæft en fil','Upload any file'),w:'file fil vedhæft attachment'},
    {k:'pdf',i:'📕',t:'PDF',d:L('Vis en PDF på siden','Display a PDF'),w:'pdf'},
    {k:'bookmark',i:'🔖',t:L('Link-kort','Web bookmark'),d:L('Visuelt kort for et link','Visual link preview'),w:'bookmark bogmærke link kort url web'},
    {k:'code',i:'</>',t:L('Kode','Code'),d:L('Kodeblok','Capture a code snippet'),w:'code kode snippet'}
  ]},
  {g:L('Indlejr','Embeds'),items:[
    {k:'embed',i:'🧩',t:L('Indlejr','Embed'),d:L('Indlejr en hjemmeside','Embed any website'),w:'embed indlejr iframe'},
    {k:'youtube',i:'▶️',t:'YouTube',d:L('Indlejr en YouTube-video','Embed a YouTube video'),w:'youtube video'},
    {k:'maps',i:'🗺️',t:'Google Maps',d:L('Kort over en adresse','Map of an address'),w:'maps kort google adresse map'},
    {k:'drive',i:'🟢',t:'Google Drive',d:L('Doc, Sheet, Slides eller fil','Doc, Sheet, Slides or file'),w:'drive google docs sheets slides'},
    {k:'loom',i:'🎥',t:'Loom',d:L('Indlejr en Loom-optagelse','Embed a Loom video'),w:'loom video optagelse'},
    {k:'figma',i:'🎨',t:'Figma',d:L('Indlejr et Figma-design','Embed a Figma file'),w:'figma design'}
  ]},
  {g:L('Opsætning','Layout'),items:[
    {k:'col2',i:'⫼',t:L('2 kolonner','2 columns'),d:L('Del op i to kolonner','Create 2 columns'),w:'kolonner columns 2'},
    {k:'col3',i:'⫼',t:L('3 kolonner','3 columns'),d:L('Del op i tre kolonner','Create 3 columns'),w:'kolonner columns 3'},
    {k:'col4',i:'⫼',t:L('4 kolonner','4 columns'),d:L('Del op i fire kolonner','Create 4 columns'),w:'kolonner columns 4'},
    {k:'tabs',i:'🗂',t:L('Faner','Tabs'),d:L('Organisér indhold i faner','Organize content in tabs'),w:'faner fane tabs tab organiser'},
    {k:'toc',i:'☰',t:L('Indholdsfortegnelse','Table of contents'),d:L('Viser sidens overskrifter','Show an outline of the page'),w:'toc indhold indholdsfortegnelse contents'}
  ]},
  {g:L('Indsæt i teksten','Inline'),items:[
    {k:'mention',i:'@',t:L('Nævn en person eller side','Mention a person or page'),d:L('Giver kollegaen besked','Notifies your colleague'),w:'mention nævn person @ side'},
    {k:'date',i:'📅',t:L('Dato','Date'),d:L('Indsæt dags dato','Insert a date'),w:'date dato idag today'},
    {k:'remind',i:'🔔',t:L('Påmindelse','Reminder'),d:L('Få besked på et bestemt tidspunkt','Get notified at a set time'),w:'remind påmindelse husk alarm reminder'},
    {k:'emoji',i:'😀',t:'Emoji',d:L('Indsæt en emoji','Insert an emoji'),w:'emoji smiley ikon'}
  ]},
  {g:'AI',items:[
    {k:'ai',i:'✨',t:L('Bed AI om at skrive','Ask AI to write'),d:L('Skriv et udkast ud fra en instruks','Draft from a prompt'),w:'ai skriv write udkast claude'},
    {k:'ai-sum',i:'✨',t:L('Opsummér siden','Summarize page'),d:L('Kort opsummering af indholdet','Short summary of this page'),w:'ai opsummer summary resume'},
    {k:'ai-todo',i:'✨',t:L('Find opgaver','Find action items'),d:L('Laver to-dos ud fra siden','Turn the page into to-dos'),w:'ai opgaver todo action'},
    {k:'ai-cont',i:'✨',t:L('Fortsæt med at skrive','Continue writing'),d:L('AI skriver videre','AI continues the text'),w:'ai fortsæt continue'}
  ]},
  {g:L('Farver','Colors'),items:COLORS.slice(1).map(function(c){return {k:'c:'+c[0],i:'<span class="nt-sw nt-c-'+c[0]+'">A</span>',t:c[1],d:L('Tekstfarve','Text color'),w:'farve color tekst '+c[0]+' '+c[1].toLowerCase()};}).concat(COLORS.slice(1).map(function(c){return {k:'bg:'+c[0],i:'<span class="nt-sw nt-bg-'+c[0]+'">A</span>',t:c[1]+' '+L('baggrund','background'),d:L('Baggrundsfarve','Background color'),w:'baggrund background farve '+c[0]+' '+c[1].toLowerCase()};}))},
  {g:L('Handlinger','Actions'),items:[
    {k:'turn',i:'↻',t:L('Lav om til…','Turn into…'),d:L('Skift bloktype','Change block type'),w:'turn lav om skift convert'},
    {k:'dup',i:'⧉',t:L('Duplikér','Duplicate'),d:MOD+'D',w:'duplicate dupliker kopi'},
    {k:'del',i:'🗑',t:L('Slet','Delete'),d:L('Fjern blokken','Delete block'),w:'delete slet fjern'},
    {k:'up',i:'↑',t:L('Flyt op','Move up'),d:MOD+'⇧↑',w:'move flyt op'},
    {k:'down',i:'↓',t:L('Flyt ned','Move down'),d:MOD+'⇧↓',w:'move flyt ned'},
    {k:'comment',i:'💬',t:L('Kommentér','Comment'),d:L('Skriv en kommentar til siden','Comment on this page'),w:'comment kommentar'}
  ]}
];
var TURN=['p','h1','h2','h3','bullet','num','todo','toggle','th1','th2','th3','quote','callout','code'];
function slashItem(k){for(var i=0;i<SLASH.length;i++)for(var j=0;j<SLASH[i].items.length;j++)if(SLASH[i].items[j].k===k)return SLASH[i].items[j];return null;}
function typeName(t){var x=slashItem(t);return x?x.t:t;}
var PH={p:L("Skriv '/' for kommandoer, '@' for at nævne nogen…","Type '/' for commands, '@' to mention…"),h1:L('Overskrift 1','Heading 1'),h2:L('Overskrift 2','Heading 2'),h3:L('Overskrift 3','Heading 3'),th1:L('Toggle-overskrift 1','Toggle heading 1'),th2:L('Toggle-overskrift 2','Toggle heading 2'),th3:L('Toggle-overskrift 3','Toggle heading 3'),bullet:L('Liste','List'),num:L('Liste','List'),todo:'To-do',toggle:'Toggle',quote:L('Citat','Quote'),callout:L('Skriv noget…','Type something…'),remind:L('Hvad skal du mindes om?','What should you be reminded of?')};

var TEMPLATES=[
  {k:'meet',i:'🗓️',t:L('Mødereferat','Meeting notes'),icon:'🗓️',blocks:function(){var d=fmtDate(new Date());return [
    bl('callout',L('<b>Dato:</b> ','<b>Date:</b> ')+d+L(' · <b>Deltagere:</b> ',' · <b>Attendees:</b> '),{icon:'🗓️',bg:'blue'}),bl('h2',L('Dagsorden','Agenda')),bl('num',''),bl('h2',L('Noter','Notes')),bl('bullet',''),bl('h2',L('Aftaler og opgaver','Action items')),bl('todo','',{checked:false})];}},
  {k:'site',i:'🏗️',t:L('Byggepladsbesøg','Site visit'),icon:'🏗️',blocks:function(){return [
    bl('callout',L('<b>Adresse:</b> &nbsp;· <b>Dato:</b> ','<b>Address:</b> &nbsp;· <b>Date:</b> ')+fmtDate(new Date()),{icon:'📍',bg:'orange'}),bl('h2',L('Status','Status')),bl('p',''),bl('h2',L('Fejl og mangler','Issues')),bl('todo','',{checked:false}),bl('h2',L('Billeder','Photos')),bl('image',''),bl('h2',L('Næste skridt','Next steps')),bl('todo','',{checked:false})];}},
  {k:'sop',i:'📘',t:L('Procedure / vejledning','How-to / SOP'),icon:'📘',blocks:function(){return [
    bl('callout',L('Hvad er formålet med denne procedure, og hvornår bruges den?','What is this procedure for, and when is it used?'),{icon:'🎯',bg:'gray'}),bl('toc',''),bl('h2',L('Før du starter','Before you start')),bl('bullet',''),bl('h2',L('Trin for trin','Step by step')),bl('num',''),bl('h2',L('Typiske fejl','Common mistakes')),bl('toggle',L('Eksempel','Example'),{open:false})];}},
  {k:'check',i:'✅',t:L('Tjekliste','Checklist'),icon:'✅',blocks:function(){return [bl('todo','',{checked:false}),bl('todo','',{checked:false}),bl('todo','',{checked:false})];}},
  {k:'idea',i:'💡',t:L('Idé / brainstorm','Idea / brainstorm'),icon:'💡',blocks:function(){var c=bl('columns','');c.cols=[[bl('h3',L('👍 Fordele','👍 Pros')),bl('bullet','')],[bl('h3',L('👎 Ulemper','👎 Cons')),bl('bullet','')]];return [bl('quote',L('Beskriv idéen med én sætning','Describe the idea in one sentence')),c,bl('h2',L('Næste skridt','Next steps')),bl('todo','',{checked:false})];}}
];
function bl(type,html,extra){var b={id:uid(),type:type};if(isTxt(type))b.html=html||'';Object.assign(b,defaults(type),extra||{});return b;}
function defaults(t){
  if(t==='todo')return {checked:false};
  if(isTog(t))return {open:false}; // nye toggles starter lukket – Enter laver en ny toggle, Tab rykker ind i den
  if(t==='callout')return {icon:'💡',bg:'gray'};
  if(t==='table')return {header:true,rows:[['','',''],['','',''],['','','']]};
  if(t==='code')return {code:'',lang:L('Tekst','Plain text')};
  if(t==='remind'){var d=new Date();d.setDate(d.getDate()+1);d.setHours(9,0,0,0);return {at:d.toISOString(),userId:me&&me.id};}
  return {};
}
function newBlock(t){return bl(t,'');}

// ── CSS ─────────────────────────────────────────────────────
var CSS=[
'#page-kb-notes{padding:0!important;margin:-12px -14px -12px}',
'.nt-app{--nt-ink:#2b2622;--nt-sub:#8a8178;--nt-line:#ece6de;--nt-soft:#f7f4f0;--nt-hov:rgba(55,40,25,.06);--nt-acc:var(--bly-accent,#4F46E5);--nt-acc-soft:var(--bly-accent-soft,#EEF2FF);display:flex;height:calc(100vh - 56px);min-height:520px;background:#fff;color:var(--nt-ink);font-size:15px;position:relative;overflow:hidden;border-top:1px solid var(--nt-line)}',
'.nt-app button{font-family:inherit;color:inherit}',
'.nt-side{width:268px;flex:0 0 268px;background:#fbfaf8;border-right:1px solid var(--nt-line);display:flex;flex-direction:column;font-size:13.5px;transition:margin .2s}',
'.nt-app.nt-side-off .nt-side{margin-left:-268px}',
'.nt-side-top{display:flex;align-items:center;gap:8px;padding:14px 12px 8px}',
'.nt-ws{flex:1;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px}.nt-ws-ic{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,#818CF8,#4F46E5);color:#fff;display:grid;place-items:center;font-size:14px}',
'.nt-ib{border:0;background:transparent;border-radius:6px;padding:4px 7px;cursor:pointer;color:var(--nt-sub);font-size:14px;line-height:1}.nt-ib:hover{background:var(--nt-hov);color:var(--nt-ink)}',
'.nt-sitem{display:flex;align-items:center;gap:8px;width:calc(100% - 16px);margin:0 8px;border:0;background:transparent;padding:6px 8px;border-radius:7px;cursor:pointer;text-align:left;font-size:13.5px;color:#4a433c}.nt-sitem:hover{background:var(--nt-hov)}.nt-sitem kbd{margin-left:auto;font:11px ui-monospace,monospace;color:var(--nt-sub);background:#fff;border:1px solid var(--nt-line);border-radius:4px;padding:1px 5px}',
'.nt-sitem.on{background:var(--nt-hov);font-weight:600}',
'.nt-sscroll{flex:1;overflow:auto;padding:6px 0 10px}',
'.nt-sec{margin-top:14px}.nt-sec-h{display:flex;align-items:center;padding:2px 10px 4px 18px;font-size:11.5px;font-weight:600;color:var(--nt-sub);letter-spacing:.02em}.nt-sec-h span{flex:1}.nt-sec-h button{opacity:0}.nt-sec:hover .nt-sec-h button{opacity:1}',
'.nt-sec-h.nt-dropin{background:var(--nt-acc-soft);border-radius:6px}',
'.nt-teamh{display:flex;align-items:center;gap:6px;padding:4px 10px 4px 12px;margin:1px 6px;border-radius:6px;cursor:pointer;font-size:14px;color:var(--nt-ink);user-select:none}.nt-teamh:hover{background:var(--nt-hov)}.nt-teamh .nt-ti-c{display:inline-block;font-size:9px;color:var(--nt-sub);transition:transform .12s;width:14px;text-align:center}.nt-teamh .nt-ti-c.open{transform:rotate(90deg)}.nt-teamh .nt-ti-t{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nt-team-n{font-size:11px;color:var(--nt-sub);background:var(--nt-soft);border-radius:999px;padding:0 7px}',
'.nt-ti{display:flex;align-items:center;gap:2px;margin:0 8px;padding:3px 4px 3px calc(4px + var(--d,0)*14px);border-radius:6px;cursor:pointer;color:#4a433c;position:relative;min-height:28px}.nt-ti:hover{background:var(--nt-hov)}.nt-ti.on{background:rgba(178,85,42,.10);color:var(--nt-ink);font-weight:600}',
'.nt-ti-c{width:20px;height:20px;border:0;background:transparent;border-radius:4px;cursor:pointer;color:var(--nt-sub);font-size:9px;flex:0 0 20px;display:grid;place-items:center;transition:transform .15s}.nt-ti-c:hover{background:var(--nt-hov)}.nt-ti-c.open{transform:rotate(90deg)}.nt-ti-c.none{opacity:.35}',
'.nt-ti-i{width:22px;text-align:center;flex:0 0 22px;font-size:15px}.nt-ti-t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.nt-ti-a{display:none;gap:1px}.nt-ti:hover .nt-ti-a{display:flex}.nt-ti-a button{width:22px;height:22px;padding:0;font-size:13px}',
'.nt-ti.nt-dz-in{background:var(--nt-acc-soft);box-shadow:inset 0 0 0 1.5px var(--nt-acc)}.nt-ti.nt-dz-top:before,.nt-ti.nt-dz-bot:after{content:"";position:absolute;left:8px;right:4px;height:2px;background:var(--nt-acc);border-radius:2px}.nt-ti.nt-dz-top:before{top:-1px}.nt-ti.nt-dz-bot:after{bottom:-1px}',
'.nt-empty-s{padding:3px 10px 3px 40px;color:var(--nt-sub);font-size:12.5px}',
'.nt-side-foot{border-top:1px solid var(--nt-line);padding:8px 0}',
'.nt-main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative}',
'.nt-top{height:46px;flex:0 0 46px;display:flex;align-items:center;gap:6px;padding:0 12px;font-size:13.5px}',
'.nt-crumbs{display:flex;align-items:center;gap:2px;min-width:0;overflow:hidden;white-space:nowrap}.nt-crumbs a{padding:3px 6px;border-radius:5px;color:#4a433c;text-decoration:none;overflow:hidden;text-overflow:ellipsis;max-width:200px}.nt-crumbs a:hover{background:var(--nt-hov)}.nt-crumbs i{color:#c9c0b5;font-style:normal}',
'.nt-sp{flex:1}.nt-status{color:var(--nt-sub);font-size:12.5px;white-space:nowrap}.nt-edited{color:var(--nt-sub);font-size:12.5px;white-space:nowrap}@media(max-width:1100px){.nt-edited{display:none}}',
'.nt-tb{border:0;background:transparent;border-radius:6px;padding:5px 9px;cursor:pointer;font-size:13.5px;color:#4a433c;white-space:nowrap}.nt-tb:hover{background:var(--nt-hov)}.nt-tb.on{color:#d39b00}',
'.nt-scroll{flex:1;overflow:auto;position:relative;scroll-behavior:smooth}',
'.nt-page{max-width:900px;margin:0 auto;padding:0 96px 30vh}.nt-page.nt-full{max-width:none}',
'@media(max-width:860px){.nt-page{padding:0 22px 30vh}}',
'.nt-cover{height:30vh;max-height:280px;min-height:150px;margin:0 -96px;position:relative;background-size:cover;cursor:default}.nt-page.nt-full .nt-cover{margin:0 -96px}@media(max-width:860px){.nt-cover{margin:0 -22px}}',
'.nt-cover-btns{position:absolute;right:20px;bottom:12px;display:none;gap:0;background:rgba(255,255,255,.92);border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.15);overflow:hidden}.nt-cover:hover .nt-cover-btns{display:flex}.nt-cover-btns button{border:0;background:transparent;padding:6px 11px;font-size:12.5px;cursor:pointer}.nt-cover-btns button:hover{background:rgba(0,0,0,.06)}',
'.nt-cover.nt-repos{cursor:ns-resize}.nt-cover.nt-repos .nt-cover-btns{display:flex}.nt-cover-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,.55);color:#fff;padding:6px 12px;border-radius:6px;font-size:12.5px;pointer-events:none}',
'.nt-head{padding-top:64px;position:relative}.nt-head.has-cover{padding-top:0}.nt-head.has-icon.has-cover{padding-top:0}',
'.nt-icon{font-size:72px;line-height:1;border:0;background:transparent;cursor:pointer;border-radius:10px;padding:4px;margin:0 0 4px -6px;position:relative}.nt-icon:hover{background:var(--nt-hov)}.nt-head.has-cover .nt-icon{margin-top:-46px}',
'.nt-hbtns{display:flex;gap:2px;opacity:0;transition:opacity .15s;margin:0 0 4px -8px;min-height:30px}.nt-head:hover .nt-hbtns,.nt-hbtns:focus-within{opacity:1}.nt-head.has-cover .nt-hbtns{margin-top:12px}',
'.nt-hbtns button{border:0;background:transparent;color:var(--nt-sub);font-size:13.5px;padding:5px 8px;border-radius:6px;cursor:pointer}.nt-hbtns button:hover{background:var(--nt-hov);color:var(--nt-ink)}',
'.nt-title{font-size:40px;font-weight:700;line-height:1.2;margin:0 0 6px;outline:none;letter-spacing:-.01em;word-break:break-word}.nt-title:empty:before{content:attr(data-ph);color:#d6cfc6}',
'.nt-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--nt-sub);font-size:12.5px;margin:2px 0 18px}',
'.nt-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:var(--nt-soft);font-size:12px;color:#5e564e;border:0;cursor:pointer}.nt-badge.priv{background:#eef2fb;color:#3c5a99}',
'.nt-doc{position:relative;line-height:1.6}',
'.nt-b{position:relative;margin:1px 0;padding-left:calc(var(--ind,0)*26px);border-radius:4px}',
'.nt-b.nt-hide{display:none}',
'.nt-hdl{position:absolute;left:calc(var(--ind,0)*26px - 50px);top:3px;display:flex;gap:0;opacity:0;transition:opacity .1s;user-select:none}.nt-b:hover>.nt-hdl{opacity:1}',
'.nt-hb{width:24px;height:24px;border:0;background:transparent;border-radius:4px;color:#b5aca2;cursor:pointer;display:grid;place-items:center;font-size:15px;padding:0}.nt-hb:hover{background:var(--nt-hov);color:#6b6259}.nt-grip{cursor:grab;font-size:13px;letter-spacing:-2px}',
'.nt-t-h1>.nt-hdl,.nt-t-th1>.nt-hdl{top:14px}.nt-t-h2>.nt-hdl,.nt-t-th2>.nt-hdl{top:10px}.nt-t-h3>.nt-hdl,.nt-t-th3>.nt-hdl{top:6px}',
'.nt-b.nt-selb{background:rgba(35,131,226,.14);box-shadow:0 1px 0 rgba(35,131,226,.14)}',
'::highlight(nt-sel){background-color:rgba(35,131,226,.28)}.nt-selx .nt-txt:after{content:"";display:inline-block;width:6px;height:1.15em;vertical-align:-3px;background:rgba(35,131,226,.28)}body.nt-noselect .nt-hdl{opacity:0!important}body.nt-noselect #nt-doc{cursor:text}',
'.nt-btn.ghost{background:transparent;color:#37322d!important;box-shadow:inset 0 0 0 1px #e3ddd5}.nt-btn.ghost:hover{background:rgba(55,40,25,.06)}.nt-hist{width:min(1040px,94vw);max-height:80vh}.nt-hist-b{display:flex;min-height:0;flex:1;height:68vh}.nt-hist-l{width:280px;border-right:1px solid #ece6de;overflow:auto;padding:6px}.nt-hist-p{flex:1;overflow:auto;min-width:0}.nt-hist-i{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:0;background:transparent;font:inherit;padding:8px 10px;border-radius:7px;cursor:pointer;color:#2b2622}.nt-hist-i span{font-size:12px;color:#8a8178}.nt-hist-i b{font-weight:600;font-size:13.5px}.nt-hist-i:hover{background:rgba(55,40,25,.06)}.nt-hist-i.on{background:rgba(178,85,42,.10)}.nt-hist-i.cur{cursor:default;border-bottom:1px solid #ece6de;border-radius:0;margin-bottom:4px}.nt-hist-i em.plus{font-style:normal;color:#2f7d4f;font-weight:600}.nt-hist-bar{position:sticky;top:0;background:#fff;display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid #ece6de}.nt-hist-bar span{flex:1;font-size:13px;color:#8a8178;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nt-hist-bar .nt-btn{white-space:nowrap;padding:7px 12px}.nt-hist-doc{padding:18px 28px 40px;font-size:14.5px;line-height:1.55}.nt-hist-doc h1{font-size:26px;margin:0 0 12px}'+
'.nt-tchk{margin-left:-2px}.nt-ttodo.nt-done>.nt-bc>.nt-row>.nt-txt{text-decoration:line-through;color:#a49b91}.nt-fs-s .nt-txt{font-size:.86em}.nt-fs-l .nt-txt{font-size:1.2em}.nt-fs-xl .nt-txt{font-size:1.45em;line-height:1.35}#nt-doc.nt-ts-s{font-size:.9em}#nt-doc.nt-ts-l{font-size:1.12em}#nt-doc.nt-ts-xl{font-size:1.25em}.nt-fsm{display:flex;gap:4px;padding:6px 8px}.nt-fsm button{flex:1;border:1px solid #e3ddd5;background:#fff;border-radius:6px;padding:6px 0;cursor:pointer;font-family:inherit;color:#37322d}.nt-fsm button.on{border-color:#4F46E5;color:#4F46E5;background:rgba(79,70,229,.06)}'+
'.nt-only #nt-sec-shared,.nt-only [data-scope="shared"]{display:none!important}.nt-only [data-act="scope"]{pointer-events:none}'+
'.nt-inv-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #efe9e2}.nt-inv-row:first-child{border-top:0}.nt-inv-row .nm{flex:1;min-width:0}.nt-inv-row .nm b{display:block;font-weight:600}.nt-inv-row .nm span{color:#8a8178;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}.nt-inv-row button,.nt-inv-f button{border:1px solid #e3ddd5;background:#fff;border-radius:7px;padding:6px 10px;font:inherit;font-size:12.5px;cursor:pointer;color:#37322d;white-space:nowrap}.nt-inv-row button:hover{background:#f6f2ed}.nt-inv-tag{font-size:11.5px;border-radius:999px;padding:2px 8px;background:#f1ece6;color:#6d655d;white-space:nowrap}.nt-inv-tag.ok{background:#e7f2e8;color:#2f6b3a}.nt-inv-tag.off{background:#f6e6e3;color:#9a3b2c}.nt-inv-f{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 6px}.nt-inv-f input{flex:1 1 160px;min-width:0;border:1px solid #e3ddd5;border-radius:8px;padding:9px 11px;font:inherit;font-size:14px}.nt-inv-f button.go{background:#2b2622;color:#fff;border-color:#2b2622;font-weight:600;padding:9px 16px;font-size:14px}'+
'.nt-al-center>.nt-bc .nt-txt{text-align:center}.nt-al-right>.nt-bc .nt-txt{text-align:right}.nt-alg{display:flex;gap:4px;padding:6px 8px}.nt-alg button{flex:1;border:1px solid #e3ddd5;background:#fff;border-radius:6px;padding:7px 0;cursor:pointer;font:inherit;font-size:13px;color:#37322d;display:flex;flex-direction:column;align-items:center;gap:2px}.nt-alg button:hover{background:rgba(55,40,25,.05)}.nt-alg button.on{border-color:#4F46E5;color:#4F46E5;background:rgba(79,70,229,.06)}.nt-alg svg{display:block}'+
'.nt-fsn>.nt-bc .nt-txt{font-size:var(--fs);line-height:1.4}.nt-pxg{display:grid;grid-template-columns:repeat(auto-fill,minmax(42px,1fr));gap:4px;padding:6px 8px}.nt-pxg button{border:1px solid #e3ddd5;background:#fff;border-radius:6px;padding:6px 0;cursor:pointer;font:inherit;font-size:13px;color:#37322d}.nt-pxg button:hover{background:rgba(55,40,25,.05)}.nt-pxg button.on{border-color:#4F46E5;color:#4F46E5;background:rgba(79,70,229,.06)}.nt-pxr{display:flex;gap:6px;align-items:center;padding:4px 8px 8px}.nt-pxr input{width:64px;border:1px solid #e3ddd5;border-radius:6px;padding:6px 8px;font:inherit;font-size:13px}.nt-pxr span{color:#8a8178;font-size:12.5px;margin-right:auto}.nt-pxr .nt-btn{padding:6px 10px;font-size:12.5px}'+
'.nt-kb{font:600 10px/1 system-ui,sans-serif;color:#9b948c;border:1px solid #e3ddd5;border-radius:4px;padding:2px 4px;margin-left:4px;background:#faf8f5}.nt-qtoast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#241f1a;color:#fff;font:500 13px/1.3 system-ui,sans-serif;padding:9px 14px;border-radius:8px;z-index:10050;box-shadow:0 6px 20px rgba(0,0,0,.18)}'+
'.nt-marq{position:fixed;z-index:10020;background:rgba(46,120,220,.10);border:1px solid rgba(46,120,220,.45);border-radius:3px;pointer-events:none}body.nt-noselect,body.nt-noselect *{user-select:none!important}.nt-selbar{z-index:10035}',
'.nt-row{display:flex;align-items:flex-start;gap:2px}',
'.nt-pre{flex:0 0 24px;min-width:24px;text-align:center;user-select:none;line-height:1.6;padding:3px 0}',
'.nt-dot{font-size:18px;line-height:1.3}.nt-numl{font-variant-numeric:tabular-nums;padding-right:4px;flex-basis:auto;min-width:24px}',
'.nt-chk{width:16px;height:16px;margin:5px 4px 0;accent-color:var(--nt-acc);cursor:pointer}',
'.nt-t-todo.nt-done .nt-txt{text-decoration:line-through;color:#a49b91}',
'.nt-caret{border:0;background:transparent;cursor:pointer;border-radius:4px;color:#7c736a;font-size:11px;height:26px;transition:transform .15s;margin-top:1px}.nt-caret:hover{background:var(--nt-hov)}.nt-caret.open{transform:rotate(90deg)}',
'.nt-txt{flex:1;min-width:0;outline:none;padding:3px 2px;white-space:pre-wrap;word-break:break-word;min-height:1.6em}',
'.nt-txt:empty:before,.nt-cap:empty:before,.nt-cell:empty:before{content:attr(data-ph);color:#cbc3b9;pointer-events:none}',
'.nt-t-p .nt-txt:empty:not(:focus):before{content:""}',
'.nt-t-h1 .nt-txt,.nt-t-th1 .nt-txt{font-size:30px;font-weight:700;line-height:1.3;margin-top:22px}.nt-t-h2 .nt-txt,.nt-t-th2 .nt-txt{font-size:23px;font-weight:650;line-height:1.3;margin-top:16px}.nt-t-h3 .nt-txt,.nt-t-th3 .nt-txt{font-size:19px;font-weight:650;line-height:1.3;margin-top:10px}',
'.nt-t-th1 .nt-caret{margin-top:28px}.nt-t-th2 .nt-caret{margin-top:20px}.nt-t-th3 .nt-caret{margin-top:12px}',
'.nt-t-quote .nt-txt{border-left:3px solid currentColor;padding-left:14px;font-size:16.5px;margin:4px 0}',
'.nt-call{display:flex;gap:10px;padding:14px 16px 14px 12px;border-radius:8px;background:var(--nt-soft);margin:4px 0}.nt-cicon{border:0;background:transparent;font-size:20px;line-height:1.2;cursor:pointer;border-radius:5px;padding:2px;height:30px}.nt-cicon:hover{background:var(--nt-hov)}',
'.nt-tempty{color:#b5aca2;font-size:14px;padding:2px 0 2px 26px;cursor:pointer}.nt-tempty:hover{color:var(--nt-sub)}',
'.nt-div{padding:10px 0;cursor:pointer}.nt-div hr{border:0;border-top:1px solid #d6cdc1;margin:0}.nt-b[style*="--ind:"]:not([style*="--ind:0"]) .nt-div hr{margin-left:4px}',
'.nt-code{background:#f7f5f2;border-radius:8px;margin:6px 0;position:relative;border:1px solid #efe9e1}.nt-code-bar{display:flex;gap:6px;padding:6px 10px 0;font-size:12px;opacity:.6}.nt-code:hover .nt-code-bar,.nt-code:focus-within .nt-code-bar{opacity:1}',
'.nt-code-bar select,.nt-code-bar button{border:0;background:transparent;font-size:12px;color:var(--nt-sub);cursor:pointer;border-radius:4px;padding:2px 6px}.nt-code-bar button:hover,.nt-code-bar select:hover{background:var(--nt-hov)}.nt-code-bar button{margin-left:auto}',
'.nt-code-txt{display:block;width:100%;box-sizing:border-box;border:0;background:transparent;resize:none;outline:none;font:13.5px/1.6 ui-monospace,"SF Mono",Menlo,Consolas,monospace;padding:6px 16px 14px;color:#37322d;tab-size:2;overflow:hidden;white-space:pre;overflow-x:auto}',
'.nt-tblw{position:relative;margin:8px 0 14px;padding:0 24px 22px 0;overflow-x:auto}',
'.nt-tbl{border-collapse:collapse;min-width:100%;font-size:14.5px}.nt-tbl td{border:1px solid #e6e0d7;padding:0;vertical-align:top;min-width:110px}.nt-thd tr:first-child td{background:var(--nt-soft);font-weight:600}',
'.nt-cell{outline:none;padding:7px 9px;min-height:1.5em;white-space:pre-wrap;word-break:break-word}.nt-cell:focus{box-shadow:inset 0 0 0 2px rgba(46,120,220,.5)}',
'.nt-tadd{position:absolute;border:0;background:var(--nt-soft);color:var(--nt-sub);border-radius:5px;cursor:pointer;opacity:0;font-size:13px}.nt-tblw:hover .nt-tadd{opacity:1}.nt-tadd:hover{background:#ebe5dc}.nt-tadd-r{left:0;right:24px;bottom:0;height:18px}.nt-tadd-c{top:0;right:0;width:18px;bottom:22px}',
'.nt-tblo{position:relative}.nt-tbar{position:absolute;left:0;top:-26px;z-index:3;display:none;gap:2px;flex-wrap:wrap;background:#fff;padding:2px;border-radius:7px;box-shadow:0 2px 8px rgba(0,0,0,.08)}.nt-tblo:focus-within .nt-tbar{display:flex}.nt-tbar button{border:1px solid var(--nt-line);background:#fff;border-radius:6px;font-size:12px;padding:3px 8px;cursor:pointer;color:#5e564e}.nt-tbar button:hover{background:var(--nt-soft)}',
'.nt-ph{display:flex;align-items:center;gap:10px;background:var(--nt-soft);border-radius:8px;padding:14px 16px;color:var(--nt-sub);cursor:pointer;margin:4px 0;font-size:14.5px}.nt-ph:hover{background:#efeae3}',
'.nt-fig{margin:8px auto;position:relative;max-width:100%}.nt-fig.w-s{width:40%}.nt-fig.w-m{width:65%}.nt-fig.w-l{width:100%}.nt-fig.w-full{width:100%}.nt-fig img{display:block;width:100%;border-radius:6px;cursor:zoom-in}',
'.nt-cap,.nt-capd{outline:none;color:var(--nt-sub);font-size:13.5px;padding:6px 2px 0;min-height:1.2em}',
'.nt-mtools{position:absolute;top:8px;right:8px;display:none;background:rgba(30,25,20,.75);border-radius:7px;overflow:hidden}.nt-fig:hover .nt-mtools,.nt-pdf:hover .nt-mtools,.nt-emb:hover .nt-mtools,.nt-vid:hover .nt-mtools{display:flex}.nt-mtools button,.nt-mtools a{border:0;background:transparent;color:#fff;font-size:12px;padding:5px 8px;cursor:pointer;text-decoration:none}.nt-mtools button:hover,.nt-mtools a:hover,.nt-mtools .on{background:rgba(255,255,255,.18)}',
'.nt-vid{position:relative;margin:8px 0}.nt-vid video{width:100%;border-radius:6px;background:#000;display:block}',
'.nt-emb{position:relative;margin:8px 0;border:1px solid var(--nt-line);border-radius:8px;overflow:hidden;background:var(--nt-soft)}.nt-emb iframe{display:block;width:100%;border:0;height:420px;background:#fff}.nt-emb.k-yt iframe,.nt-emb.k-vimeo iframe,.nt-emb.k-loom iframe{height:auto;aspect-ratio:16/9}.nt-emb.k-maps iframe{height:360px}',
'.nt-emb-f{display:flex;gap:8px;align-items:center;padding:6px 10px;font-size:12.5px;color:var(--nt-sub)}.nt-emb-f a{margin-left:auto;color:var(--nt-sub)}',
'.nt-pdf{position:relative;margin:8px 0;border:1px solid var(--nt-line);border-radius:8px;overflow:hidden}.nt-pdf iframe{width:100%;height:560px;border:0;display:block}.nt-pdf-h{display:flex;gap:8px;padding:8px 12px;font-size:13px;background:var(--nt-soft)}.nt-pdf-h a{margin-left:auto;color:var(--nt-sub)}',
'.nt-file{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;text-decoration:none;color:inherit;margin:2px 0}.nt-file:hover{background:var(--nt-hov)}.nt-file-n{font-weight:500}.nt-file-s{color:var(--nt-sub);font-size:12.5px}',
'.nt-aud{margin:6px 0}.nt-aud audio{width:100%}',
'.nt-bm{display:flex;border:1px solid var(--nt-line);border-radius:8px;overflow:hidden;text-decoration:none;color:inherit;margin:6px 0;min-height:96px}.nt-bm:hover{background:#fbfaf8}.nt-bm-t{flex:1;min-width:0;padding:12px 16px;display:flex;flex-direction:column;gap:4px}.nt-bm-ti{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nt-bm-d{font-size:12.5px;color:var(--nt-sub);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.nt-bm-u{font-size:12px;color:#5e564e;display:flex;gap:6px;align-items:center;overflow:hidden;white-space:nowrap;margin-top:auto}.nt-bm-u img{width:16px;height:16px}.nt-bm-img{width:32%;max-width:240px;background-size:cover;background-position:center;flex:0 0 auto}',
'.nt-tabsb{border:1px solid var(--nt-line);border-radius:12px;margin:8px 0;background:#fff}',
'.nt-tabbar{display:flex;align-items:center;gap:2px;padding:8px 10px;border-bottom:1px solid #f1ede7;overflow-x:auto;scrollbar-width:thin}',
'.nt-tab{display:flex;align-items:center;gap:2px;padding:5px 11px;border-radius:8px;cursor:pointer;font-size:14px;color:#7c736a;white-space:nowrap;flex:0 0 auto}.nt-tab:hover{background:var(--nt-hov);color:var(--nt-ink)}.nt-tab.on{background:#f1eeea;color:var(--nt-ink);font-weight:500}',
'.nt-tab-t{outline:none;min-width:12px}.nt-tab-t:empty:before{content:attr(data-ph);color:#b5aca2}.nt-tab.on .nt-tab-t{cursor:text}',
'.nt-tabm{border:0;background:transparent;font-size:10px;color:#a69d93;cursor:pointer;border-radius:4px;padding:2px 3px;opacity:0}.nt-tab.on:hover .nt-tabm{opacity:1}.nt-tabm:hover{background:rgba(0,0,0,.06)}',
'.nt-tabadd{border:0;background:transparent;color:#a69d93;font-size:15px;cursor:pointer;border-radius:6px;padding:3px 8px;flex:0 0 auto}.nt-tabadd:hover{background:var(--nt-hov);color:var(--nt-ink)}',
'.nt-tab.nt-tab-dz{background:var(--nt-acc-soft);box-shadow:inset 0 0 0 1.5px var(--nt-acc)}',
'.nt-tabpane{padding:10px 18px 12px}',
'.nt-cols{display:flex;margin:2px 0}.nt-col{flex:1 1 0;min-width:0}.nt-colrs{flex:0 0 28px;position:relative;align-self:stretch;user-select:none;pointer-events:none}.nt-colrs i{position:absolute;left:13px;width:12px;top:0;bottom:0;cursor:col-resize;pointer-events:auto;z-index:3}.nt-colrs i:after{content:"";position:absolute;left:4px;top:4px;bottom:4px;width:4px;border-radius:2px;background:transparent;transition:background .12s}.nt-colrs i:hover:after,.nt-colrs.on i:after{background:rgba(46,120,220,.5)}.nt-colrs+.nt-col>.nt-b>.nt-hdl{left:calc(var(--ind,0)*26px - 66px)}body.nt-resizing,body.nt-resizing *{cursor:col-resize!important;user-select:none!important}@media(max-width:700px){.nt-cols{flex-direction:column}.nt-colrs{display:none}}',
'.nt-col>.nt-b>.nt-hdl{left:calc(var(--ind,0)*26px - 48px)}',
'.nt-toc{padding:4px 0;display:flex;flex-direction:column}.nt-toc a{color:#5e564e;text-decoration:none;padding:3px 6px;border-radius:5px;font-size:14px;border-bottom:1px solid transparent;cursor:pointer}.nt-toc a:hover{background:var(--nt-hov)}.nt-toc .lv2{padding-left:24px}.nt-toc .lv3{padding-left:44px}.nt-toc-e{color:var(--nt-sub);font-size:13.5px;padding:6px 0}',
'.nt-pg{display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;text-decoration:none;color:inherit;font-weight:500}.nt-pg:hover{background:var(--nt-hov)}.nt-pg-t{border-bottom:1px solid #ddd5cb}.nt-pg-ic{font-size:17px}.nt-pg.gone{color:var(--nt-sub);text-decoration:line-through}',
'.nt-rem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff8e8;border:1px solid #f3e2b8;border-radius:8px;padding:6px 10px;margin:4px 0}.nt-rem .nt-txt{min-width:160px}.nt-rem input,.nt-rem select{border:1px solid #eadcb7;background:#fff;border-radius:6px;padding:3px 6px;font:inherit;font-size:12.5px}.nt-rem-st{font-size:12px;color:#8a6d1e}',
'.nt-txt a,.nt-cell a,.nt-cap a{color:inherit;text-decoration:underline;text-decoration-color:#c9bfb4;text-underline-offset:2px}',
'.nt-txt code,.nt-cell code{font:.86em ui-monospace,Menlo,monospace;background:rgba(135,120,105,.13);color:#c0392b;padding:.15em .35em;border-radius:4px}',
'.nt-men{display:inline;background:transparent;border-radius:4px;padding:0 2px;cursor:pointer;white-space:nowrap}.nt-men:hover{background:var(--nt-hov)}span.nt-men[data-user]{color:#7a5a44;font-weight:500}a.nt-men{text-decoration:none!important;font-weight:500}a.nt-men span{border-bottom:1px solid #ddd5cb}.nt-date{color:#6b6259}',
'.nt-c-gray{color:#787774}.nt-c-brown{color:#9f6b53}.nt-c-orange{color:#d9730d}.nt-c-yellow{color:#cb912f}.nt-c-green{color:#448361}.nt-c-blue{color:#337ea9}.nt-c-purple{color:#9065b0}.nt-c-pink{color:#c14c8a}.nt-c-red{color:#d44c47}',
'.nt-bg-gray{background:#f1f1ef}.nt-bg-brown{background:#f4eeee}.nt-bg-orange{background:#fbecdd}.nt-bg-yellow{background:#fbf3db}.nt-bg-green{background:#edf3ec}.nt-bg-blue{background:#e7f3f8}.nt-bg-purple{background:#f6f3f9}.nt-bg-pink{background:#faf1f5}.nt-bg-red{background:#fdebec}',
'.nt-b.nt-bg-gray,.nt-b.nt-bg-brown,.nt-b.nt-bg-orange,.nt-b.nt-bg-yellow,.nt-b.nt-bg-green,.nt-b.nt-bg-blue,.nt-b.nt-bg-purple,.nt-b.nt-bg-pink,.nt-b.nt-bg-red{padding-right:6px}',
'.nt-call.nt-bg-gray{background:#f1f1ef}',
'.nt-sw{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:5px;border:1px solid var(--nt-line);font-weight:600;font-size:13px}',
'.nt-tail{height:120px;cursor:text}',
'.nt-tpl{margin:6px 0 0;color:var(--nt-sub);font-size:14px}.nt-tpl-h{margin-bottom:6px}.nt-tpl button{display:flex;align-items:center;gap:10px;border:0;background:transparent;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:14.5px;color:#5e564e;width:100%;text-align:left}.nt-tpl button:hover{background:var(--nt-hov)}',
'.nt-subs{margin-top:28px;border-top:1px solid var(--nt-line);padding-top:10px}.nt-subs-h{font-size:12px;color:var(--nt-sub);font-weight:600;margin-bottom:4px}',
'.nt-conf{position:sticky;top:0;z-index:5;background:#fff4e5;border:1px solid #f1d3a3;color:#7a4b00;border-radius:8px;padding:8px 12px;margin:10px 0;display:flex;gap:8px;align-items:center;font-size:13.5px}.nt-conf button{border:1px solid #e6c084;background:#fff;border-radius:6px;padding:3px 9px;cursor:pointer}',
'.nt-dropline{position:absolute;height:3px;background:rgba(46,120,220,.6);border-radius:2px;pointer-events:none;z-index:4}.nt-dropline.v{width:3px;height:auto}',
'.nt-b.nt-dragging{opacity:.35}',
'.nt-pop{position:fixed;z-index:10050;background:#fff;border-radius:10px;box-shadow:0 0 0 1px rgba(15,15,15,.05),0 3px 6px rgba(15,15,15,.1),0 9px 24px rgba(15,15,15,.2);font-size:14px;color:var(--nt-ink,#2b2622);max-height:min(420px,70vh);overflow:auto;min-width:220px}',
'.nt-pop .nt-mg{padding:8px 14px 4px;font-size:11.5px;color:#8a8178;font-weight:600}',
'.nt-pop .nt-mi{display:flex;align-items:center;gap:10px;padding:5px 10px;margin:0 4px;border-radius:6px;cursor:pointer;width:calc(100% - 8px);border:0;background:transparent;text-align:left;font-size:14px;color:inherit;font-family:inherit}',
'.nt-pop .nt-mi.act,.nt-pop .nt-mi:hover{background:rgba(55,40,25,.07)}',
'.nt-pop .nt-mi-i{width:40px;height:40px;flex:0 0 40px;border:1px solid #ece6de;border-radius:7px;display:grid;place-items:center;background:#fff;font-size:15px;font-weight:600;color:#5e564e}',
'.nt-pop.small .nt-mi-i{width:22px;height:22px;flex-basis:22px;border:0;background:transparent;font-size:14px}',
'.nt-pop .nt-mi-t{font-size:14px}.nt-pop .nt-mi-d{font-size:12px;color:#8a8178}.nt-pop .nt-mi-k{margin-left:auto;font-size:11.5px;color:#a69d93}',
'.nt-pop .nt-sep{height:1px;background:#ece6de;margin:5px 0}',
'.nt-pop-pad{padding:12px}',
'.nt-pop input[type=text],.nt-pop input[type=url],.nt-pop input[type=search],.nt-pop textarea,.nt-pop input[type=date],.nt-pop input[type=datetime-local]{width:100%;box-sizing:border-box;border:1px solid #e3ddd4;border-radius:7px;padding:8px 10px;font:inherit;font-size:14px;background:#fbfaf8;outline:none}.nt-pop input:focus,.nt-pop textarea:focus{border-color:var(--nt-acc,#4F46E5);background:#fff}',
'.nt-btn{border:0;background:var(--nt-acc,#4F46E5);color:#fff!important;border-radius:7px;padding:8px 14px;cursor:pointer;font-size:13.5px;font-weight:600;font-family:inherit}.nt-btn:hover{filter:brightness(1.05)}.nt-btn.sec{background:#f1ede7;color:#4a433c!important}.nt-btn:disabled{opacity:.5;cursor:default}',
'.nt-tabs{display:flex;gap:4px;border-bottom:1px solid #ece6de;padding:6px 10px 0}.nt-tabs button{border:0;background:transparent;padding:6px 8px;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:#6b6259;font-family:inherit}.nt-tabs button.on{border-color:#2b2622;color:#2b2622}',
'.nt-egrid{display:grid;grid-template-columns:repeat(10,1fr);gap:2px;padding:4px 10px 12px}.nt-egrid button{border:0;background:transparent;font-size:21px;cursor:pointer;border-radius:5px;padding:3px 0;line-height:1.2}.nt-egrid button:hover{background:rgba(55,40,25,.07)}',
'.nt-cgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px}.nt-cgrid button{height:56px;border:0;border-radius:6px;cursor:pointer}.nt-cgrid button:hover{outline:2px solid #2b2622}',
'.nt-stb{position:fixed;z-index:10040;display:flex;background:#fff;border-radius:8px;box-shadow:0 0 0 1px rgba(15,15,15,.05),0 3px 6px rgba(15,15,15,.1),0 9px 24px rgba(15,15,15,.2);padding:3px;gap:1px;font-size:13.5px}',
'.nt-stb button{border:0;background:transparent;border-radius:5px;padding:4px 8px;cursor:pointer;color:#37322d;font-family:inherit;font-size:13.5px;white-space:nowrap}.nt-stb button:hover{background:rgba(55,40,25,.07)}.nt-stb .ai{color:#8b4bd1;font-weight:600}.nt-stb>i{width:1px;background:#ece6de;margin:3px 2px}',
'.nt-ovl{position:fixed;inset:0;z-index:10030;background:rgba(15,12,10,.35);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}',
'.nt-dlg{background:#fff;border-radius:12px;width:min(640px,92vw);max-height:72vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;color:#2b2622;font-size:14px}',
'.nt-dlg-in{border:0;border-bottom:1px solid #ece6de;padding:16px 18px;font:inherit;font-size:17px;outline:none}',
'.nt-dlg-l{overflow:auto;padding:6px}.nt-dlg-l .nt-mi{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:7px;cursor:pointer;border:0;background:transparent;width:100%;text-align:left;font:inherit}.nt-dlg-l .nt-mi.act,.nt-dlg-l .nt-mi:hover{background:rgba(55,40,25,.07)}.nt-dlg-l .sn{font-size:12.5px;color:#8a8178;display:block;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:520px}.nt-dlg-l mark{background:#fbe8a6;color:inherit}',
'.nt-dlg-h{padding:14px 18px;border-bottom:1px solid #ece6de;font-weight:700;display:flex;align-items:center}.nt-dlg-h span{flex:1}',
'.nt-dlg-e{padding:24px;text-align:center;color:#8a8178}',
'.nt-cm{position:absolute;top:0;right:0;bottom:0;width:340px;background:#fff;border-left:1px solid var(--nt-line);z-index:8;display:flex;flex-direction:column;box-shadow:-8px 0 24px rgba(0,0,0,.05)}',
'.nt-cm-h{display:flex;align-items:center;padding:12px 14px;font-weight:700;border-bottom:1px solid var(--nt-line)}.nt-cm-h span{flex:1}',
'.nt-cm-l{flex:1;overflow:auto;padding:10px 14px}.nt-cmi{padding:10px 0;border-bottom:1px solid var(--nt-soft);font-size:14px}.nt-cmi.res{opacity:.55}.nt-cmi-h{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--nt-sub);margin-bottom:4px}.nt-cmi-h b{color:var(--nt-ink)}.nt-av{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10.5px;font-weight:700;flex:0 0 24px}',
'.nt-cmi-b{white-space:pre-wrap;word-break:break-word}.nt-cmi-a{display:flex;gap:4px;margin-top:4px}.nt-cmi-a button{border:0;background:transparent;color:var(--nt-sub);font-size:12px;cursor:pointer;border-radius:4px;padding:2px 6px}.nt-cmi-a button:hover{background:var(--nt-hov)}',
'.nt-cm-f{border-top:1px solid var(--nt-line);padding:10px 14px}.nt-cm-f textarea{width:100%;box-sizing:border-box;border:1px solid var(--nt-line);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;resize:vertical;min-height:64px;outline:none}.nt-cm-f textarea:focus{border-color:var(--nt-acc)}',
'.nt-home{max-width:1040px;margin:0 auto;padding:44px 48px 80px}@media(max-width:860px){.nt-home{padding:28px 18px}}',
'.nt-hello{font-size:30px;font-weight:700;margin-bottom:6px;letter-spacing:-.01em}.nt-hello-s{color:var(--nt-sub);margin-bottom:22px}',
'.nt-qa{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:34px}.nt-qa button{display:flex;align-items:center;gap:8px;border:1px solid var(--nt-line);background:#fff;border-radius:10px;padding:10px 14px;cursor:pointer;font-size:14px;font-weight:500}.nt-qa button:hover{background:var(--nt-soft);border-color:#e0d8cd}',
'.nt-h3{font-size:13px;font-weight:600;color:var(--nt-sub);margin:0 0 10px;display:flex;align-items:center;gap:6px}',
'.nt-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:16px;margin-bottom:34px}',
'.nt-card{display:block;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 0 0 1px var(--nt-line);text-decoration:none;color:inherit;position:relative;transition:box-shadow .15s,transform .15s}.nt-card:hover{box-shadow:0 0 0 1px #e0d8cd,0 8px 22px rgba(60,40,20,.10);transform:translateY(-1px)}',
'.nt-card-cv{height:96px;background:var(--nt-soft)}.nt-card-ic{position:absolute;top:70px;left:14px;font-size:30px;line-height:1}.nt-card-b{padding:22px 14px 14px}.nt-card-t{font-weight:600;font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nt-card-x{font-size:12.5px;color:var(--nt-sub);margin-top:4px;height:34px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.nt-card-m{font-size:11.5px;color:#a69d93;margin-top:8px;display:flex;gap:6px;align-items:center}',
'.nt-lb{position:fixed;inset:0;z-index:10060;background:rgba(10,8,6,.85);display:grid;place-items:center;cursor:zoom-out}.nt-lb img{max-width:94vw;max-height:92vh;border-radius:6px}',
'.nt-aires{white-space:pre-wrap;max-height:300px;overflow:auto;font-size:14px;line-height:1.55;background:#faf7ff;border:1px solid #ece2fb;border-radius:8px;padding:10px 12px;margin:8px 0}',
'.nt-spin{display:inline-block;width:14px;height:14px;border:2px solid #d9cfee;border-top-color:#8b4bd1;border-radius:50%;animation:ntspin .7s linear infinite;vertical-align:-2px}@keyframes ntspin{to{transform:rotate(360deg)}}',
'.nt-flash{animation:ntflash 1.6s ease}@keyframes ntflash{0%,40%{background:rgba(250,210,90,.45)}100%{background:transparent}}',
'.nt-up{color:var(--nt-sub);font-size:13.5px;padding:10px 0}',
'.nt-side-ovl{display:none}',
'@media(max-width:860px){.nt-side{position:absolute;left:0;top:0;bottom:0;z-index:9;box-shadow:4px 0 20px rgba(0,0,0,.12)}.nt-app:not(.nt-side-on) .nt-side{margin-left:-268px}.nt-app.nt-side-on .nt-side-ovl{display:block;position:absolute;inset:0;z-index:8;background:rgba(0,0,0,.2)}.nt-hdl{display:none}.nt-cm{width:100%}}',
'.nt-menu-btn{display:none}.nt-app.nt-side-off .nt-menu-btn{display:inline-block}@media(max-width:860px){.nt-menu-btn{display:inline-block}}',
// ── telefon (okt. 2026): mindre overskrift/cover, smallere indryk, kolonner under hinanden, ingen hover-håndtag
'@media(max-width:860px){.nt-page{padding:0 16px 45vh}.nt-cover{margin:0 -16px;height:150px;min-height:120px}.nt-title{font-size:28px}.nt-icon{font-size:52px}.nt-head{padding-top:28px}.nt-b{padding-left:calc(var(--ind,0)*18px)}.nt-cols{flex-direction:column}.nt-colrs{display:none}.nt-col{flex:none!important;width:auto!important}}',
'@media(max-width:860px){.nt-qtoast{bottom:84px}}@media(hover:none){.nt-hdl{display:none!important}.nt-hbtns{opacity:1}.nt-caret{min-width:26px;min-height:26px}.nt-cover-btns{display:flex}}',
'@media(max-width:860px) and (pointer:coarse){.nt-doc{font-size:16px}.nt-scroll{scroll-behavior:auto;-webkit-overflow-scrolling:touch}}',
'.nt-kbar{position:fixed;left:0;right:0;top:0;z-index:10050;display:none;gap:2px;align-items:center;background:#fff;border-top:1px solid #e6e0d8;box-shadow:0 -2px 10px rgba(0,0,0,.06);padding:5px 6px;overflow-x:auto;scrollbar-width:none;-webkit-user-select:none;user-select:none;touch-action:manipulation}.nt-kbar::-webkit-scrollbar{display:none}',
'.nt-kbar.on{display:flex}.nt-kbar button{flex:0 0 auto;min-width:34px;height:36px;border:0;background:transparent;border-radius:8px;font:inherit;font-size:16px;color:#37322d;padding:0 5px}.nt-kbar button:active{background:#efe9e2}.nt-kbar i{width:1px;height:22px;background:#e6e0d8;margin:0 3px;flex:0 0 auto}.nt-kbar .sp{flex:1 0 4px}'
].join('\n');

// ── opbygning ───────────────────────────────────────────────
function build(){
  if(S.built)return;S.built=true;
  var st=document.createElement('style');st.id='nt-css';st.textContent=CSS;document.head.appendChild(st);
  var root=document.getElementById('page-kb-notes');
  root.innerHTML='<div class="nt-app'+(notesOnly()?' nt-only':'')+'" id="nt-app" data-no-i18n="">'+
   '<aside class="nt-side"><div class="nt-side-top"><div class="nt-ws"><span class="nt-ws-ic">📝</span>'+L('Noter','Notes')+'</div><button class="nt-ib" data-act="side-off" title="'+L('Skjul menu','Hide sidebar')+' ('+MOD+'\\)">«</button></div>'+
   '<button class="nt-sitem" data-act="search">🔍 '+L('Søg','Search')+'<kbd>'+MOD+'K</kbd></button>'+
   '<button class="nt-sitem" data-act="home" id="nt-home-btn">🏠 '+L('Hjem','Home')+'</button>'+
   '<button class="nt-sitem" data-act="new" data-scope="'+defScope()+'">＋ '+L('Ny side','New page')+'</button>'+
   '<div class="nt-sscroll"><div class="nt-sec" id="nt-sec-fav" hidden><div class="nt-sec-h"><span>'+L('Favoritter','Favorites')+'</span></div><div id="nt-tree-fav"></div></div>'+
   '<div class="nt-sec" id="nt-sec-shared"><div class="nt-sec-h" data-drop="shared"><span>👥 '+L('Fælles','Shared')+'</span><button class="nt-ib" data-act="new" data-scope="shared" title="'+L('Ny fælles side','New shared page')+'">＋</button></div><div id="nt-tree-shared"></div></div>'+
   '<div class="nt-sec" id="nt-sec-private"><div class="nt-sec-h" data-drop="private"><span>🔒 '+L('Mine private sider','My private pages')+'</span><button class="nt-ib" data-act="new" data-scope="private" title="'+L('Ny privat side','New private page')+'">＋</button></div><div id="nt-tree-private"></div></div>'+
   '<div class="nt-sec" id="nt-sec-team" hidden><div class="nt-sec-h"><span>👀 '+L('Medarbejdernes sider','Team members\' pages')+'</span></div><div id="nt-tree-team"></div></div></div>'+
   '<div class="nt-side-foot">'+(window.NOTER_STANDALONE?'':'<a class="nt-sitem" href="/noter" target="_blank" rel="noopener" style="text-decoration:none;display:block" title="'+L('Åbn noterne som en hurtig app – på telefonen kan den lægges på hjemmeskærmen','Open notes as a fast app – on a phone it can be added to the home screen')+'">📱 '+L('Noter som app (telefon)','Notes as an app (phone)')+'</a>')+'<button class="nt-sitem" data-act="notion-import">📥 '+L('Importér fra Notion','Import from Notion')+'</button><button class="nt-sitem" data-act="trash">🗑 '+L('Papirkurv','Trash')+'</button>'+(window.NOTER_STANDALONE&&!notesOnly()?'<a class="nt-sitem" href="/admin" style="text-decoration:none;display:block">↩ '+L('Til portalen','Back to portal')+'</a>':'')+'</div></aside>'+
   '<div class="nt-side-ovl" data-act="side-close"></div>'+
   '<main class="nt-main"><div class="nt-top" id="nt-top"></div><div class="nt-scroll" id="nt-scroll"></div></main>'+
   '</div>';
  bindApp($('#nt-app'));
}

// ── træ ─────────────────────────────────────────────────────
async function loadTree(){
  var r=await api('/api/notes/tree');if(!r||!r.pages)return;
  S.tree=r.pages;S.fav=r.favorites||[];indexTree();renderTree();
}
function indexTree(){
  S.byId={};S.kids={};
  S.tree.forEach(function(p){S.byId[p.id]=p;});
  // Gulv Master: admin ser også medarbejdernes private sider — de lægges i
  // deres egen gruppe pr. medarbejder ('r-team-<id>') i stedet for under "Mine".
  S.team={};
  S.tree.forEach(function(p){var k;if(p.parent_id&&S.byId[p.parent_id])k=p.parent_id;else if(p.scope==='private'&&me&&+p.owner_id!==+me.id){k='r-team-'+p.owner_id;S.team[p.owner_id]=p.owner_name||L('Ukendt','Unknown');}else k='r-'+p.scope;(S.kids[k]=S.kids[k]||[]).push(p);});
  Object.keys(S.kids).forEach(function(k){S.kids[k].sort(function(a,b){return (a.position-b.position)||(a.id-b.id);});});
}
function ancestors(id){var out=[],p=S.byId[id],g=0;while(p&&p.parent_id&&S.byId[p.parent_id]&&g++<30){p=S.byId[p.parent_id];out.unshift(p.id);}return out;}
function treeItem(p,d,ctx){
  var kids=S.kids[p.id]||[],open=!!S.exp[ctx+p.id],on=S.page&&S.page.id===p.id;
  var s='<div class="nt-ti'+(on?' on':'')+'" data-act="open" data-pid="'+p.id+'" data-tid="'+p.id+'" data-ctx="'+ctx+'" draggable="true" style="--d:'+d+'">'+
   '<button class="nt-ti-c'+(open?' open':'')+(kids.length?'':' none')+'" data-act="tex" tabindex="-1">▶</button>'+
   '<span class="nt-ti-i">'+H(p.icon||'📄')+'</span><span class="nt-ti-t">'+H(p.title||L('Uden titel','Untitled'))+'</span>'+
   '<span class="nt-ti-a"><button class="nt-ib" data-act="tmenu" title="'+L('Mere','More')+'">⋯</button><button class="nt-ib" data-act="tadd" title="'+L('Tilføj underside','Add a page inside')+'">＋</button></span></div>';
  if(open){s+=kids.length?kids.map(function(k){return treeItem(k,d+1,ctx);}).join(''):'<div class="nt-empty-s" style="padding-left:'+(40+d*14)+'px">'+L('Ingen sider indeni','No pages inside')+'</div>';}
  return s;
}
function renderTree(){
  ['shared','private'].forEach(function(sc){
    var el=$('#nt-tree-'+sc);if(!el)return;var list=S.kids['r-'+sc]||[];
    el.innerHTML=list.length?list.map(function(p){return treeItem(p,0,'');}).join(''):'<div class="nt-empty-s">'+(sc==='shared'?L('Ingen fælles sider endnu','No shared pages yet'):privHint())+'</div>';
  });
  // Medarbejdernes private sider (kun admin får dem fra serveren)
  var tEl=$('#nt-tree-team'),owners=Object.keys(S.team||{}).sort(function(a,b){return String(S.team[a]).localeCompare(String(S.team[b]),'da');});
  var tSec=$('#nt-sec-team');if(tSec)tSec.hidden=!owners.length;
  if(tEl)tEl.innerHTML=owners.map(function(uid){
    var list=S.kids['r-team-'+uid]||[],open=!!S.exp['u'+uid];
    return '<div class="nt-teamh" data-act="team-tg" data-uid="'+uid+'"><span class="nt-ti-c'+(open?' open':'')+'">▶</span><span class="nt-ti-i">👤</span><span class="nt-ti-t">'+H(S.team[uid])+'</span><span class="nt-team-n">'+list.length+'</span></div>'+
      (open?list.map(function(p){return treeItem(p,1,'');}).join(''):'');
  }).join('');
  var favs=S.fav.map(function(id){return S.byId[id];}).filter(Boolean);
  $('#nt-sec-fav').hidden=!favs.length;
  $('#nt-tree-fav').innerHTML=favs.map(function(p){return treeItem(p,0,'f');}).join('');
  var hb=$('#nt-home-btn');if(hb)hb.classList.toggle('on',!S.page);
}
function privHint(){return isAdminN()?L('Kun du kan se sider her','Only you can see pages here'):L('Kun du – og administratoren – kan se sider her','Only you – and the administrator – can see pages here');}
function isAdminN(){try{return !!(me&&me.role==='admin');}catch(e){return false;}}
function setExp(key,on){if(on)S.exp[key]=1;else delete S.exp[key];try{localStorage.setItem('nt_exp',JSON.stringify(S.exp));}catch(e){}}
function revealInTree(id){ancestors(id).forEach(function(a){S.exp[a]=1;});try{localStorage.setItem('nt_exp',JSON.stringify(S.exp));}catch(e){}}

// ── routing ─────────────────────────────────────────────────
async function init(){
  build();
  var parts=location.hash.slice(1).split('/');
  var id=parts[0]==='kb-notes'?Number(parts[1])||null:null,block=parts[2]||null;
  var key=String(id)+'/'+(block||'');
  if(!S.tree.length||S.routeKey==='')await loadTree();
  if(S.routeKey===key&&(id?S.page&&S.page.id===id:!S.page)&&$('#nt-scroll').childElementCount)return;
  S.routeKey=key;
  if(id)await openPage(id,{fromHash:true,block:block});else showHome(true);
}
function go(id,block){
  flush();
  var h='kb-notes'+(id?'/'+id+(block?'/'+block:''):'');
  if(location.hash.slice(1)!==h)history.pushState(null,'','#'+h);
  S.routeKey=String(id||null)+'/'+(block||'');
  if(id)openPage(id,{block:block});else showHome();
  if(window.innerWidth<860)$('#nt-app').classList.remove('nt-side-on');
}

// ── hjem ────────────────────────────────────────────────────
async function showHome(){
  S.page=null;closeComments();renderTree();setAppTitleSafe(L('Noter','Notes'));
  $('#nt-top').innerHTML='<button class="nt-ib nt-menu-btn" data-act="side-on">☰</button><div class="nt-crumbs"><a>🏠 '+L('Hjem','Home')+'</a></div><div class="nt-sp"></div>';
  var sc=$('#nt-scroll');sc.innerHTML='<div class="nt-home"><div class="nt-up">'+L('Henter…','Loading…')+'</div></div>';
  var rec=await api('/api/notes/recent')||[];
  var hr=new Date().getHours(),name=(me&&me.name||'').split(' ')[0];
  var greet=hr<10?L('God morgen','Good morning'):hr<18?L('God dag','Good afternoon'):L('God aften','Good evening');
  var card=function(p){return '<a class="nt-card" href="#kb-notes/'+p.id+'" data-act="open" data-pid="'+p.id+'"><div class="nt-card-cv" style="'+(p.cover_url?coverCss(p.cover_url,p.cover_pos):'background:'+GRADS.sand)+'"></div><div class="nt-card-ic">'+H(p.icon||'📄')+'</div><div class="nt-card-b"><div class="nt-card-t">'+H(p.title||L('Uden titel','Untitled'))+'</div><div class="nt-card-x">'+H(p.excerpt||'')+'</div><div class="nt-card-m">'+(p.scope==='private'?'🔒':'👥')+' '+rel(p.updated_at)+(p.updated_by_name?' · '+H(p.updated_by_name.split(' ')[0]):'')+'</div></div></a>';};
  var favs=S.fav.map(function(id){return S.byId[id];}).filter(Boolean);
  if(S.page)return; // brugeren nåede at åbne en side imens
  sc.innerHTML='<div class="nt-home"><div class="nt-hello">'+greet+(name?', '+H(name):'')+' 👋</div><div class="nt-hello-s">'+(notesOnly()?L('Dine egne noter – kun du kan se dem.','Your own notes – only you can see them.'):(isAdminN()?L('Fælles viden for hele teamet, dine egne private noter – og medarbejdernes sider under 👀 i menuen.','Shared knowledge for the whole team, your own private notes – and team members\' pages under 👀 in the menu.'):L('Fælles viden for hele teamet – og dine egne private noter (kan også ses af administratoren).','Shared knowledge for the whole team – and your own private notes (also visible to the administrator).')))+'</div>'+
   '<div class="nt-qa"><button data-act="new" data-scope="shared">👥 '+L('Ny fælles side','New shared page')+'</button><button data-act="new" data-scope="private">🔒 '+L('Ny privat side','New private page')+'</button><button data-act="search">🔍 '+L('Søg i noter','Search notes')+'</button></div>'+
   (favs.length?'<div class="nt-h3">⭐ '+L('Favoritter','Favorites')+'</div><div class="nt-gal">'+favs.slice(0,8).map(function(f){var r=rec.find(function(x){return x.id===f.id;});return card(r||f);}).join('')+'</div>':'')+
   '<div class="nt-h3">🕘 '+L('Senest redigeret','Recently edited')+'</div>'+(rec.length?'<div class="nt-gal">'+rec.map(card).join('')+'</div>':'<div class="nt-up">'+L('Ingen sider endnu – opret den første ovenfor.','No pages yet – create the first one above.')+'</div>')+'</div>';
}
function setAppTitleSafe(t){try{if(typeof setAppTitle==='function')setAppTitle(t);}catch(e){}}

// ── åbn side ────────────────────────────────────────────────
async function openPage(id,o){
  o=o||{};
  var p=await api('/api/notes/'+id);
  if(!p||p.ok===false||!p.id){toast((p&&p.error)||L('Siden kunne ikke åbnes','Could not open page'),'⚠️');showHome();return;}
  // Toggle+to-do (fjernet okt. 2026): har linjen indhold under sig, bliver den en toggle – ellers en to-do
  var conv=0;(function fix(list){(list||[]).forEach(function(x,i){if(x.todo&&isTog(x.type)){var n=list[i+1],kids=n&&(n.indent||0)>(x.indent||0),c=!!x.checked;delete x.todo;
      if(kids||x.type!=='toggle')delete x.checked;else{x.type='todo';x.checked=c;delete x.open;}conv++;}
    if(Array.isArray(x.cols))x.cols.forEach(fix);});})(p.blocks);
  S.page=p;S.pending={};S.undo=[];S.redo=[];S.sel=[];S.snap=JSON.stringify(p.blocks||[]);S.base=S.snap;S.saveN=(S.saveN||0)+1;if(conv)setTimeout(function(){if(S.page===p)changed();},50);
  if(!Array.isArray(p.blocks))p.blocks=[];
  revealInTree(p.id);renderTree();renderPage();
  setAppTitleSafe((p.icon?p.icon+' ':'')+(p.title||L('Uden titel','Untitled')));
  $('#nt-scroll').scrollTop=0;
  if(o.block){revealBlock(o.block);setTimeout(function(){var el=$('.nt-b[data-id="'+o.block+'"]');if(el){el.scrollIntoView({block:'center'});el.classList.add('nt-flash');}},60);}
  else if(!p.title&&o.fresh){setTimeout(function(){var t=$('.nt-title');if(t)t.focus();},30);}
  if(S.cmOpen)openComments();
}
function crumbsHtml(){
  var p=S.page,c=(p.crumbs||[]);
  return '<span class="nt-badge'+(p.scope==='private'?' priv':'')+'" style="margin-right:4px">'+(p.scope==='private'?'🔒 '+L('Privat','Private'):'👥 '+L('Fælles','Shared'))+'</span>'+
    c.map(function(x,i){return (i?'<i>/</i>':'')+'<a href="#kb-notes/'+x.id+'" data-act="open" data-pid="'+x.id+'">'+H((x.icon?x.icon+' ':'')+(x.id===p.id?(p.title||L('Uden titel','Untitled')):(x.title||L('Uden titel','Untitled'))))+'</a>';}).join('');
}
function renderTop(){
  var p=S.page;if(!p)return;
  $('#nt-top').innerHTML='<button class="nt-ib nt-menu-btn" data-act="side-on">☰</button><div class="nt-crumbs" id="nt-crumbs">'+crumbsHtml()+'</div><div class="nt-sp"></div>'+
   '<span class="nt-status" id="nt-status"></span><span class="nt-edited">'+L('Redigeret ','Edited ')+rel(p.updated_at)+(p.updated_by_name?L(' af ',' by ')+H(p.updated_by_name.split(' ')[0]):'')+'</span>'+
   '<button class="nt-tb" data-act="comments" title="'+L('Kommentarer','Comments')+'">💬'+(p.comment_count?' '+p.comment_count:'')+'</button>'+
   '<button class="nt-tb'+(p.favorite?' on':'')+'" data-act="fav" title="'+L('Favorit','Favorite')+'">'+(p.favorite?'★':'☆')+'</button>'+
   '<button class="nt-tb" data-act="pmenu" title="'+L('Mere','More')+'">⋯</button>';
}
function renderPage(){
  var p=S.page;renderTop();
  var hasCover=!!p.cover_url;
  var linked={};walk(p.blocks,function(b){if(b.type==='page'&&b.pageId)linked[b.pageId]=1;});
  var orphans=(p.children||[]).filter(function(c){return !linked[c.id];});
  var isEmpty=!p.blocks.length||(p.blocks.length===1&&isTxt(p.blocks[0].type)&&!plain(p.blocks[0].html).trim());
  $('#nt-scroll').innerHTML='<div class="nt-page'+(p.full_width?' nt-full':'')+'" id="nt-page">'+
    (hasCover?'<div class="nt-cover" id="nt-cover" style="'+coverCss(p.cover_url,p.cover_pos)+'"><div class="nt-cover-btns"><button data-act="cover">'+L('Skift cover','Change cover')+'</button>'+(/^gradient:/.test(p.cover_url)?'':'<button data-act="coverpos">'+L('Flyt','Reposition')+'</button>')+'<button data-act="coverrm">'+L('Fjern','Remove')+'</button></div></div>':'')+
    '<div class="nt-head'+(hasCover?' has-cover':'')+(p.icon?' has-icon':'')+'">'+
      (p.icon?'<button class="nt-icon" data-act="icon" title="'+L('Skift ikon','Change icon')+'">'+H(p.icon)+'</button>':'')+
      '<div class="nt-hbtns">'+(p.icon?'':'<button data-act="icon">😀 '+L('Tilføj ikon','Add icon')+'</button>')+(hasCover?'':'<button data-act="coveradd">🖼 '+L('Tilføj cover','Add cover')+'</button>')+'<button data-act="comments">💬 '+L('Kommentér','Add comment')+'</button></div>'+
      '<h1 class="nt-title" contenteditable="true" spellcheck="true" data-ph="'+L('Uden titel','Untitled')+'">'+H(p.title||'')+'</h1>'+
      '<div class="nt-meta"><button class="nt-badge'+(p.scope==='private'?' priv':'')+'" data-act="scope" title="'+L('Skift mellem fælles og privat','Switch between shared and private')+'">'+(p.scope==='private'?(me&&+p.owner_id!==+me.id?'👀 '+L('Privat side af ','Private page of ')+H(p.owner_name||L('en medarbejder','a team member')):'🔒 '+(isAdminN()?L('Privat – kun dig','Private – only you'):L('Privat – dig og administratoren','Private – you and the administrator'))):'👥 '+L('Fælles – alle kan se og redigere','Shared – everyone can view and edit'))+'</button>'+
      (p.created_by_name?'<span>'+L('Oprettet af ','Created by ')+H(p.created_by_name)+' · '+fmtDate(p.created_at)+'</span>':'')+'</div>'+
    '</div>'+
    '<div id="nt-conf"></div>'+
    '<div class="nt-doc'+(p.text_size&&!/^\d+$/.test(p.text_size)?' nt-ts-'+p.text_size:'')+'" id="nt-doc"'+(/^\d+$/.test(p.text_size||'')?' style="font-size:'+p.text_size+'px"':'')+'></div>'+
    '<div id="nt-tpl"></div>'+
    '<div class="nt-tail" data-act="tail"></div>'+
    (orphans.length?'<div class="nt-subs"><div class="nt-subs-h">'+L('Undersider','Sub-pages')+'</div>'+orphans.map(function(c){return '<a class="nt-pg" href="#kb-notes/'+c.id+'" data-act="open" data-pid="'+c.id+'"><span class="nt-pg-ic">'+H(c.icon||'📄')+'</span><span class="nt-pg-t">'+H(c.title||L('Uden titel','Untitled'))+'</span></a>';}).join('')+'</div>':'')+
  '</div>';
  renderDoc();
  renderTemplates(isEmpty);
}
function renderTemplates(show){
  var el=$('#nt-tpl');if(!el)return;
  if(!show){el.innerHTML='';return;}
  el.innerHTML='<div class="nt-tpl"><div class="nt-tpl-h">'+L('Tryk Enter for at fortsætte med en tom side, eller vælg en skabelon','Press Enter to continue with an empty page, or pick a template')+'</div>'+
    TEMPLATES.map(function(t){return '<button data-act="tpl" data-k="'+t.k+'"><span>'+t.i+'</span>'+t.t+'</button>';}).join('')+
    '<button data-act="tpl" data-k="ai"><span>✨</span>'+L('Skriv med AI…','Draft with AI…')+'</button></div>';
}

// ── blok-hjælpere ───────────────────────────────────────────
function walk(list,fn){(list||[]).forEach(function(b){fn(b);if(b.cols)b.cols.forEach(function(c){walk(c,fn);});});}
function find(id,list,owner,col){
  list=list||S.page.blocks;
  for(var i=0;i<list.length;i++){var b=list[i];if(b.id===id)return {list:list,i:i,b:b,owner:owner||null,col:col==null?null:col};
    if(b.cols)for(var c=0;c<b.cols.length;c++){var r=find(id,b.cols[c],b,c);if(r)return r;}}
  return null;
}
function groupEnd(list,i){var ind=list[i].indent||0,j=i+1;while(j<list.length&&(list[j].indent||0)>ind)j++;return j;}
function cleanupCols(owner){
  if(!owner||!owner.cols)return;
  if(owner.type==='columns'&&owner.widths&&owner.cols.some(function(c){return !c.length;}))delete owner.widths;
  if(owner.type==='tabs'){owner.cols.forEach(function(c){if(!c.length)c.push(bl('p',''));});return;}
  owner.cols=owner.cols.filter(function(c){return c.length;});
  if(owner.cols.length<=1){var f=find(owner.id);if(!f)return;var inner=owner.cols[0]||[];f.list.splice.apply(f.list,[f.i,1].concat(inner));}
}
function ensureNotEmpty(){if(!S.page.blocks.length)S.page.blocks.push(newBlock('p'));}
function headings(){var out=[];walk(S.page.blocks,function(b){var m=/^t?h([123])$/.exec(b.type);if(m&&plain(b.html).trim())out.push({id:b.id,lv:+m[1],t:plain(b.html)});});return out;}

// ── tegning af blokke ───────────────────────────────────────
function renderList(list){
  var out='',hideBelow=null,num={};
  for(var i=0;i<list.length;i++){
    var b=list[i],ind=b.indent||0;
    if(hideBelow!==null){if(ind>hideBelow){out+=renderBlock(b,{hidden:true,n:0,list:list,i:i});continue;}hideBelow=null;}
    Object.keys(num).forEach(function(k){if(+k>ind)delete num[k];});
    var n=0;if(b.type==='num'){num[ind]=(num[ind]||0)+1;n=num[ind];}else delete num[ind];
    out+=renderBlock(b,{n:n,list:list,i:i});
    if(isTog(b.type)&&!b.open)hideBelow=ind;
  }
  return out;
}
function numLabel(n,ind){var lv=ind%3;if(lv===1){var s='';while(n>0){n--;s=String.fromCharCode(97+n%26)+s;n=Math.floor(n/26);}return s;}if(lv===2){var r=[[10,'x'],[9,'ix'],[5,'v'],[4,'iv'],[1,'i']],o='';r.forEach(function(x){while(n>=x[0]){o+=x[1];n-=x[0];}});return o;}return String(n);}
function txtEl(b,cls){return '<div class="nt-txt'+(cls?' '+cls:'')+'" contenteditable="true" spellcheck="true" data-ph="'+H(PH[b.type]||'')+'">'+(b.html||'')+'</div>';}
function mediaPh(b){var it=slashItem(b.sub||b.type)||{i:'📎',t:b.type};return '<div class="nt-ph" data-act="media" contenteditable="false"><span style="font-size:18px">'+it.i+'</span>'+(b.uploading?L('Uploader ','Uploading ')+H(b.uploading)+'… <span class="nt-spin"></span>':L('Tilføj ','Add ')+it.t.toLowerCase())+'</div>';}
function mtools(b,extra){return '<div class="nt-mtools" contenteditable="false">'+(extra||'')+'<button data-act="media" title="'+L('Erstat','Replace')+'">↻</button>'+(b.url?'<a href="'+H(b.url)+'" target="_blank" rel="noopener" title="'+L('Åbn','Open')+'">↗</a>':'')+'</div>';}
function renderBlock(b,o){
  var t=b.type,ind=b.indent||0,inner='';
  var cls='nt-b nt-t-'+t+(o.hidden?' nt-hide':'')+(b.color?' nt-c-'+b.color:'')+(b.bg&&t!=='callout'?' nt-bg-'+b.bg:'')+(S.sel.indexOf(b.id)>-1&&!S.xsel?' nt-selb':'')+((t==='todo'||(isTog(t)&&b.todo))&&b.checked?' nt-done':'')+(b.fs?(typeof b.fs==='number'?' nt-fsn':' nt-fs-'+b.fs):'')+(isTog(t)&&b.todo?' nt-ttodo':'')+(b.al==='center'||b.al==='right'?' nt-al-'+b.al:'');
  if(t==='p'||t==='h1'||t==='h2'||t==='h3')inner=txtEl(b);
  else if(t==='bullet')inner='<div class="nt-row"><span class="nt-pre nt-dot" contenteditable="false">'+['•','◦','▪'][ind%3]+'</span>'+txtEl(b)+'</div>';
  else if(t==='num')inner='<div class="nt-row"><span class="nt-pre nt-numl" contenteditable="false">'+numLabel(o.n||1,ind)+'.</span>'+txtEl(b)+'</div>';
  else if(t==='todo')inner='<div class="nt-row"><span class="nt-pre" contenteditable="false"><input type="checkbox" class="nt-chk" data-act="check"'+(b.checked?' checked':'')+'></span>'+txtEl(b)+'</div>';
  else if(isTog(t)){
    var hasKids=o.list&&o.i+1<o.list.length&&(o.list[o.i+1].indent||0)>ind;
    inner='<div class="nt-row"><button class="nt-pre nt-caret'+(b.open?' open':'')+'" data-act="toggle" contenteditable="false" tabindex="-1">▶</button>'+(b.todo?'<span class="nt-pre nt-tchk" contenteditable="false"><input type="checkbox" class="nt-chk" data-act="check"'+(b.checked?' checked':'')+'></span>':'')+txtEl(b)+'</div>'+(b.open&&!hasKids?'<div class="nt-tempty" data-act="tchild" contenteditable="false">'+L('Tom toggle. Klik eller træk blokke ind.','Empty toggle. Click or drop blocks inside.')+'</div>':'');
  }
  else if(t==='quote')inner=txtEl(b);
  else if(t==='callout')inner='<div class="nt-call nt-bg-'+(b.bg||'gray')+'"><button class="nt-cicon" data-act="cicon" contenteditable="false">'+H(b.icon||'💡')+'</button>'+txtEl(b)+'</div>';
  else if(t==='divider')inner='<div class="nt-div" data-act="selb" contenteditable="false"><hr></div>';
  else if(t==='code')inner='<div class="nt-code"><div class="nt-code-bar"><select data-act="clang">'+['Tekst','JavaScript','HTML','CSS','SQL','JSON','Python','Bash','Markdown'].map(function(x){var lbl=x==='Tekst'?L('Tekst','Plain text'):x;return '<option'+((b.lang||'')===lbl||(b.lang||'')===x?' selected':'')+'>'+lbl+'</option>';}).join('')+'</select><button data-act="ccopy">'+L('Kopiér','Copy')+'</button></div><textarea class="nt-code-txt" spellcheck="false" rows="1" placeholder="'+L('Skriv eller indsæt kode…','Type or paste code…')+'">'+H(b.code||'')+'</textarea></div>';
  else if(t==='table'){
    var rows=b.rows&&b.rows.length?b.rows:[['']];
    inner='<div class="nt-tblo" contenteditable="false"><div class="nt-tbar" data-keep="1"><button data-act="t:hdr">'+(b.header?'✓ ':'')+L('Overskriftsrække','Header row')+'</button><button data-act="t:ra">↑ '+L('Række','Row')+'</button><button data-act="t:rb">↓ '+L('Række','Row')+'</button><button data-act="t:cl">← '+L('Kolonne','Column')+'</button><button data-act="t:cr">→ '+L('Kolonne','Column')+'</button><button data-act="t:dr">✕ '+L('Række','Row')+'</button><button data-act="t:dc">✕ '+L('Kolonne','Column')+'</button></div><div class="nt-tblw">'+
      '<table class="nt-tbl'+(b.header?' nt-thd':'')+'">'+rows.map(function(r,ri){return '<tr>'+r.map(function(c,ci){return '<td><div class="nt-cell" contenteditable="true" data-r="'+ri+'" data-c="'+ci+'">'+(c||'')+'</div></td>';}).join('')+'</tr>';}).join('')+'</table>'+
      '<button class="nt-tadd nt-tadd-r" data-act="t:add-r" title="'+L('Ny række','New row')+'">＋</button><button class="nt-tadd nt-tadd-c" data-act="t:add-c" title="'+L('Ny kolonne','New column')+'">＋</button></div></div>';
  }
  else if(t==='image'){
    inner=!b.url?mediaPh(b):'<figure class="nt-fig w-'+(b.width||'l')+'" contenteditable="false"><img src="'+H(b.url)+'" alt="'+H(plain(b.caption))+'" data-act="zoom" loading="lazy">'+
      mtools(b,['s','m','l'].map(function(w){return '<button data-act="w:'+w+'" class="'+((b.width||'l')===w?'on':'')+'">'+w.toUpperCase()+'</button>';}).join(''))+
      '<figcaption class="nt-cap" contenteditable="true" data-ph="'+L('Tilføj billedtekst…','Write a caption…')+'">'+(b.caption||'')+'</figcaption></figure>';
  }
  else if(t==='video'){
    if(!b.url)inner=mediaPh(b);
    else{var em=embedInfo(b.url);inner=em.kind!=='web'?embedHtml(b):'<div class="nt-vid" contenteditable="false"><video src="'+H(b.url)+'" controls preload="metadata"></video>'+mtools(b)+'</div>';}
  }
  else if(t==='audio')inner=!b.url?mediaPh(b):'<div class="nt-aud" contenteditable="false"><audio src="'+H(b.url)+'" controls preload="metadata"></audio><div class="nt-capd">🎧 '+H(b.name||'')+'</div></div>';
  else if(t==='file')inner=!b.url?mediaPh(b):'<a class="nt-file" href="'+H(b.url)+'" target="_blank" rel="noopener" contenteditable="false"><span style="font-size:20px">📎</span><span class="nt-file-n">'+H(b.name||b.url)+'</span><span class="nt-file-s">'+(b.size?fmtSize(b.size):'')+'</span></a>';
  else if(t==='pdf')inner=!b.url?mediaPh(b):'<div class="nt-pdf" contenteditable="false"><div class="nt-pdf-h">📕 '+H(b.name||'PDF')+'<a href="'+H(b.url)+'" target="_blank" rel="noopener">'+L('Åbn','Open')+' ↗</a></div><iframe src="'+H(b.url)+'" loading="lazy"></iframe></div>';
  else if(t==='bookmark'){
    if(!b.url)inner=mediaPh(b);
    else{var host='';try{host=new URL(b.url).hostname;}catch(e){}
      inner='<a class="nt-bm" href="'+H(b.url)+'" target="_blank" rel="noopener" contenteditable="false"><div class="nt-bm-t"><div class="nt-bm-ti">'+H(b.title||host||b.url)+'</div><div class="nt-bm-d">'+H(b.desc||'')+'</div><div class="nt-bm-u"><img src="https://www.google.com/s2/favicons?domain='+encodeURIComponent(host)+'&sz=32" alt="">'+H(b.url)+'</div></div>'+(b.image?'<div class="nt-bm-img" style="background-image:'+cssUrl(b.image)+'"></div>':'')+'</a>';}
  }
  else if(t==='embed')inner=!b.url?mediaPh(b):embedHtml(b);
  else if(t==='tabs'){
    var act=Math.min(b.active||0,(b.cols||[]).length-1);if(act<0)act=0;
    inner='<div class="nt-tabsb"><div class="nt-tabbar" contenteditable="false">'+(b.titles||[]).map(function(ti,i){return '<div class="nt-tab'+(i===act?' on':'')+'" data-act="tab" data-ti="'+i+'"><span class="nt-tab-t" data-ti="'+i+'" contenteditable="'+(i===act?'true':'false')+'" spellcheck="false" data-ph="'+L('Uden navn','Untitled')+'">'+H(ti)+'</span>'+(i===act?'<button class="nt-tabm" data-act="tabmenu" data-ti="'+i+'" title="'+L('Fanemenu','Tab menu')+'">▾</button>':'')+'</div>';}).join('')+
      '<button class="nt-tabadd" data-act="tabadd" title="'+L('Ny fane','New tab')+'">＋</button></div><div class="nt-tabpane">'+renderList((b.cols||[])[act]||[])+'</div></div>';
  }
  else if(t==='columns'){var cw=colWidths(b);inner='<div class="nt-cols">'+(b.cols||[]).map(function(c,i){return (i?'<div class="nt-colrs" data-ci="'+(i-1)+'" contenteditable="false"><i title="'+L('Træk for at ændre bredden · dobbeltklik for lige store','Drag to resize · double-click to reset')+'"></i></div>':'')+'<div class="nt-col" data-col="'+i+'" style="flex:'+(cw[i]*100).toFixed(2)+' 1 0">'+renderList(c)+'</div>';}).join('')+'</div>';}
  else if(t==='toc'){var hs=headings();inner='<div class="nt-toc" contenteditable="false">'+(hs.length?hs.map(function(x){return '<a data-act="tocgo" data-to="'+x.id+'" class="lv'+x.lv+'">'+H(x.t)+'</a>';}).join(''):'<div class="nt-toc-e">'+L('Tilføj overskrifter, så vises de her.','Add headings to build a table of contents.')+'</div>')+'</div>';}
  else if(t==='page'){var pg=S.byId[b.pageId];inner='<a class="nt-pg'+(pg?'':' gone')+'" href="#kb-notes/'+(+b.pageId||0)+'" data-act="open" data-pid="'+(+b.pageId||0)+'" contenteditable="false"><span class="nt-pg-ic">'+H(pg&&pg.icon||'📄')+'</span><span class="nt-pg-t">'+H(pg?(pg.title||L('Uden titel','Untitled')):L('Slettet side eller ingen adgang','Deleted page or no access'))+'</span></a>';}
  else if(t==='remind'){
    var past=b.at&&new Date(b.at)<new Date();
    inner='<div class="nt-rem"><span contenteditable="false">🔔</span>'+txtEl(b)+'<input type="datetime-local" data-act="remat" value="'+H(b.at?isoLocal(b.at):'')+'"><select data-act="remwho">'+(S.people||[{id:me&&me.id,name:me&&me.name||L('Mig','Me')}]).map(function(u){return '<option value="'+u.id+'"'+(+u.id===+(b.userId||(me&&me.id))?' selected':'')+'>'+H(u.name)+'</option>';}).join('')+'</select><span class="nt-rem-st">'+(past?'✓ '+L('Sendt','Sent'):'')+'</span></div>';
  }
  else inner=txtEl(b);
  return '<div class="'+cls+'" data-id="'+H(b.id)+'" style="--ind:'+ind+(typeof b.fs==='number'?';--fs:'+b.fs+'px':'')+'"><div class="nt-hdl" contenteditable="false"><button class="nt-hb" data-act="addb" tabindex="-1" title="'+L('Klik for at tilføje en blok nedenfor','Click to add a block below')+'">＋</button><span class="nt-hb nt-grip" draggable="true" data-act="bmenu" title="'+L('Træk for at flytte · klik for menu','Drag to move · click for menu')+'">⋮⋮</span></div><div class="nt-bc">'+inner+'</div></div>';
}
function embedInfo(u){
  var m,s=String(u||'');
  if((m=s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/)))return {kind:'yt',src:'https://www.youtube.com/embed/'+m[1],label:'YouTube'};
  if((m=s.match(/vimeo\.com\/(?:video\/)?(\d+)/)))return {kind:'vimeo',src:'https://player.vimeo.com/video/'+m[1],label:'Vimeo'};
  if((m=s.match(/loom\.com\/(?:share|embed)\/([\w]+)/)))return {kind:'loom',src:'https://www.loom.com/embed/'+m[1],label:'Loom'};
  if(/figma\.com\/(file|design|proto|board)\//.test(s))return {kind:'figma',src:'https://www.figma.com/embed?embed_host=share&url='+encodeURIComponent(s),label:'Figma'};
  if((m=s.match(/drive\.google\.com\/file\/d\/([\w-]+)/)))return {kind:'drive',src:'https://drive.google.com/file/d/'+m[1]+'/preview',label:'Google Drive'};
  if((m=s.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/)))return {kind:'drive',src:'https://docs.google.com/'+m[1]+'/d/'+m[2]+'/preview',label:'Google '+({document:'Docs',spreadsheets:'Sheets',presentation:'Slides'})[m[1]]};
  if((m=s.match(/docs\.google\.com\/forms\/d\/(?:e\/)?([\w-]+)/)))return {kind:'drive',src:'https://docs.google.com/forms/d/e/'+m[1]+'/viewform?embedded=true',label:'Google Forms'};
  if(/google\.[a-z.]+\/maps|maps\.google\./.test(s)){
    if(/output=embed|\/maps\/embed/.test(s))return {kind:'maps',src:s,label:'Google Maps'};
    if((m=s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)))return {kind:'maps',src:'https://maps.google.com/maps?q='+m[1]+','+m[2]+'&z=15&output=embed',label:'Google Maps'};
    if((m=s.match(/\/place\/([^\/@?]+)/)))return {kind:'maps',src:'https://maps.google.com/maps?q='+encodeURIComponent(decodeURIComponent(m[1]).replace(/\+/g,' '))+'&output=embed',label:'Google Maps'};
    if((m=s.match(/[?&]q=([^&]+)/)))return {kind:'maps',src:'https://maps.google.com/maps?q='+m[1]+'&output=embed',label:'Google Maps'};
  }
  return {kind:'web',src:s,label:(function(){try{return new URL(s).hostname.replace(/^www\./,'');}catch(e){return 'Web';}})()};
}
function embedHtml(b){var e=embedInfo(b.url);return '<div class="nt-emb k-'+e.kind+'" contenteditable="false"><iframe src="'+H(e.src)+'" loading="lazy" allowfullscreen allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe><div class="nt-emb-f"><span>'+H(e.label)+'</span><a href="'+H(b.url)+'" target="_blank" rel="noopener">'+L('Åbn i ny fane','Open in new tab')+' ↗</a></div>'+mtools(b)+'</div>';}

function editTabTitle(id,i){var el=$('.nt-b[data-id="'+id+'"] .nt-tab-t[data-ti="'+i+'"]');if(!el)return;el.focus();var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);}
function revealBlock(id){var f=find(id),changedTab=false,g=0;while(f&&f.owner&&g++<6){if(f.owner.type==='tabs'&&(f.owner.active||0)!==f.col){f.owner.active=f.col;changedTab=true;}f=find(f.owner.id);}if(changedTab)renderDoc();return changedTab;}
function tabMenu(id,i,anchor){
  var f=find(id);if(!f)return;var b=f.b,n=b.cols.length;
  var el=pop(anchor,'<button class="nt-mi" data-a="ren"><span class="nt-mi-i">✏️</span>'+L('Omdøb','Rename')+'</button>'+(i>0?'<button class="nt-mi" data-a="left"><span class="nt-mi-i">←</span>'+L('Flyt til venstre','Move left')+'</button>':'')+(i<n-1?'<button class="nt-mi" data-a="right"><span class="nt-mi-i">→</span>'+L('Flyt til højre','Move right')+'</button>':'')+'<button class="nt-mi" data-a="dup"><span class="nt-mi-i">⧉</span>'+L('Duplikér fane','Duplicate tab')+'</button><div class="nt-sep"></div><button class="nt-mi" data-a="del"><span class="nt-mi-i">🗑</span>'+L('Slet fane','Delete tab')+'</button>',{type:'list',cls:'small',width:220});
  hl($$('.nt-mi',el),-1);
  el.addEventListener('click',function(e){var x=e.target.closest('[data-a]');if(!x)return;closePop();var a=x.dataset.a,to=i;
    if(a==='ren'){editTabTitle(id,i);return;}
    if(a==='del'){if(n<=1){toast(L('Der skal være mindst én fane','A tab block needs at least one tab'),'ℹ️');return;}
      if(walkCount(b.cols[i])&&!confirm(L('Slet fanen og dens indhold?','Delete this tab and its content?')))return;}
    op(function(){
      if(a==='left'||a==='right'){to=a==='left'?i-1:i+1;var c=b.cols.splice(i,1)[0],t=b.titles.splice(i,1)[0];b.cols.splice(to,0,c);b.titles.splice(to,0,t);}
      else if(a==='dup'){var cc=clone(b.cols[i]);walk(cc,function(y){y.id=uid();});b.cols.splice(i+1,0,cc);b.titles.splice(i+1,0,(b.titles[i]||'')+L(' (kopi)',' (copy)'));to=i+1;}
      else if(a==='del'){b.cols.splice(i,1);b.titles.splice(i,1);to=Math.min(i,b.cols.length-1);}
      b.active=to;});
    renderDoc();});
}
function walkCount(list){var n=0;walk(list,function(x){if(x.type!=='p'||plain(x.html).trim())n++;});return n;}
function colWidths(b){var n=(b.cols||[]).length,w=b.widths;if(!Array.isArray(w)||w.length!==n)return new Array(n).fill(1/Math.max(1,n));var sum=w.reduce(function(a,x){return a+(+x||0);},0)||1;return w.map(function(x){return (+x||0)/sum;});}
function colResize(e,rs){
  var be=rs.closest('.nt-b'),f=find(be.dataset.id);if(!f)return;var b=f.b,i=+rs.dataset.ci,wrap=rs.parentElement;
  var cols=$$(':scope > .nt-col',wrap),total=cols.reduce(function(a,c){return a+c.getBoundingClientRect().width;},0);if(!total)return;
  var w=colWidths(b),x0=e.clientX,a0=w[i],b0=w[i+1],min=Math.max(0.08,120/total);
  e.preventDefault();rs.classList.add('on');document.body.classList.add('nt-resizing');snapshot();
  function mv(ev){var d=(ev.clientX-x0)/total,na=Math.max(min,Math.min(a0+b0-min,a0+d));w[i]=na;w[i+1]=a0+b0-na;cols[i].style.flex=(w[i]*100).toFixed(2)+' 1 0';cols[i+1].style.flex=(w[i+1]*100).toFixed(2)+' 1 0';}
  function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);rs.classList.remove('on');document.body.classList.remove('nt-resizing');b.widths=w.map(function(x){return Math.round(x*1000)/1000;});snapshot();changed();}
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);
}
function renderDoc(focus){
  var d=$('#nt-doc');if(!d||!S.page)return;
  ensureNotEmpty();
  d.innerHTML=renderList(S.page.blocks);
  $$('.nt-code-txt',d).forEach(autoGrow);
  if(selBarEl)posSelBar();
  if(focus)focusBlock(focus.id,focus.pos);
}
function rerenderKeep(){ // gentegn, men behold markøren hvor den er
  var a=document.activeElement,be=a&&a.closest&&a.closest('.nt-b'),pos=null;
  if(be&&a.classList.contains('nt-txt'))pos=caretOffset(a);else if(be&&a.tagName==='TEXTAREA')pos=a.selectionStart;
  renderDoc(be?{id:be.dataset.id,pos:pos==null?'end':pos}:null);
}
function autoGrow(t){t.style.height='auto';t.style.height=(t.scrollHeight+2)+'px';}

// ── markør ──────────────────────────────────────────────────
function caretOffset(el){var s=getSelection();if(!s.rangeCount)return 0;var r=s.getRangeAt(0);if(!el.contains(r.startContainer))return 0;var pre=document.createRange();pre.selectNodeContents(el);pre.setEnd(r.startContainer,r.startOffset);return pre.toString().length;}
function setCaret(el,off){
  if(!el)return;el.focus();
  if(el.tagName==='TEXTAREA'){var n=off==='end'?el.value.length:(off==='start'?0:Math.min(+off||0,el.value.length));el.setSelectionRange(n,n);return;}
  var r=document.createRange(),rem=off==='start'?0:off==='end'?Infinity:+off||0,done=false;
  (function w(n){for(var c=n.firstChild;c&&!done;c=c.nextSibling){
    if(c.nodeType===3){if(rem<=c.length){r.setStart(c,rem);done=true;return;}rem-=c.length;}
    else if(c.nodeType===1){if(c.getAttribute('contenteditable')==='false'){var l=c.textContent.length;if(rem===0){r.setStartBefore(c);done=true;return;}if(rem<=l){r.setStartAfter(c);done=true;return;}rem-=l;}else w(c);}
  }})(el);
  if(!done){r.selectNodeContents(el);r.collapse(false);}else r.collapse(true);
  var s=getSelection();s.removeAllRanges();s.addRange(r);
}
function focusBlock(id,pos){
  var be=$('.nt-b[data-id="'+id+'"]');if(!be)return;
  var el=$('.nt-bc .nt-txt',be)||$('.nt-code-txt',be)||$('.nt-cell',be)||$('.nt-cap',be);
  if(el&&el.closest('.nt-b')===be){setCaret(el,pos==null?'end':pos);el.scrollIntoView({block:'nearest'});}
  else selectBlocks([id]);
}
function editables(){return $$('#nt-doc .nt-txt, #nt-doc .nt-code-txt').filter(function(e){return !e.closest('.nt-hide');});}
function lineEdge(el,up){
  if(el.tagName==='TEXTAREA'){var v=el.value,p=el.selectionStart;return up?v.lastIndexOf('\n',p-1)===-1:v.indexOf('\n',p)===-1;}
  var s=getSelection();if(!s.rangeCount)return true;var r=s.getRangeAt(0).cloneRange();r.collapse(true);
  var rect=r.getClientRects()[0];if(!rect){var tmp=document.createElement('span');tmp.textContent='\u200b';r.insertNode(tmp);rect=tmp.getBoundingClientRect();tmp.remove();}
  var er=el.getBoundingClientRect(),lh=parseFloat(getComputedStyle(el).lineHeight)||22;
  return up?rect.top-er.top<lh*0.8:er.bottom-rect.bottom<lh*0.8;
}
function moveFocus(el,dir,pos){var a=editables(),i=a.indexOf(el),n=a[i+dir];if(!n)return false;setCaret(n,pos);n.scrollIntoView({block:'nearest'});return true;}
function norm(html){var s=String(html||'');if(/^(\s|<br\s*\/?>)*$/i.test(s))return '';s=s.replace(/\u200b/g,'');for(var k=0;k<3;k++)s=s.replace(/<(b|i|u|s|strong|em|code|span|mark|strike|font)(\s[^>]*)?><\/\1>/gi,'');return s.replace(/<br\s*\/?>$/i,'');}

// ── gem / fortryd ───────────────────────────────────────────
// 3-vejs fletning af blokke (base = sidst fælles udgave, mine = mine ændringer, theirs = den gemte udgave)
function nbMerge(B, M, T) {
  var canon = function (x) { if (Array.isArray(x)) return x.map(canon); if (x && typeof x === 'object') { var o = {}; Object.keys(x).sort().forEach(function (k) { var v = x[k]; if (v !== undefined && v !== null && v !== '' && v !== false) o[k] = canon(v); }); return o; } return x; };
  var J = function (x) { return JSON.stringify(canon(x === undefined ? null : x)); };
  var map = function (l) { var o = {}; (l || []).forEach(function (b) { if (b && b.id) o[b.id] = b; }); return o; };
  function block(b, m, t) {
    if (!b) return m;
    if (J(m) === J(b)) return t;
    if (J(t) === J(b) || J(t) === J(m)) return m;
    var o = {}, keys = {};
    [b, m, t].forEach(function (x) { Object.keys(x).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var v;
      if (k === 'cols' && Array.isArray(m.cols) && Array.isArray(t.cols) && Array.isArray(b.cols) && m.cols.length === t.cols.length && b.cols.length === m.cols.length) {
        v = m.cols.map(function (c, i) { return list(b.cols[i], c, t.cols[i]); });
      } else v = J(m[k]) === J(b[k]) ? t[k] : m[k];
      if (v !== undefined) o[k] = v;
    });
    return o;
  }
  function list(B, M, T) {
    B = B || []; M = M || []; T = T || [];
    var bm = map(B), mm = map(M), tm = map(T), out = {};
    var keep = function (id) {
      var b = bm[id], m = mm[id], t = tm[id];
      if (m && t) return block(b, m, t);
      if (m) return !b ? m : (J(m) !== J(b) ? m : null); // de har slettet – behold kun hvis jeg har ændret den
      if (t) return !b ? t : (J(t) !== J(b) ? t : null); // jeg har slettet – behold kun hvis de har ændret den
      return null;
    };
    var ord = function (l) { return l.filter(function (x) { return x && bm[x.id] && mm[x.id] && tm[x.id]; }).map(function (x) { return x.id; }).join(','); };
    var theyMoved = ord(T) !== ord(B);
    var P = theyMoved ? T : M, S = theyMoved ? M : T, res = [];
    P.forEach(function (x) { if (!x || out[x.id]) return; var v = keep(x.id); if (v) { out[x.id] = 1; res.push(v); } });
    S.forEach(function (x, i) {
      if (!x || out[x.id]) return; var v = keep(x.id); if (!v) return;
      var at = 0; for (var j = i - 1; j >= 0; j--) { var k = res.findIndex(function (r) { return r.id === S[j].id; }); if (k > -1) { at = k + 1; break; } }
      out[x.id] = 1; res.splice(at, 0, v);
    });
    return res;
  }
  return list(B, M, T);
}

function markDirty(fields){
  if(!S.page)return;Object.assign(S.pending,fields||{blocks:true});
  setStatus(L('Gemmer…','Saving…'));
  clearTimeout(S.saveT);S.saveT=setTimeout(save,700);
  clearTimeout(S.snapT);S.snapT=setTimeout(snapshot,900);
}
function changed(){markDirty({blocks:true});}
function setStatus(t){var e=$('#nt-status');if(e)e.textContent=t;}
async function save(force){
  clearTimeout(S.saveT);if(!S.page||!Object.keys(S.pending).length)return;
  if(S.saving){S.again=true;return;}
  var p=S.page,body={base_updated_at:p.updated_at},sentStr=null;if(force)body.force=true;
  Object.keys(S.pending).forEach(function(k){body[k]=k==='blocks'?p.blocks:p[k];});
  if(S.pending.blocks){sentStr=JSON.stringify(p.blocks);try{body.base_blocks=JSON.parse(S.base||'[]');}catch(e){}}
  var sent=S.pending;S.pending={};S.saving=true;S.saveN=(S.saveN||0)+1;
  var r=await api('/api/notes/'+p.id,{method:'PUT',body:JSON.stringify(body)});
  S.saving=false;
  if(S.page!==p){if(S.again){S.again=false;}return;}
  if(r&&r.ok&&sentStr!=null){
    if(r.blocks){applyRemote(JSON.parse(sentStr),r.blocks);}else S.base=sentStr;
  }
  if(r&&r.conflict){S.pending=Object.assign(sent,S.pending);showConflict(r);setStatus(L('Ikke gemt','Not saved'));return;}
  if(!r||r.ok===false){S.pending=Object.assign(sent,S.pending);setStatus(L('Ikke gemt – prøver igen','Not saved – retrying'));S.saveT=setTimeout(save,4000);return;}
  p.updated_at=r.updated_at;p.updated_by=me&&me.id;setStatus(L('Gemt','Saved'));
  if(S.again){S.again=false;save();}
}
function flush(){if(S.page&&Object.keys(S.pending).length){var p=S.page,body={base_updated_at:p.updated_at};Object.keys(S.pending).forEach(function(k){body[k]=k==='blocks'?p.blocks:p[k];});S.pending={};
  var str=JSON.stringify(body);if(body.blocks&&S.base){var withBase=str.slice(0,-1)+',"base_blocks":'+S.base+'}';if(withBase.length<60000)str=withBase;}
  try{fetch('/api/notes/'+p.id,{method:'PUT',keepalive:true,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:str});}catch(e){}}}
// Flet en udgave fra serveren ind i det der står på skærmen (base = det mine ændringer bygger på)
function applyRemote(base,theirs){
  var mine=S.page.blocks,before=JSON.stringify(mine),merged=nbMerge(base,mine,theirs);
  S.base=JSON.stringify(theirs);S.page.blocks=merged;
  var now=JSON.stringify(merged);if(now!==before){S.snap=now;rerenderKeep();}
}
// Hent kollegers ændringer løbende mens siden er åben
async function pullRemote(){
  if(!S.page||!isActive()||S.saving||S.composing||S.menu||(S.sel&&S.sel.length)||document.visibilityState!=='visible')return;
  var ae=document.activeElement;if(ae&&ae.closest&&ae.closest('.nt-cell,.nt-cap,.nt-title'))return;
  var p=S.page,n=S.saveN;
  var r=await api('/api/notes/'+p.id);
  if(!r||r.id!==p.id||S.page!==p||S.saving||S.saveN!==n||S.composing||r.updated_at===p.updated_at)return;
  var base;try{base=JSON.parse(S.base||'[]');}catch(e){base=[];}
  p.updated_at=r.updated_at;p.updated_by=r.updated_by;p.updated_by_name=r.updated_by_name;
  ['title','icon','cover_url','cover_pos','full_width','text_size'].forEach(function(k){if(!S.pending[k]&&JSON.stringify(p[k])!==JSON.stringify(r[k])){p[k]=r[k];if(k==='title'){var te=$('.nt-title');if(te&&document.activeElement!==te)te.textContent=r.title||'';if(S.byId[p.id])S.byId[p.id].title=r.title;}}});
  applyRemote(base,r.blocks||[]);
}
function showConflict(r){
  var c=$('#nt-conf');if(!c)return;
  c.innerHTML='<div class="nt-conf">⚠️ <span style="flex:1">'+H(r.updated_by_name||L('En kollega','A colleague'))+L(' har ændret siden imens. ',' changed this page meanwhile. ')+'</span><button data-act="conf-reload">'+L('Hent deres version','Load their version')+'</button><button data-act="conf-force">'+L('Gem min version','Keep mine')+'</button></div>';
}
function snapshot(){if(!S.page)return;var cur=JSON.stringify(S.page.blocks);if(cur!==S.snap){S.undo.push(S.snap);if(S.undo.length>100)S.undo.shift();S.snap=cur;S.redo=[];}}
function op(fn){snapshot();fn();snapshot();changed();}
function undo(redo){
  snapshot();var from=redo?S.redo:S.undo,to=redo?S.undo:S.redo;if(!from.length)return;
  var before=S.page.blocks;to.push(S.snap);S.snap=from.pop();S.page.blocks=JSON.parse(S.snap);S.lastTypeSnap=0;
  // find den blok der ændrede sig, så markøren lander dér
  var flat=function(l){var o=[];walk(l,function(x){o.push(x);});return o;},A=flat(before),B=flat(S.page.blocks),hit=null;
  for(var i=0;i<Math.max(A.length,B.length);i++){var a=A[i],b2=B[i];if(!a||!b2||a.id!==b2.id||JSON.stringify(a)!==JSON.stringify(b2)){hit=b2&&isTxt(b2.type)?b2:(B[i-1]&&isTxt(B[i-1].type)?B[i-1]:null);break;}}
  S.sel=[];S.xsel=null;try{clearHL();}catch(x){}renderDoc(hit?{id:hit.id,pos:'end'}:null);changed();selBar();
  if(!hit){var last=editables().pop();if(last)setCaret(last,'end');}
  toast2(redo?L('Gendannet','Redone'):L('Fortrudt','Undone'));
}

// ── strukturændringer ──────────────────────────────────────
function insertAfter(id,nb,skipGroup){
  var f=find(id);if(!f){S.page.blocks.push(nb);return;}
  var at=skipGroup?groupEnd(f.list,f.i):f.i+1;
  if(nb.indent==null&&!skipGroup)nb.indent=f.b.indent||0;
  f.list.splice(at,0,nb);return nb;
}
function turnInto(b,type){
  if(type===b.type)return;
  var wasTxt=isTxt(b.type),willTxt=isTxt(type);
  if(wasTxt&&type==='code'){b.code=plain(b.html);delete b.html;}
  else if(b.type==='code'&&willTxt){b.html=H(b.code||'');delete b.code;}
  var d=defaults(type);Object.keys(d).forEach(function(k){if(b[k]==null)b[k]=d[k];});
  if(isTog(type)&&!isTog(b.type)){var fk=find(b.id),nx=fk&&fk.list[fk.i+1];b.open=!!(nx&&(nx.indent||0)>(b.indent||0));} // har den allerede indhold under sig, vises det
  if(!isTog(type)){delete b.open;delete b.todo;}if(type!=='todo'&&!(isTog(type)&&b.todo))delete b.checked;
  if(type!=='callout'){delete b.icon;if(b.type==='callout')delete b.bg;}
  b.type=type;
}
function removeBlock(id,withGroup){
  var f=find(id);if(!f)return null;var end=withGroup?groupEnd(f.list,f.i):f.i+1;
  var g=f.list.splice(f.i,end-f.i);
  if(f.owner&&!f.list.length)cleanupCols(f.owner);
  return {g:g,f:f};
}
function deleteBlocks(ids){
  op(function(){
    var first=find(ids[0]),prevId=null;
    if(first){var pv=first.list[first.i-1];prevId=pv&&pv.id;}
    ids.forEach(function(id){removeBlock(id,true);});
    S.sel=[];ensureNotEmpty();renderDoc(prevId?{id:prevId,pos:'end'}:null);
    if(!prevId){var e=editables()[0];if(e)setCaret(e,'start');}
  });
}
function duplicateBlock(id){
  op(function(){var f=find(id);if(!f)return;var end=groupEnd(f.list,f.i),g=clone(f.list.slice(f.i,end));
    g.forEach(function(x){walk([x],function(y){y.id=uid();});});
    f.list.splice.apply(f.list,[end,0].concat(g));renderDoc({id:g[0].id,pos:'end'});});
}
function moveBlock(id,dir){
  var f=find(id);if(!f)return;
  op(function(){
    var end=groupEnd(f.list,f.i),g=f.list.splice(f.i,end-f.i);
    if(dir<0){var j=f.i-1;if(j<0){f.list.splice.apply(f.list,[f.i,0].concat(g));return;}
      var ind=g[0].indent||0;while(j>0&&(f.list[j].indent||0)>ind)j--;f.list.splice.apply(f.list,[j,0].concat(g));}
    else{var k=f.i;if(k>=f.list.length){f.list.splice.apply(f.list,[k,0].concat(g));}else{var e2=groupEnd(f.list,k);f.list.splice.apply(f.list,[e2,0].concat(g));}}
  });
  rerenderKeep();if(S.sel.length)selectBlocks(S.sel);
}
function openAncestors(list,i){ // åbn lukkede toggles over blokken, så man kan skrive videre
  var ind=list[i].indent||0;for(var k=i-1;k>=0&&ind>0;k--){var x=list[k],xi=x.indent||0;if(xi<ind){if(isTog(x.type)&&!x.open)x.open=true;ind=xi;}}
}
function indentBlock(id,delta,solo){
  var f=find(id);if(!f)return;var b=f.b,ind=b.indent||0;
  if(delta>0){var prev=f.list[f.i-1];if(!prev||(prev.indent||0)<ind)return;if(ind>=10)return;}
  if(delta<0&&ind===0)return;
  op(function(){var end=solo?f.i+1:groupEnd(f.list,f.i);for(var i=f.i;i<end;i++)f.list[i].indent=Math.max(0,(f.list[i].indent||0)+delta);
    if(delta>0)openAncestors(f.list,f.i);});
  rerenderKeep();
}
function selectBlocks(ids){
  if(S.xsel){S.xsel=null;clearHL();}
  S.sel=ids.slice();$$('.nt-selb').forEach(function(e){e.classList.remove('nt-selb');});
  ids.forEach(function(id){var e=$('.nt-b[data-id="'+id+'"]');if(e)e.classList.add('nt-selb');});
  if(ids.length){var a=document.activeElement;if(a&&a.closest&&a.closest('#nt-doc'))a.blur();getSelection().removeAllRanges();}
  selBar();
}
// Blokke i læserækkefølge (uden kolonne-/fane-beholdere)
function leafEls(){return $$('#nt-doc .nt-b:not(.nt-hide)').filter(function(e){return !e.querySelector('.nt-b')&&!e.parentElement.closest('.nt-hide');});}
function rangeIds(a,b){var all=leafEls().map(function(e){return e.dataset.id;}),i=all.indexOf(a),j=all.indexOf(b);if(i<0||j<0)return [b];if(i>j){var t=i;i=j;j=t;}return all.slice(i,j+1);}
// Indryk/ryk ud for flere blokke på én gang (børn følger med, som i Notion)
function indentMany(ids,delta){
  var byList=[];
  ids.forEach(function(id){var f=find(id);if(!f)return;var g=byList.find(function(x){return x.list===f.list;});if(!g){g={list:f.list,idx:[]};byList.push(g);}g.idx.push(f.i);});
  var did=false;
  op(function(){byList.forEach(function(g){
    var mark={};g.idx.sort(function(a,b){return a-b;}).forEach(function(i){var e=groupEnd(g.list,i);for(var k=i;k<e;k++)mark[k]=1;});
    var keys=Object.keys(mark).map(Number).sort(function(a,b){return a-b;});
    // sammenhængende stykker
    var runs=[];keys.forEach(function(k){var r=runs[runs.length-1];if(r&&r[r.length-1]===k-1)r.push(k);else runs.push([k]);});
    runs.forEach(function(r){
      var first=g.list[r[0]],ind=first.indent||0;
      if(delta>0){var prev=g.list[r[0]-1];if(!prev||(prev.indent||0)<ind||ind>=10)return;if(isTog(prev.type))prev.open=true;}
      r.forEach(function(k){var b=g.list[k];var ni=Math.max(0,Math.min(10,(b.indent||0)+delta));if(ni!==(b.indent||0)){b.indent=ni;did=true;}});
      if(delta>0)openAncestors(g.list,r[0]);
    });
  });});
  var keep=S.sel.slice();renderDoc();reselect(keep);return did;
}
function selText(){
  var out=[];leafEls().forEach(function(el){if(S.sel.indexOf(el.dataset.id)<0)return;var f=find(el.dataset.id);if(!f)return;var b=f.b,t=b.html!=null?htmlToMd(b.html):(b.code||(b.rows?b.rows.map(function(r){return r.map(plain).join('\t');}).join('\n'):b.url||''));
    var pre={h1:'# ',h2:'## ',h3:'### ',th1:'# ',th2:'## ',th3:'### ',bullet:'- ',num:'1. ',todo:b.checked?'- [x] ':'- [ ] ',quote:'> ',toggle:'- '}[b.type]||'';out.push('  '.repeat(b.indent||0)+pre+t);});
  return out.join('\n');
}
// ── flydende markering på tværs af blokke (som i Notion) ────
// S.xsel = {a,ao,f,fo}: anker-blok + tegn-position og fokus-blok + tegn-position.
// Markeringen tegnes med CSS Highlight API, så den ligner almindelig tekstmarkering.
var HLOK=!!(window.CSS&&window.CSS.highlights)&&typeof Highlight!=='undefined';
function txtOf(el){if(!el)return null;var t=$('.nt-bc .nt-txt',el);return t&&t.closest('.nt-b')===el?t:null;}
function pointAt(el,off){
  var rem=Math.max(0,off||0),res=null;
  (function w(n){for(var c=n.firstChild;c&&!res;c=c.nextSibling){
    if(c.nodeType===3){if(rem<=c.length){res=[c,rem];return;}rem-=c.length;}
    else if(c.nodeType===1){if(c.getAttribute('contenteditable')==='false'){var l=c.textContent.length,idx=Array.prototype.indexOf.call(n.childNodes,c);if(rem===0){res=[n,idx];return;}if(rem<=l){res=[n,idx+1];return;}rem-=l;}else w(c);}
  }})(el);
  return res||[el,el.childNodes.length];
}
function rangeIn(el,a,b){var r=document.createRange(),x=pointAt(el,a),y=pointAt(el,b);r.setStart(x[0],x[1]);r.setEnd(y[0],y[1]);return r;}
function offAtPoint(el,x,y){
  var rc=el.getBoundingClientRect(),len=el.textContent.length;
  if(y<rc.top)return 0;if(y>rc.bottom)return len;
  var cx=Math.max(rc.left+1,Math.min(rc.right-1,x)),cy=Math.max(rc.top+2,Math.min(rc.bottom-2,y)),r=null;
  if(document.caretRangeFromPoint)r=document.caretRangeFromPoint(cx,cy);
  else if(document.caretPositionFromPoint){var p=document.caretPositionFromPoint(cx,cy);if(p){r=document.createRange();r.setStart(p.offsetNode,p.offset);}}
  if(!r||!el.contains(r.startContainer))return x<rc.left+rc.width/2?0:len;
  var pre=document.createRange();pre.selectNodeContents(el);pre.setEnd(r.startContainer,r.startOffset);return pre.toString().length;
}
function leafAt(x,y){var best=null,bd=1e12;leafEls().forEach(function(el){var r=el.getBoundingClientRect();if(!r.height)return;var dy=y<r.top?r.top-y:(y>r.bottom?y-r.bottom:0),dx=x<r.left?r.left-x:(x>r.right?x-r.right:0),d=dy*6+dx;if(d<bd){bd=d;best=el;}});return best;}
function offIn(el,x,y){var t=txtOf(el);return t?offAtPoint(t,x,y):0;}
function clearHL(){if(HLOK)window.CSS.highlights.delete('nt-sel');$$('.nt-selx').forEach(function(e){e.classList.remove('nt-selx');});S.hlFirst=null;}
function paintX(){
  var x=S.xsel;clearHL();$$('.nt-selb').forEach(function(e){e.classList.remove('nt-selb');});
  if(!x){S.sel=[];selBar();return;}
  var els=leafEls(),ids=els.map(function(e){return e.dataset.id;}),i=ids.indexOf(x.a),j=ids.indexOf(x.f);
  if(i<0||j<0){S.xsel=null;S.sel=[];selBar();return;}
  var a=x.ao||0,b=x.fo||0;if(i>j||(i===j&&a>b)){var t=i;i=j;j=t;t=a;a=b;b=t;}
  S.xr={s:a,e:b};S.sel=ids.slice(i,j+1);
  var hl=HLOK?new Highlight():null,first=null;
  for(var k=i;k<=j;k++){var el=els[k],tx=txtOf(el);
    if(!tx||!hl){el.classList.add('nt-selb');if(!first)first=el;continue;}
    var len=tx.textContent.length,s0=k===i?Math.min(a,len):0,e0=k===j?Math.min(b,len):len;
    if(!len){el.classList.add('nt-selx');if(!first)first=tx;continue;}
    if(s0<e0){var r=rangeIn(tx,s0,e0);hl.add(r);if(!first)first=r;}
  }
  if(hl)window.CSS.highlights.set('nt-sel',hl);
  S.hlFirst=first;hideStb();
  if(!(S.msel&&S.msel.on))selBar();
}
function startX(a,ao,f,fo){var ae=document.activeElement;if(ae&&ae.closest&&ae.closest('#nt-doc'))ae.blur();getSelection().removeAllRanges();S.xsel={a:a,ao:ao,f:f,fo:fo};paintX();}
function reselect(ids){if(S.xsel)paintX();else selectBlocks(ids);}
// Hver valgt tekstblok med det markerede stykke (hele blokken ved blokvalg)
function selRanges(){
  var out=[];S.sel.forEach(function(id,k){var el=txtOf($('.nt-b[data-id="'+id+'"]'));if(!el)return;var len=el.textContent.length,s0=0,e0=len;
    if(S.xsel&&S.xr){if(k===0)s0=Math.min(S.xr.s,len);if(k===S.sel.length-1)e0=Math.min(S.xr.e,len);}
    out.push({id:id,el:el,s:s0,e:e0});});
  return out;
}
function applyFmt(kind,arg){
  var rs=selRanges().filter(function(x){return x.s<x.e;});if(!rs.length)return;
  S.applying=true;snapshot();var desired=null,keep=S.sel.slice();
  rs.forEach(function(x){
    x.el.focus();var sl=getSelection();sl.removeAllRanges();sl.addRange(rangeIn(x.el,x.s,x.e));
    if(kind==='code')wrapSel('code');
    else if(kind==='color')applyColor(arg);
    else{var st=document.queryCommandState(kind);if(desired===null)desired=!st;if(st!==desired)document.execCommand(kind);}
    var f=find(x.id);if(f)f.b.html=norm(x.el.innerHTML);
  });
  getSelection().removeAllRanges();var ae=document.activeElement;if(ae&&ae.blur)ae.blur();
  S.applying=false;changed();snapshot();if(S.xsel)paintX();else selectBlocks(keep);
}
function hiddenKidIdx(list,i){var out=[],end=groupEnd(list,i);for(var k=i+1;k<end;k++)if(isHiddenIdx(list,k))out.push(k);return out;}
function removeHiddenKids(id){var f=find(id);if(!f)return;hiddenKidIdx(f.list,f.i).reverse().forEach(function(k){f.list.splice(k,1);});}
function removeWithHidden(id){var f=find(id);if(!f)return;var kids=hiddenKidIdx(f.list,f.i);kids.reverse().forEach(function(k){f.list.splice(k,1);});removeBlock(id,false);}
function deleteX(){
  var ids=S.sel.slice();if(!ids.length)return;
  if(!S.xsel||!S.xr){deleteBlocks(ids);return;}
  var x=S.xr,fe=txtOf($('.nt-b[data-id="'+ids[0]+'"]')),le=ids.length>1?txtOf($('.nt-b[data-id="'+ids[ids.length-1]+'"]')):null,focus=null;
  op(function(){
    var tail='',first=find(ids[0]),last=find(ids[ids.length-1]);
    if(le){rangeIn(le,0,Math.min(x.e,le.textContent.length)).deleteContents();tail=norm(le.innerHTML);}
    var lastFull=le&&x.e>=le.textContent.length;
    if(fe&&first){var len=fe.textContent.length;rangeIn(fe,Math.min(x.s,len),ids.length>1?len:Math.min(x.e,len)).deleteContents();first.b.html=norm(fe.innerHTML);
      // skjult indhold (under lukkede toggles) i det markerede slettes med – ellers bliver det liggende tilbage
      if(ids.length>1&&x.s===0)removeHiddenKids(first.b.id);
      ids.slice(1).forEach(function(id,k){var isLast=k===ids.length-2;if(!isLast||lastFull)removeWithHidden(id);else removeBlock(id,false);});
      first.b.html=norm((first.b.html||'')+tail);
      if(ids.length>1&&x.s===0&&!plain(first.b.html).trim()&&isTog(first.b.type))turnInto(first.b,'p');
      focus={id:first.b.id,pos:Math.min(x.s,len)};}
    else{ids.slice(0,le?-1:ids.length).forEach(function(id){removeWithHidden(id);});if(le&&last){last.b.html=tail;focus={id:last.b.id,pos:0};}}
    S.xsel=null;S.sel=[];clearHL();ensureNotEmpty();
  });
  renderDoc(focus);selBar();
}
function extendX(key){
  var x=S.xsel,els=leafEls(),ids=els.map(function(e){return e.dataset.id;}),fi=ids.indexOf(x.f);
  var len=function(id){var t=txtOf(els[ids.indexOf(id)]);return t?t.textContent.length:0;};
  if(key==='ArrowDown'){if(fi<ids.length-1){x.f=ids[fi+1];x.fo=len(x.f);}else x.fo=len(x.f);}
  else if(key==='ArrowUp'){if(fi>0){x.f=ids[fi-1];x.fo=0;}else x.fo=0;}
  else if(key==='ArrowRight'){if(x.fo<len(x.f))x.fo++;else if(fi<ids.length-1){x.f=ids[fi+1];x.fo=0;}}
  else{if(x.fo>0)x.fo--;else if(fi>0){x.f=ids[fi-1];x.fo=len(x.f);}}
  if(x.f===x.a){var el=txtOf(els[ids.indexOf(x.a)]);S.xsel=null;clearHL();S.sel=[];selBar();if(el){el.focus();var p1=pointAt(el,x.ao),p2=pointAt(el,x.fo);getSelection().setBaseAndExtent(p1[0],p1[1],p2[0],p2[1]);}return;}
  paintX();var fe=$('.nt-b[data-id="'+x.f+'"]');if(fe)fe.scrollIntoView({block:'nearest'});
}
function xText(){
  return S.sel.map(function(id,k){var f=find(id);if(!f)return '';var el=txtOf($('.nt-b[data-id="'+id+'"]'));
    if(el){var len=el.textContent.length,s0=0,e0=len;if(S.xsel&&S.xr){if(k===0)s0=Math.min(S.xr.s,len);if(k===S.sel.length-1)e0=Math.min(S.xr.e,len);}return el.textContent.slice(s0,e0);}
    return f.b.code||f.b.url||(f.b.rows?f.b.rows.map(function(r){return r.map(plain).join('\t');}).join('\n'):'');}).join('\n');
}
function xselKeys(e){
  var mod=e.metaKey||e.ctrlKey;
  if(e.key==='Escape'){e.preventDefault();selectBlocks(S.sel.slice());return;}
  if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();deleteX();return;}
  if(mod&&!e.altKey&&!e.shiftKey&&/^[biu]$/i.test(e.key)){e.preventDefault();applyFmt({b:'bold',i:'italic',u:'underline'}[e.key.toLowerCase()]);return;}
  if(mod&&!e.shiftKey&&(e.key==='e'||e.key==='E')){e.preventDefault();applyFmt('code');return;}
  if(mod&&e.shiftKey&&(e.key==='s'||e.key==='S')){e.preventDefault();applyFmt('strikeThrough');return;}
  if(mod&&e.shiftKey&&(e.key==='h'||e.key==='H')){e.preventDefault();if(S.lastColor)applyFmt('color',S.lastColor);return;}
  if(e.shiftKey&&!mod&&/^Arrow(Up|Down|Left|Right)$/.test(e.key)){e.preventDefault();extendX(e.key);return;}
  if(!mod&&!e.altKey&&/^Arrow/.test(e.key)){e.preventDefault();var back=e.key==='ArrowUp'||e.key==='ArrowLeft',to=back?{id:S.sel[0],o:S.xr.s}:{id:S.sel[S.sel.length-1],o:S.xr.e};S.xsel=null;clearHL();S.sel=[];selBar();focusBlock(to.id,to.o);return;}
  if(e.key==='Enter'&&!mod){e.preventDefault();deleteX();return;}
  if(!mod&&!e.shiftKey&&QUICK_TURN[e.code]){e.preventDefault();var qk=S.sel.slice();if(quickTurn(qk,QUICK_TURN[e.code])){renderDoc();reselect(qk);}return;}
  if(mod&&e.shiftKey&&(e.code==='Period'||e.code==='Comma')){e.preventDefault();stepSize(S.sel.slice(),e.code==='Period'?1:-1);return;}
  if(!mod&&!e.altKey&&e.key.length===1&&e.key!=='/'){e.preventDefault();deleteX();insertTextAtCaret(e.key);return;}
  selKeys(e);
}
// Flydende værktøjslinje over markeringen (samme udseende som tekst-linjen)
var selBarEl=null;
function selBar(){
  if(!S.sel.length||!isActive()){if(selBarEl){selBarEl.remove();selBarEl=null;}return;}
  if(!selBarEl){selBarEl=document.createElement('div');selBarEl.className='nt-stb nt-selbar';selBarEl.setAttribute('data-no-i18n','');document.body.appendChild(selBarEl);
    selBarEl.addEventListener('mousedown',function(e){e.preventDefault();e.stopPropagation();});
    selBarEl.addEventListener('click',function(e){var x=e.target.closest('[data-sb]');if(!x)return;var k=x.dataset.sb,ids=S.sel.slice(),r=x.getBoundingClientRect();
      if(k==='turn'||k==='color'){blockMenu(ids[0],k,r);return;}
      if(k==='size'){sizePop(r,ids);return;}
      if(k==='align'){alignPop(r,ids);return;}
      if(k==='in'||k==='out'){indentMany(ids,k==='in'?1:-1);return;}
      if(k==='q-toggle'||k==='q-todo'){if(quickTurn(ids,k==='q-toggle'?'toggle':'todo')){renderDoc();reselect(ids);}return;}
      if(k==='ai'){aiMulti(r);return;}
      if(k==='bold'||k==='italic'||k==='underline'||k==='strikeThrough'||k==='code'){applyFmt(k);return;}
      if(k==='comment'){openComments('“'+xText().slice(0,120)+'” – ');return;}
      if(k==='more'){var el=pop(r,'<button class="nt-mi" data-m="in"><span class="nt-mi-i">⇥</span>'+L('Indryk','Indent')+'<span class="nt-mi-k">Tab</span></button><button class="nt-mi" data-m="out"><span class="nt-mi-i">⇤</span>'+L('Ryk ud','Outdent')+'<span class="nt-mi-k">⇧Tab</span></button><button class="nt-mi" data-m="copy"><span class="nt-mi-i">📋</span>'+L('Kopiér','Copy')+'<span class="nt-mi-k">'+MOD+'C</span></button><button class="nt-mi" data-m="dup"><span class="nt-mi-i">⧉</span>'+L('Duplikér','Duplicate')+'<span class="nt-mi-k">'+MOD+'D</span></button><div class="nt-sep"></div><button class="nt-mi" data-m="del"><span class="nt-mi-i">🗑</span>'+L('Slet','Delete')+'<span class="nt-mi-k">Del</span></button>',{type:'list',cls:'small',width:220});
        hl($$('.nt-mi',el),-1);el.addEventListener('mousedown',function(ev){ev.preventDefault();});
        el.addEventListener('click',function(ev){var y=ev.target.closest('[data-m]');if(!y)return;closePop();var m=y.dataset.m;
          if(m==='in'||m==='out')indentMany(S.sel.slice(),m==='in'?1:-1);else if(m==='dup')duplicateMany(S.sel.slice());else if(m==='del')deleteX();else if(m==='copy')copySel(false);});return;}
    });}
  var f0=find(S.sel[0]),tn=f0?typeName(f0.b.type):'';
  selBarEl.innerHTML='<button class="ai" data-sb="ai">✨ AI</button><i></i><button data-sb="turn">'+H(tn||L('Lav om til','Turn into'))+' ▾</button><button data-sb="out" title="'+L('Ryk et hak ud','Outdent')+' (⇧Tab)">⇤</button><button data-sb="in" title="'+L('Ryk et hak ind','Indent')+' (Tab)">⇥</button><i></i><button data-sb="size" title="'+L('Skriftstørrelse','Text size')+'">Aa ▾</button><button data-sb="align" title="'+L('Justering (venstre, centreret, højre)','Alignment')+'">'+alIcon(selAl())+' ▾</button><button data-sb="q-toggle" title="'+L('Lav til toggle','Turn into toggle')+' (B)">▸ Toggle <kbd class="nt-kb">B</kbd></button><button data-sb="q-todo" title="'+L('Lav til to-do-liste','Turn into to-do list')+' (P)">☐ To-do <kbd class="nt-kb">P</kbd></button><i></i><button data-sb="bold" title="'+MOD+'B"><b>B</b></button><button data-sb="italic" title="'+MOD+'I"><em>i</em></button><button data-sb="underline" title="'+MOD+'U"><u>U</u></button><button data-sb="strikeThrough" title="'+MOD+'⇧S"><s>S</s></button><button data-sb="code" title="'+MOD+'E">&lt;/&gt;</button><i></i><button data-sb="color">A ▾</button><button data-sb="comment" title="'+L('Kommentér','Comment')+'">💬</button><button data-sb="more" title="'+L('Mere','More')+'">⋯</button>';
  posSelBar();
}
function posSelBar(){
  if(!selBarEl)return;var a=S.hlFirst,r=null;
  if(a&&a.getBoundingClientRect){r=a.getBoundingClientRect();if(!r.width&&!r.height)r=null;}
  if(!r){var first=null;leafEls().some(function(e){if(S.sel.indexOf(e.dataset.id)>-1){first=e;return true;}});if(!first){selBarEl.style.display='none';return;}var bc=$('.nt-bc',first)||first;r=bc.getBoundingClientRect();}
  var sr=$('#nt-scroll').getBoundingClientRect(),w=selBarEl.offsetWidth;selBarEl.style.display='flex';
  var y=r.top-selBarEl.offsetHeight-8;if(y<sr.top+4)y=Math.max(sr.top+4,Math.min(r.bottom+8,innerHeight-50));
  selBarEl.style.left=Math.max(8,Math.min(innerWidth-w-8,r.left))+'px';selBarEl.style.top=y+'px';
}
// AI på flere blokke
function aiMulti(anchor){
  var text=xText();if(!text.trim())return;
  var acts=[['improve','✍️',L('Forbedr sproget','Improve writing')],['fix','✔️',L('Ret stavning og grammatik','Fix spelling & grammar')],['shorter','↘️',L('Gør kortere','Make shorter')],['longer','↗️',L('Gør længere','Make longer')],['tone_formal','👔',L('Mere formel tone','More formal tone')],['translate_en','🇬🇧',L('Oversæt til engelsk','Translate to English')],['translate_da','🇩🇰',L('Oversæt til dansk','Translate to Danish')],['summarize','📝',L('Opsummér','Summarize')],['todos','☑️',L('Lav til to-dos','Turn into to-dos')]];
  var el=pop(anchor,'<div class="nt-mg">✨ '+L('Gør det med AI','Edit with AI')+'</div>'+acts.map(function(a){return '<button class="nt-mi" data-ai="'+a[0]+'"><span class="nt-mi-i">'+a[1]+'</span>'+a[2]+'</button>';}).join(''),{type:'list',width:280,cls:'small'});
  hl($$('.nt-mi',el),-1);el.addEventListener('mousedown',function(ev){ev.preventDefault();});
  el.addEventListener('click',async function(e){
    var x=e.target.closest('[data-ai]');if(!x)return;var keepIds=S.sel.slice(),lastId=keepIds[keepIds.length-1];
    el.innerHTML='<div class="nt-pop-pad" style="color:#8a8178"><span class="nt-spin"></span> '+L('AI arbejder…','AI is working…')+'</div>';
    var r=await api('/api/notes/ai',{method:'POST',body:JSON.stringify({action:x.dataset.ai,text:text,context:pageText(6000)})});
    if(!r||r.ok===false||(!r.text&&!r.blocks)){el.innerHTML='<div class="nt-pop-pad" style="color:#b3261e">'+H((r&&r.error)||L('AI svarede ikke','AI did not respond'))+'</div>';return;}
    var blocks=r.blocks||String(r.text).split(/\n+/).filter(function(t){return t.trim();}).map(function(t){return {type:'p',html:t};});
    el.innerHTML='<div class="nt-pop-pad" style="width:440px;box-sizing:border-box"><div class="nt-aires">'+blocks.map(function(b){return ({bullet:'• ',num:'1. ',todo:'☐ '}[b.type]||'')+H(plain(b.html));}).join('\n')+'</div><div style="display:flex;gap:6px"><button class="nt-btn" data-rep="1">'+L('Erstat','Replace')+'</button><button class="nt-btn sec" data-below="1">'+L('Indsæt under','Insert below')+'</button><button class="nt-btn sec" data-close="1">'+L('Kassér','Discard')+'</button></div></div>';
    place(el,anchor);
    el.onclick=function(ev){
      if(ev.target.closest('[data-close]'))return closePop();
      var rep=!!ev.target.closest('[data-rep]'),below=!!ev.target.closest('[data-below]');if(!rep&&!below)return;closePop();
      var lf=find(lastId);if(!lf)return;var ind=lf.b.indent||0;
      op(function(){var ins=blocks.map(function(b){var n=bl(b.type,b.html);n.indent=ind;return n;});lf=find(lastId);lf.list.splice.apply(lf.list,[groupEnd(lf.list,lf.i),0].concat(ins));if(rep)keepIds.forEach(function(id){removeBlock(id,false);});ensureNotEmpty();});
      S.xsel=null;S.sel=[];clearHL();renderDoc();selBar();
    };
  });
}
// ── kopiér/indsæt med bloktyper bevaret ─────────────────────
function b64e(t){return btoa(unescape(encodeURIComponent(t)));}
function b64d(t){return decodeURIComponent(escape(atob(t)));}
function clipBlocks(){
  var out=[],seen={},first=S.sel[0],last=S.sel[S.sel.length-1];
  S.sel.forEach(function(id){if(seen[id])return;var f=find(id);if(!f)return;var end=groupEnd(f.list,f.i);
    for(var k=f.i;k<end;k++){var b=f.list[k];if(seen[b.id])continue;if(S.xsel&&k>f.i&&S.sel.indexOf(b.id)<0&&!isHiddenIdx(f.list,k))continue;seen[b.id]=1;var c=clone(b);
      if(S.xsel&&S.xr&&(b.id===first||b.id===last)){var el=txtOf($('.nt-b[data-id="'+b.id+'"]'));if(el){var len=el.textContent.length,s0=b.id===first?Math.min(S.xr.s,len):0,e0=b.id===last?Math.min(S.xr.e,len):len;var rr=rangeIn(el,s0,e0);while(rr.startOffset===0&&rr.startContainer!==el&&rr.startContainer.parentNode)rr.setStartBefore(rr.startContainer);while(rr.endContainer!==el&&rr.endContainer.parentNode&&rr.endOffset===(rr.endContainer.nodeType===3?rr.endContainer.length:rr.endContainer.childNodes.length))rr.setEndAfter(rr.endContainer);var d=document.createElement('div');d.appendChild(rr.cloneContents());c.html=norm(d.innerHTML);}}
      out.push(c);}});
  var min=out.length?Math.min.apply(null,out.map(function(b){return b.indent||0;})):0;
  out.forEach(function(b){b.indent=(b.indent||0)-min;if(!b.indent)delete b.indent;});
  return out;
}
function blocksText(list){var num={};return list.map(function(b){var t=b.html!=null?htmlToMd(b.html):(b.code||b.url||(b.rows?b.rows.map(function(r){return r.map(plain).join('\t');}).join('\n'):''));var i=b.indent||0;if(b.type==='num')num[i]=(num[i]||0)+1;else delete num[i];
  var pre={h1:'# ',h2:'## ',h3:'### ',th1:'# ',th2:'## ',th3:'### ',bullet:'- ',num:(num[i]||1)+'. ',todo:b.checked?'- [x] ':'- [ ] ',quote:'> ',toggle:'- '}[b.type]||'';return '  '.repeat(i)+pre+t;}).join('\n');}
function blocksHtml(list){return list.map(function(b){var h=b.html!=null?b.html:H(b.code||b.url||'');var pad=b.indent?' style="margin-left:'+(b.indent*24)+'px"':'';
  if(/^t?h[123]$/.test(b.type))return '<h'+b.type.slice(-1)+pad+'>'+h+'</h'+b.type.slice(-1)+'>';
  if(b.type==='bullet'||b.type==='toggle')return '<ul'+pad+'><li>'+h+'</li></ul>';if(b.type==='num')return '<ol'+pad+'><li>'+h+'</li></ol>';
  if(b.type==='todo')return '<p'+pad+'>'+(b.checked?'☑':'☐')+' '+h+'</p>';if(b.type==='quote')return '<blockquote>'+h+'</blockquote>';if(b.type==='code')return '<pre>'+h+'</pre>';
  return '<p'+pad+'>'+h+'</p>';}).join('');}
function copySel(cut){
  if(!S.sel.length)return;S.cutting=!!cut;S.clipOk=false;
  try{document.execCommand('copy');}catch(e){}
  if(!S.clipOk){var b2=clipBlocks();S.clip={text:blocksText(b2),blocks:b2};copyText(S.clip.text);if(S.cutting){S.cutting=false;deleteX();}}
}
document.addEventListener('copy',onCopyCut);
document.addEventListener('paste',function(e){ // indsæt mens blokke er valgt (ingen markør)
  if(!S.built||!isActive()||!S.page||!S.sel.length)return;var ae=document.activeElement;if(ae&&(ae.isContentEditable||/INPUT|TEXTAREA/.test(ae.tagName)))return;
  var pb=pastedBlocks(e.clipboardData);if(!pb){var t=e.clipboardData.getData('text/plain');if(!t)return;pb=t.split('\n').filter(function(x){return x.trim();}).map(function(x){return bl('p',H(x));});}
  e.preventDefault();var ids=S.sel.slice(),lastB;op(function(){lastB=insertBlocksAfter(ids[ids.length-1],pb);ids.forEach(function(id){removeBlock(id,false);});ensureNotEmpty();});
  S.xsel=null;S.sel=[];clearHL();renderDoc(lastB?{id:lastB.id,pos:'end'}:null);selBar();
});document.addEventListener('cut',onCopyCut);
function fullLineCopy(){ // hele teksten i én blok markeret (fx en toggle) → kopiér som blok
  var sl=getSelection();if(!sl.rangeCount||sl.isCollapsed)return null;var r=sl.getRangeAt(0),n=r.startContainer,el=(n.nodeType===1?n:n.parentElement);el=el&&el.closest('#nt-doc .nt-txt');if(!el)return null;
  var be=el.closest('.nt-b'),f=be&&find(be.dataset.id);if(!f||f.b.type==='p'||!isTxt(f.b.type))return null;
  var all=el.textContent.replace(/\s+/g,' ').trim(),got=sl.toString().replace(/\s+/g,' ').trim();if(!all||got!==all)return null;
  var end=isTog(f.b.type)?groupEnd(f.list,f.i):f.i+1,g=clone(f.list.slice(f.i,end)),base=f.b.indent||0;g.forEach(function(b){b.indent=(b.indent||0)-base;if(b.indent<=0)delete b.indent;});g[0].html=norm(el.innerHTML);g.srcId=f.b.id;return g;
}
function onCopyCut(e){
  if(S.built&&isActive()&&!S.sel.length){var fl=fullLineCopy();if(fl){var tx=blocksText(fl);S.clip={text:tx,blocks:fl};e.clipboardData.setData('text/plain',tx);e.clipboardData.setData('text/html','<div data-nt-blocks="'+b64e(JSON.stringify(fl))+'">'+blocksHtml(fl)+'</div>');e.preventDefault();
    if(e.type==='cut'){var sid=fl.srcId;op(function(){removeBlock(sid,true);ensureNotEmpty();});renderDoc();}return;}}
  if(!S.built||!isActive()||!S.sel.length)return;var ae=document.activeElement;if(ae&&(ae.isContentEditable||/INPUT|TEXTAREA/.test(ae.tagName)))return;
  var b2=clipBlocks();if(!b2.length)return;var txt=blocksText(b2);S.clip={text:txt,blocks:b2};
  e.clipboardData.setData('text/plain',txt);e.clipboardData.setData('text/html','<div data-nt-blocks="'+b64e(JSON.stringify(b2))+'">'+blocksHtml(b2)+'</div>');e.preventDefault();S.clipOk=true;
  if(e.type==='cut'||S.cutting){S.cutting=false;setTimeout(deleteX,0);}
}
function cleanInline(h){
  var d=document.createElement('div');d.innerHTML=h||'';
  (function w(n){Array.prototype.slice.call(n.childNodes).forEach(function(c){
    if(c.nodeType===8){c.remove();return;}if(c.nodeType!==1)return;w(c);var t=c.tagName.toLowerCase(),st=c.getAttribute('style')||'';
    if(/^(b|strong)$/.test(t)&&/font-weight:\s*(normal|[1-4]00)/.test(st)){}
    else if(/^(b|strong|i|em|u|s|strike|del|code|br|mark)$/.test(t)){Array.prototype.slice.call(c.attributes).forEach(function(a){c.removeAttribute(a.name);});return;}
    else if(t==='a'){var hr=c.getAttribute('href')||'';Array.prototype.slice.call(c.attributes).forEach(function(a){c.removeAttribute(a.name);});if(/^(https?:|mailto:|tel:)/.test(hr)){c.setAttribute('href',hr);c.setAttribute('target','_blank');c.setAttribute('rel','noopener');return;}}
    var wrap=/font-weight:\s*(bold|[6-9]00)/.test(st)?'b':/font-style:\s*italic/.test(st)?'i':/line-through/.test(st)?'s':null;
    var fr=document.createDocumentFragment();while(c.firstChild)fr.appendChild(c.firstChild);
    if(wrap){var e2=document.createElement(wrap);e2.appendChild(fr);c.replaceWith(e2);}else c.replaceWith(fr);
  });})(d);
  return d.innerHTML.replace(/[\r\n\t]+/g,' ').replace(/ {2,}/g,' ').trim();
}
// HTML fra Notion, Google Docs, Word osv. → blokke (toggles, lister, to-dos, overskrifter …)
// Tjek-/toggle-markører som Notion, Docs, Apple Notes m.fl. lægger i teksten
var CHK_RE=/^(?:\s|&nbsp;|\u00a0)*(?:[-*•]\s+)?(\[( |x|X)?\]|☐|☑|☒|✅|✔️?|✓)(?:\s|&nbsp;|\u00a0)*/,TOG_RE=/^(?:\s|&nbsp;|\u00a0)*(▶️?|▸|►|‣|▷)(?:\s|&nbsp;|\u00a0)*/;
function markOf(h){var plainT=plain(h||'');var m=plainT.match(CHK_RE);if(m)return {type:'todo',checked:/x|☑|☒|✅|✔|✓/i.test(m[1])&&m[1]!=='[ ]'&&m[1]!=='[]'};if(TOG_RE.test(plainT))return {type:'toggle'};return null;}
function stripMark(h){var d=document.createElement('div');d.innerHTML=h||'';var w=document.createTreeWalker(d,NodeFilter.SHOW_TEXT),n;while((n=w.nextNode())){if(!n.data.trim())continue;var r=n.data.replace(CHK_RE,'');if(r===n.data)r=n.data.replace(TOG_RE,'');n.data=r;break;}return d.innerHTML.trim();}
function htmlToBlocks(html){
  var doc=new DOMParser().parseFromString(html,'text/html'),out=[];
  var BLK=/^(UL|OL|LI|DETAILS|SUMMARY|TABLE|PRE|BLOCKQUOTE|H[1-6]|P|DIV|SECTION|ARTICLE|HR|IMG|FIGURE|INPUT)$/;
  function inl(node){var d=document.createElement('div');Array.prototype.slice.call(node.childNodes).forEach(function(c){if(c.nodeType===1&&BLK.test(c.tagName)&&!(c.tagName==='DIV'&&!c.querySelector('ul,ol,li,details,p,div,h1,h2,h3,table,pre,blockquote')&&!/checkbox/.test(c.className)))return;if(c.nodeType===1&&/checkbox/.test(c.className))return;d.appendChild(c.cloneNode(true));});return cleanInline(d.innerHTML);}
  function push(type,h,ind,extra){var b=bl(type,h);if(ind)b.indent=Math.min(10,ind);if(extra)Object.assign(b,extra);out.push(b);return b;}
  function hasBlk(n){return !!n.querySelector('ul,ol,li,details,p,h1,h2,h3,h4,table,pre,blockquote,hr,div');}
  function walkN(node,ind,lt){
    Array.prototype.slice.call(node.childNodes).forEach(function(c){
      if(c.nodeType===3){var t=c.data.replace(/\s+/g,' ').trim();if(t)push('p',H(t),ind);return;}
      if(c.nodeType!==1)return;var tg=c.tagName;
      if(/^(STYLE|SCRIPT|META|TITLE|HEAD)$/.test(tg))return;
      if(/^H[1-6]$/.test(tg)){push('h'+Math.min(3,+tg[1]),inl(c),ind);return;}
      if(tg==='UL'||tg==='OL'){walkN(c,ind,tg==='OL'?'num':/to-?do/.test(c.className)?'todo':/toggle/.test(c.className)?'toggle':'bullet');return;}
      if(tg==='LI'){
        var det=c.querySelector(':scope > details');if(det){walkN(c,ind,lt);return;}
        var cb=c.querySelector(':scope > input[type=checkbox], :scope > label > input[type=checkbox], :scope > .checkbox, :scope > div > .checkbox, :scope > span > .checkbox');
        var type=cb||lt==='todo'?'todo':(lt||'bullet'),extra=type==='todo'?{checked:!!(cb&&(cb.checked||cb.hasAttribute('checked')||/checkbox-on|checked/.test(cb.className)))}:null;
        var h=inl(c);if(!h){var p0=c.querySelector(':scope > p');if(p0)h=inl(p0);}
        var mk=type!=='todo'&&markOf(h);if(mk){type=mk.type;extra=mk.type==='todo'?{checked:mk.checked}:{open:true};h=stripMark(h);}else if(type==='todo'&&CHK_RE.test(plain(h))){if(!cb){var mk2=markOf(h);if(mk2&&mk2.type==='todo')extra={checked:mk2.checked};}h=stripMark(h);}
        if(type==='toggle'&&!extra)extra={open:true};
        push(type,h,ind,extra);
        Array.prototype.slice.call(c.children).forEach(function(k){if(/^(UL|OL|DETAILS|BLOCKQUOTE|PRE|TABLE)$/.test(k.tagName))walkN({childNodes:[k]},ind+1,null);else if(k.tagName==='P'&&k!==c.querySelector(':scope > p'))walkN({childNodes:[k]},ind+1,null);});
        return;}
      if(tg==='DETAILS'){var sm=c.querySelector(':scope > summary');var hd=sm&&sm.querySelector('h1,h2,h3');push(hd?'th'+Math.min(3,+hd.tagName[1]):'toggle',sm?inl(hd||sm):'',ind,{open:c.hasAttribute('open')});
        Array.prototype.slice.call(c.childNodes).forEach(function(k){if(k!==sm)walkN({childNodes:[k]},ind+1,null);});return;}
      if(tg==='BLOCKQUOTE'){if(hasBlk(c)){var q0=out.length;walkN(c,ind,lt);for(var qi=q0;qi<out.length;qi++)if(out[qi].type==='p')out[qi].type='quote';}else push('quote',inl(c),ind);return;}
      if(tg==='PRE'){var cb2=bl('code','');cb2.code=c.textContent.replace(/\n$/,'');if(ind)cb2.indent=ind;out.push(cb2);return;}
      if(tg==='HR'){var dv=bl('divider','');if(ind)dv.indent=ind;out.push(dv);return;}
      if(tg==='TABLE'){var rows=Array.prototype.slice.call(c.querySelectorAll('tr')).map(function(tr){return Array.prototype.slice.call(tr.children).map(function(td){return cleanInline(td.innerHTML);});});
        if(rows.length){var nc=Math.max.apply(null,rows.map(function(r){return r.length;}));rows.forEach(function(r){while(r.length<nc)r.push('');});var tb=bl('table','');tb.rows=rows;tb.header=!!c.querySelector('th');out.push(tb);}return;}
      if(tg==='IMG'){var src=c.getAttribute('src')||'';if(/^https?:/.test(src)){var ib=bl('image','');ib.url=src;out.push(ib);}return;}
      if(tg==='BR')return;
      if(/^(P|DIV|SECTION|ARTICLE|MAIN|BODY|FIGURE|SPAN|B|FONT)$/.test(tg)&&hasBlk(c)){walkN(c,ind,lt);return;}
      if(/checkbox/.test(c.className||''))return;
      var h2=tg==='P'||tg==='DIV'?inl(c):cleanInline(c.outerHTML);if(h2){var mk3=markOf(h2);if(mk3)push(mk3.type,stripMark(h2),ind,mk3.type==='todo'?{checked:mk3.checked}:{open:true});else push('p',h2,ind);}
    });
  }
  walkN(doc.body,0,null);
  return out;
}
function pastedBlocks(cd){
  var html=cd.getData('text/html')||'',txt=cd.getData('text/plain')||'',m=html.match(/data-nt-blocks="([^"]+)"/),list=null;
  if(m){try{list=JSON.parse(b64d(m[1]));}catch(e){list=null;}}
  if(!list&&S.clip&&txt&&txt===S.clip.text)list=clone(S.clip.blocks);
  S.lastPaste={html:html.slice(0,20000),text:txt.slice(0,5000)};
  if(!list&&html&&(/<(ul|ol|li|h[1-6]|details|blockquote|pre|table|hr)\b/i.test(html)||/(\[( |x)?\]|☐|☑|▶|▸|‣)/i.test(txt))){list=htmlToBlocks(html);if(list.length<2&&!(list[0]&&list[0].type!=='p'))list=null;}
  if(!list||!list.length)return null;
  if(!m)list.forEach(function(b,i){var n=list[i+1];if(b.type==='p'&&n&&(n.indent||0)>(b.indent||0)){b.type='toggle';b.open=true;}});
  list.forEach(function(b){walk([b],function(y){y.id=uid();});});
  return list;
}
function adoptListType(target,list){ // indsættes i en nummereret/punkt/to-do-liste, får de øverste linjer listens type
  if(!target||!/^(num|bullet|todo)$/.test(target.type))return;var base=Math.min.apply(null,list.map(function(x){return x.indent||0;}));
  list.forEach(function(x){if((x.indent||0)===base&&isTxt(x.type)&&!/^(h1|h2|h3|th1|th2|th3|quote|callout|code|remind)$/.test(x.type)&&x.type!==target.type){var hadKids=false;turnInto(x,target.type);if(target.type==='todo')x.checked=false;}});
}
function insertBlocksAfter(anchorId,list,replace){
  var f=find(anchorId);if(f)adoptListType(f.b,list);if(!f){S.page.blocks=S.page.blocks.concat(list);return list[list.length-1];}
  var base=f.b.indent||0,empty=isTxt(f.b.type)&&!plain(f.b.html).trim()&&!/<(img|span|a)\b/.test(f.b.html||'');
  list.forEach(function(b){b.indent=Math.min(10,(b.indent||0)+base);if(!b.indent)delete b.indent;});
  if(replace||empty){f.list.splice.apply(f.list,[f.i,1].concat(list));}
  else f.list.splice.apply(f.list,[groupEnd(f.list,f.i),0].concat(list));
  return list[list.length-1];
}
function duplicateMany(ids){
  op(function(){ids.slice().reverse().forEach(function(id){var f=find(id);if(!f)return;var end=groupEnd(f.list,f.i),g=clone(f.list.slice(f.i,end));g.forEach(function(x){walk([x],function(y){y.id=uid();});});f.list.splice.apply(f.list,[end,0].concat(g));});});
  var keep=S.sel.slice();renderDoc();reselect(keep);
}

// Enter: del blokken ved markøren
function splitBlock(el,b){
  var s=getSelection(),r=s.getRangeAt(0);r.deleteContents();
  var tail=document.createRange();tail.setStart(r.endContainer,r.endOffset);tail.setEnd(el,el.childNodes.length);
  var d=document.createElement('div');d.appendChild(tail.extractContents());
  var after=norm(d.innerHTML),before=norm(el.innerHTML);
  var empty=!plain(before).trim()&&!/<(img|span|a)\b/.test(before);
  op(function(){
    // Tom listepunkt + Enter = ud af listen (som i Notion)
    if(empty&&!after&&/^(bullet|num|todo|toggle|quote|callout)$/.test(b.type)){
      if(b.indent){b.indent--;}else turnInto(b,'p');renderDoc({id:b.id,pos:0});return;}
    b.html=before;
    var t=/^(bullet|num|todo)$/.test(b.type)?b.type:(b.type==='toggle'&&!b.open?'toggle':'p');
    var nb=bl(t,after),f=find(b.id);
    if(isTog(b.type)&&b.open&&caretWasEnd(before,after)){nb.indent=(b.indent||0)+1;f.list.splice(f.i+1,0,nb);}
    else if(isTog(b.type)&&!b.open){nb.indent=b.indent||0;if(t!=='toggle'&&/^th/.test(b.type))nb.type='p';f.list.splice(groupEnd(f.list,f.i),0,nb);}
    else{nb.indent=b.indent||0;
      // Står markøren i starten af en ikke-tom blok, skubbes den ned (Notion-adfærd)
      if(!plain(before).trim()&&after&&!/^(bullet|num|todo)$/.test(b.type)){nb.type=b.type;Object.assign(nb,clone(Object.assign({},b,{id:nb.id,html:after})));b.html='';b.type='p';delete b.checked;delete b.open;}
      f.list.splice(f.i+1,0,nb);}
    renderDoc({id:nb.id,pos:0});
  });
}
function caretWasEnd(before,after){return !after;}
function backspaceAtStart(el,b){
  // Tom linje med indhold under sig (fx en toggle hvor ordet er slettet): fjern linjen, og ryk det under den et hak tilbage (okt. 2026)
  if(!plain(b.html).trim()&&!/<(img|span|a)\b/.test(b.html||'')){var fk=find(b.id),endk=fk?groupEnd(fk.list,fk.i):0;
    if(fk&&endk>fk.i+1){var jk=fk.i-1;while(jk>=0&&isHiddenIdx(fk.list,jk))jk--;var pvk=fk.list[jk],firstKid=fk.list[fk.i+1];
      op(function(){for(var k=fk.i+1;k<endk;k++){var x=fk.list[k];x.indent=Math.max(0,(x.indent||0)-1);if(!x.indent)delete x.indent;}fk.list.splice(fk.i,1);var ni=fk.list.indexOf(firstKid);if(ni>-1&&(firstKid.indent||0)>0)openAncestors(fk.list,ni);});
      renderDoc(pvk&&isTxt(pvk.type)?{id:pvk.id,pos:'end'}:{id:firstKid.id,pos:0});return;}}
  if(b.type!=='p'&&isTxt(b.type)&&b.type!=='remind'){op(function(){turnInto(b,'p');});rerenderKeep();setCaret($('.nt-b[data-id="'+b.id+'"] .nt-txt'),0);return;}
  if(b.indent&&!plain(b.html).trim()&&!/<(img|span|a)\b/.test(b.html||'')){ // tom indrykket linje: fjern kun linjen – resten bliver i deres indryk
    var fe=find(b.id),j2=fe.i-1;while(j2>=0&&isHiddenIdx(fe.list,j2))j2--;var pv=fe.list[j2];
    if(pv&&isTxt(pv.type)){op(function(){fe.list.splice(fe.i,1);if(fe.list[fe.i])openAncestors(fe.list,fe.i);});renderDoc({id:pv.id,pos:'end'});return;}
  }
  if(b.indent){indentBlock(b.id,-1,true);setCaret($('.nt-b[data-id="'+b.id+'"] .nt-txt'),0);return;}
  var f=find(b.id),prev=f.list[f.i-1];
  // Find forrige synlige blok i samme liste
  var j=f.i-1;while(j>=0&&isHiddenIdx(f.list,j))j--;prev=f.list[j];
  if(!prev){if(f.owner&&!plain(b.html).trim()){op(function(){removeBlock(b.id);});renderDoc();var e0=editables()[0];if(e0)setCaret(e0,'start');}return;}
  if(isTxt(prev.type)){
    var at=plain(prev.html).length;
    op(function(){prev.html=norm((prev.html||'')+(b.html||''));f.list.splice(f.list.indexOf(b),1);
      // børn af den fjernede blok bevares
      renderDoc({id:prev.id,pos:at});});
  }else if(!plain(b.html).trim()){op(function(){f.list.splice(f.i,1);});renderDoc();selectBlocks([prev.id]);}
  else selectBlocks([prev.id]);
}
function isHiddenIdx(list,j){ // ligger blokken under en lukket toggle?
  var ind=list[j].indent||0;for(var k=j-1;k>=0;k--){var x=list[k],xi=x.indent||0;if(xi<ind){if(isTog(x.type)&&!x.open)return true;ind=xi;}if(xi===0&&ind===0)break;}return false;
}
function deleteAtEnd(el,b){
  var f=find(b.id),next=f.list[f.i+1];if(!next||!isTxt(next.type))return;
  var at=plain(b.html).length;
  op(function(){b.html=norm((b.html||'')+(next.html||''));f.list.splice(f.i+1,1);renderDoc({id:b.id,pos:at});});
}

// ── markdown-genveje ───────────────────────────────────────
var MD=[[/^#\s$/,'h1'],[/^##\s$/,'h2'],[/^###\s$/,'h3'],[/^[-*+]\s$/,'bullet'],[/^1[.)]\s$/,'num'],[/^\[\s?\]\s$/,'todo'],[/^\[x\]\s$/i,'todo!'],[/^>\s$/,'toggle'],[/^"\s$/,'quote'],[/^```$/,'code'],[/^(---|___|\*\*\*)$/,'divider']];
function mdShortcut(el,b){
  // Skillelinje virker i alle linjetyper og beholder indrykket (okt. 2026): --- eller ___ eller ***
  if(isTxt(b.type)&&/^(---|___|\*\*\*)$/.test(el.textContent.replace(/\u00a0/g,' ').trim())&&b.type!=='p'){
    var keep=/^(bullet|num|todo|toggle)$/.test(b.type)?b.type:'p',wasTodo=!!b.todo;
    op(function(){var nb=bl(keep,'');nb.indent=b.indent||0;if(keep==='toggle')nb.open=false;turnInto(b,'divider');delete b.html;delete b.todo;delete b.checked;var f=find(b.id);f.list.splice(f.i+1,0,nb);renderDoc({id:nb.id,pos:0});});
    return true;
  }
  if(b.type!=='p'&&!/^(bullet|num|todo|h1|h2|h3)$/.test(b.type))return false;
  var off=caretOffset(el),txt=el.textContent.replace(/\u00a0/g,' ');if(off>5)return false;
  var pre=txt.slice(0,off);
  for(var i=0;i<MD.length;i++){if(MD[i][0].test(pre)){
    var t=MD[i][1];if(b.type!=='p'&&t!=='divider'&&!/^h/.test(t)&&!/^h/.test(b.type))return false;
    // fjern prefikset
    var r=document.createRange();setCaret(el,0);var s=getSelection();var st=s.getRangeAt(0);r.setStart(st.startContainer,st.startOffset);
    setCaret(el,off);var en=getSelection().getRangeAt(0);r.setEnd(en.startContainer,en.startOffset);r.deleteContents();
    b.html=norm(el.innerHTML);
    op(function(){
      if(t==='divider'){turnInto(b,'divider');delete b.html;var nb=bl('p','');nb.indent=b.indent||0;insertAfter(b.id,nb);renderDoc({id:nb.id,pos:0});return;}
      if(t==='todo!'){turnInto(b,'todo');b.checked=true;}else turnInto(b,t);
      renderDoc({id:b.id,pos:0});
    });
    return true;}}
  return false;
}
function inlineMd(el,b){
  var s=getSelection();if(!s.rangeCount||!s.isCollapsed)return;var n=s.anchorNode;if(!n||n.nodeType!==3)return;
  var t=n.data.slice(0,s.anchorOffset),m,tag=null;
  if((m=t.match(/\*\*([^*]+)\*\*$/)))tag='b';else if((m=t.match(/(?:^|[^*])\*([^*\s][^*]*)\*$/)))tag='i';else if((m=t.match(/`([^`]+)`$/)))tag='code';else if((m=t.match(/~~([^~]+)~~$/)))tag='s';
  if(!tag)return;
  var full=tag==='i'?m[0].replace(/^[^*]/,''):m[0],start=s.anchorOffset-full.length;
  var r=document.createRange();r.setStart(n,start);r.setEnd(n,s.anchorOffset);r.deleteContents();
  var e=document.createElement(tag);e.textContent=m[1];r.insertNode(e);
  var z=document.createTextNode('\u200b');e.after(z);var r2=document.createRange();r2.setStart(z,1);r2.collapse(true);s.removeAllRanges();s.addRange(r2);
  b.html=norm(el.innerHTML);
}

// ── pop-ups ─────────────────────────────────────────────────
function closePop(){if(S.menu){S.menu.el.remove();if(S.menu.onClose)S.menu.onClose();S.menu=null;}}
function pop(anchor,html,o){
  closePop();o=o||{};
  var el=document.createElement('div');el.className='nt-pop'+(o.cls?' '+o.cls:'');el.setAttribute('data-no-i18n','');el.innerHTML=html;
  if(o.width)el.style.width=o.width+'px';
  document.body.appendChild(el);
  var r=anchor&&anchor.getBoundingClientRect?anchor.getBoundingClientRect():anchor;
  if(r&&!r.width&&!r.height&&!r.top&&!r.left)r=null;
  place(el,r);
  S.menu={el:el,type:o.type||'pop',onClose:o.onClose,act:0,r:r};
  setTimeout(function(){var i=$('input[autofocus],textarea[autofocus]',el);if(i){i.focus();if(i.select)i.select();}},10);
  return el;
}
function place(el,r){
  el.style.maxHeight='';var w=el.offsetWidth,h=el.offsetHeight;
  var x=r?r.left:innerWidth/2-w/2,y=r?r.bottom+6:Math.max(10,innerHeight/3-h/3);
  if(x+w>innerWidth-10)x=Math.max(10,innerWidth-w-10);
  if(r){var below=innerHeight-r.bottom-16,above=r.top-16;
    if(h>below){if(below>=240){el.style.maxHeight=below+'px';}else if(above>below){if(h>above){el.style.maxHeight=above+'px';h=above;}y=r.top-h-6;}else{el.style.maxHeight=Math.max(120,below)+'px';}}}
  el.style.left=x+'px';el.style.top=Math.max(8,y)+'px';
}
function caretRect(){var s=getSelection();if(!s.rangeCount)return null;var r=s.getRangeAt(0).cloneRange();r.collapse(false);var rc=r.getClientRects()[0];if(rc)return rc;var e=s.anchorNode&&(s.anchorNode.nodeType===1?s.anchorNode:s.anchorNode.parentElement);return e?e.getBoundingClientRect():null;}
function menuNav(e){
  var m=S.menu;if(!m||!/^(slash|mention|list)$/.test(m.type))return false;
  var items=$$('.nt-mi',m.el);if(!items.length){if(e.key==='Escape'){closePop();return true;}return false;}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();m.act=(m.act+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;hl(items,m.act);return true;}
  if(e.key==='Enter'||e.key==='Tab'){if(!items[m.act])return false;e.preventDefault();items[m.act].click();return true;}
  if(e.key==='Escape'){e.preventDefault();closePop();return true;}
  return false;
}
function hl(items,i){items.forEach(function(x,j){x.classList.toggle('act',j===i);});if(items[i])items[i].scrollIntoView({block:'nearest'});}

// Slash-menu
function slashMatch(q){
  q=q.toLowerCase().trim();
  var res=SLASH.map(function(g){return {g:g.g,items:g.items.filter(function(it){return !q||it.t.toLowerCase().indexOf(q)>-1||it.w.indexOf(q)>-1||it.k===q;})};}).filter(function(g){return g.items.length;});
  if(q){var best=[];res.forEach(function(g){g.items=g.items.filter(function(it){if(it.k===q||it.t.toLowerCase()===q||it.t.toLowerCase().indexOf(q)===0){best.push(it);return false;}return true;});});res=res.filter(function(g){return g.items.length;});if(best.length)res.unshift({g:L('Bedste match','Best matches'),items:best});}
  return res;
}
function openSlash(el,b,q,start,node){
  var groups=slashMatch(q),st={el:el,b:b,start:start,node:node,q:q};
  if(!groups.length){if(/\s$/.test(q)||q.length>12){closePop();return;}}
  var html=groups.length?groups.map(function(g){return '<div class="nt-mg">'+H(g.g)+'</div>'+g.items.map(function(it){return '<button class="nt-mi" data-k="'+H(it.k)+'"><span class="nt-mi-i">'+it.i+'</span><span><div class="nt-mi-t">'+H(it.t)+'</div><div class="nt-mi-d">'+H(it.d)+'</div></span></button>';}).join('');}).join(''):'<div class="nt-mg">'+L('Ingen resultater','No results')+'</div>';
  var keep=S.menu&&S.menu.type==='slash'?S.menu:null;
  if(keep){keep.el.innerHTML=html;keep.st=st;keep.act=0;place(keep.el,caretRect()||keep.r);}
  else{var p=pop(caretRect(),html,{type:'slash',width:320});S.menu.st=st;}
  var m=S.menu;hl($$('.nt-mi',m.el),0);
  $$('.nt-mi',m.el).forEach(function(x){x.onmousedown=function(e){e.preventDefault();};x.onclick=function(){runSlash(x.dataset.k,m.st);};});
}
function stripTrigger(st){
  // fjerner "/søgeord" (eller "@søgeord") fra teksten
  try{var n=st.node,s=getSelection(),end=s.anchorNode===n?s.anchorOffset:n.length;n.deleteData(st.start,Math.max(0,end-st.start));var r=document.createRange();r.setStart(n,st.start);r.collapse(true);s.removeAllRanges();s.addRange(r);}catch(e){}
  st.b.html=norm(st.el.innerHTML);
}
function runSlash(k,st){
  closePop();stripTrigger(st);var b=st.b,el=st.el,empty=!plain(b.html).trim()&&!/<(img|span|a)\b/.test(b.html||'');
  if(k==='mention'){insertTextAtCaret('@');setTimeout(function(){checkTriggers(el,b);},0);return;}
  if(k==='date'){insertChip(dateChip(new Date()));b.html=norm(el.innerHTML);changed();return;}
  if(k==='emoji'){var cr=caretRect(),saved=saveRange();emojiPicker(cr,function(em){restoreRange(saved);insertTextAtCaret(em);b.html=norm(el.innerHTML);changed();});return;}
  if(k.indexOf('c:')===0||k.indexOf('bg:')===0){op(function(){if(k[0]==='c')b.color=k.slice(2);else b.bg=k.slice(3);});rerenderKeep();S.lastColor=k;return;}
  if(k==='turn'){blockMenu(b.id,'turn',caretRect());return;}
  if(k==='dup'){duplicateBlock(b.id);return;}
  if(k==='del'){deleteBlocks([b.id]);return;}
  if(k==='up'||k==='down'){moveBlock(b.id,k==='up'?-1:1);return;}
  if(k==='comment'){openComments();return;}
  if(k==='ai'||k==='ai-sum'||k==='ai-todo'||k==='ai-cont'){aiBlock(b,k);return;}
  if(k==='link'){pagePicker(caretRect(),L('Link til side','Link to page'),function(pid){op(function(){var nb=bl('page','');nb.pageId=pid;if(empty){replaceBlock(b,nb);}else insertAfter(b.id,nb);});renderDoc({id:after(b,'p').id,pos:0});});return;}
  if(k==='page'){createSubpage(b,empty);return;}
  insertBlockFromSlash(b,k,empty);
}
function after(b,type){ // sikrer at der er en tekstblok efter en ikke-tekstblok
  var nb=find(b.id)?ensureAfter(b,type):null;if(!nb){nb=bl(type||'p','');S.page.blocks.push(nb);}renderDoc();return nb;
}
function replaceBlock(b,nb){var f=find(b.id);nb.indent=b.indent||0;f.list.splice(f.i,1,nb);}
function ensureAfter(b,type){var f=find(b.id);if(!f)return null;var j=groupEnd(f.list,f.i),x=f.list[j];if(x&&isTxt(x.type)&&(x.indent||0)===(b.indent||0))return x;var nb=bl(type||'p','');nb.indent=b.indent||0;f.list.splice(j,0,nb);return nb;}
function insertBlockFromSlash(b,k,empty){
  var TYPE={youtube:'embed',maps:'embed',drive:'embed',loom:'embed',figma:'embed',col2:'columns',col3:'columns',col4:'columns'};
  var t=TYPE[k]||k,nb=null,focusId=null;
  op(function(){
    if(isTxt(t)&&isTxt(b.type)){turnInto(b,t);focusId=b.id;return;}
    nb=bl(t,'');if(TYPE[k]==='embed')nb.sub=k;
    if(t==='code'&&!empty&&isTxt(b.type)){turnInto(b,'code');nb=b;return;}
    if(t==='tabs'){nb.titles=[L('Fane 1','Tab 1'),L('Fane 2','Tab 2'),L('Fane 3','Tab 3')];nb.cols=[[bl('p','')],[bl('p','')],[bl('p','')]];nb.active=0;if(empty)replaceBlock(b,nb);else insertAfter(b.id,nb);ensureAfter(nb,'p');return;}
    if(t==='columns'){var n=+k.slice(3);nb.cols=[];for(var i=0;i<n;i++)nb.cols.push([bl('p','')]);if(!empty){var c0=clone(b);c0.indent=0;nb.cols[0]=[c0];}replaceBlock(b,nb);return;}
    if(empty)replaceBlock(b,nb);else insertAfter(b.id,nb);
    var nx=ensureAfter(nb,'p');if(t==='divider'||t==='toc')focusId=nx.id;
  });
  renderDoc();
  if(focusId){focusBlock(focusId,'end');return;}
  if(!nb)return;
  if(t==='columns'){focusBlock(nb.cols[empty?0:1][0].id,0);return;}
  if(t==='tabs'){editTabTitle(nb.id,0);return;}
  if(t==='table'){var c=$('.nt-b[data-id="'+nb.id+'"] .nt-cell');if(c)setCaret(c,0);return;}
  if(t==='code'){var ta=$('.nt-b[data-id="'+nb.id+'"] .nt-code-txt');if(ta)ta.focus();return;}
  if(t==='remind'){loadPeople().then(function(){renderDoc({id:nb.id,pos:0});});focusBlock(nb.id,0);return;}
  if(/^(image|video|audio|file|pdf|bookmark|embed)$/.test(t)){var nx2=ensureAfter(nb,'p');if(nx2)focusBlock(nx2.id,0);setTimeout(function(){mediaPop(nb.id);},20);}
}
async function createSubpage(b,empty){
  var r=await api('/api/notes',{method:'POST',body:JSON.stringify({parent_id:S.page.id,link_in_parent:false,title:''})});
  if(!r||!r.id)return toast(L('Kunne ikke oprette siden','Could not create page'),'⚠️');
  op(function(){var nb=bl('page','');nb.pageId=r.id;if(empty)replaceBlock(b,nb);else insertAfter(b.id,nb);});
  await save();await loadTree();go(r.id);S.freshOpen=true;
}

// @-omtale
async function loadPeople(){if(S.people)return S.people;S.people=await api('/api/notes/people')||[];return S.people;}
function openMention(el,b,q,start,node){
  var st={el:el,b:b,start:start,node:node};
  var render=function(){
    var ql=q.toLowerCase(),ppl=(S.people||[]).filter(function(u){return !ql||u.name.toLowerCase().indexOf(ql)>-1;}).slice(0,6);
    var pages=S.tree.filter(function(p){return !ql||(p.title||'').toLowerCase().indexOf(ql)>-1;}).slice(0,6);
    var dates=[{l:L('I dag','Today'),d:0},{l:L('I morgen','Tomorrow'),d:1},{l:L('I går','Yesterday'),d:-1},{l:L('Næste uge','Next week'),d:7}].filter(function(x){return !ql||x.l.toLowerCase().indexOf(ql)>-1;});
    var remind=!ql||L('påmind','remind').indexOf(ql)===0;
    var h='';
    if(ppl.length)h+='<div class="nt-mg">'+L('Personer','People')+'</div>'+ppl.map(function(u){return '<button class="nt-mi" data-m="u" data-id="'+u.id+'" data-n="'+H(u.name)+'"><span class="nt-av" style="background:'+H(u.color||'#4F46E5')+'">'+H(u.initials||u.name.slice(0,2))+'</span>'+H(u.name)+'</button>';}).join('');
    if(dates.length)h+='<div class="nt-mg">'+L('Datoer','Dates')+'</div>'+dates.map(function(x){return '<button class="nt-mi" data-m="d" data-d="'+x.d+'"><span class="nt-mi-i">📅</span>'+x.l+'<span class="nt-mi-k">'+fmtDate(new Date(Date.now()+x.d*864e5))+'</span></button>';}).join('')+'<button class="nt-mi" data-m="dp"><span class="nt-mi-i">🗓️</span>'+L('Vælg dato…','Pick a date…')+'</button>';
    if(remind)h+='<button class="nt-mi" data-m="r"><span class="nt-mi-i">🔔</span>'+L('Påmind mig…','Remind me…')+'</button>';
    if(pages.length)h+='<div class="nt-mg">'+L('Sider','Pages')+'</div>'+pages.map(function(p){return '<button class="nt-mi" data-m="p" data-id="'+p.id+'"><span class="nt-mi-i">'+H(p.icon||'📄')+'</span>'+H(p.title||L('Uden titel','Untitled'))+'</button>';}).join('');
    if(!h){if(q.length>14||/\s\s$/.test(q))closePop();h='<div class="nt-mg">'+L('Ingen resultater','No results')+'</div>';}
    var keep=S.menu&&S.menu.type==='mention'?S.menu:null;
    if(keep){keep.el.innerHTML=h;keep.act=0;place(keep.el,caretRect()||keep.r);}else pop(caretRect(),h,{type:'mention',width:300,cls:'small'});
    var m=S.menu;if(!m)return;m.st=st;hl($$('.nt-mi',m.el),0);
    $$('.nt-mi',m.el).forEach(function(x){x.onmousedown=function(e){e.preventDefault();};x.onclick=function(){runMention(x,m.st);};});
  };
  if(!S.people)loadPeople().then(render);render();
}
function runMention(x,st){
  closePop();stripTrigger(st);var b=st.b,el=st.el,m=x.dataset.m;
  if(m==='u')insertChip('<span class="nt-men" contenteditable="false" data-user="'+(+x.dataset.id)+'">@'+H(x.dataset.n)+'</span>');
  else if(m==='p'){var p=S.byId[x.dataset.id];insertChip('<a class="nt-men" contenteditable="false" href="#kb-notes/'+(+x.dataset.id)+'" data-page="'+(+x.dataset.id)+'">'+H(p&&p.icon||'📄')+' <span>'+H(p&&p.title||L('Uden titel','Untitled'))+'</span></a>');}
  else if(m==='d')insertChip(dateChip(new Date(Date.now()+(+x.dataset.d)*864e5)));
  else if(m==='dp'){var sr=saveRange(),cr=caretRect();datePop(cr,new Date(),function(d){restoreRange(sr);insertChip(dateChip(d));b.html=norm(el.innerHTML);changed();});return;}
  else if(m==='r'){op(function(){var nb=bl('remind',b.html);if(!plain(b.html).trim()){replaceBlock(b,nb);}else insertAfter(b.id,nb);after(nb,'p');});loadPeople().then(function(){renderDoc();});renderDoc();return;}
  b.html=norm(el.innerHTML);changed();
}
function dateChip(d){return '<span class="nt-men nt-date" contenteditable="false" data-date="'+ymd(d)+'">📅 '+H(fmtDate(d))+'</span>';}
function insertChip(html){
  var s=getSelection();if(!s.rangeCount)return;var r=s.getRangeAt(0);r.deleteContents();
  var t=document.createElement('template');t.innerHTML=html+'\u00a0';var frag=t.content,last=frag.lastChild;r.insertNode(frag);
  var r2=document.createRange();r2.setStartAfter(last);r2.collapse(true);s.removeAllRanges();s.addRange(r2);
}
function insertTextAtCaret(t){if(!document.execCommand('insertText',false,t)){var s=getSelection();if(!s.rangeCount)return;var r=s.getRangeAt(0);r.deleteContents();var n=document.createTextNode(t);r.insertNode(n);r.setStartAfter(n);r.collapse(true);s.removeAllRanges();s.addRange(r);}}
function saveRange(){var s=getSelection();return s.rangeCount?s.getRangeAt(0).cloneRange():null;}
function restoreRange(r){if(!r)return;var e=r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentElement;var ed=e&&e.closest('[contenteditable="true"]');if(ed)ed.focus();var s=getSelection();s.removeAllRanges();s.addRange(r);}

function checkTriggers(el,b){
  var s=getSelection();if(!s.rangeCount||!s.isCollapsed){if(S.menu&&/slash|mention/.test(S.menu.type))closePop();return;}
  var n=s.anchorNode;if(!n||n.nodeType!==3){if(S.menu&&/slash|mention/.test(S.menu.type))closePop();return;}
  var t=n.data.slice(0,s.anchorOffset),m;
  if((m=t.match(/(^|[\s\u00a0])\/([^\/\n]{0,24})$/))&&!/^\s/.test(m[2])){openSlash(el,b,m[2],s.anchorOffset-m[2].length-1,n);return;}
  if((m=t.match(/(^|[\s\u00a0])@([^@\n]{0,24})$/))){openMention(el,b,m[2],s.anchorOffset-m[2].length-1,n);return;}
  if(S.menu&&/slash|mention/.test(S.menu.type))closePop();
}

// ── blok-menu (⋮⋮) ──────────────────────────────────────────
function blockMenu(id,mode,anchor){
  var f=find(id);if(!f)return;var b=f.b;
  if(S.sel.indexOf(id)<0)selectBlocks([id]);
  var html;
  if(mode==='turn')html='<div class="nt-mg">'+L('Lav om til','Turn into')+'</div>'+TURN.map(function(t){var it=slashItem(t)||{i:'</>',t:L('Kode','Code')};return '<button class="nt-mi" data-turn="'+t+'"><span class="nt-mi-i">'+it.i+'</span>'+H(it.t)+(b.type===t?'<span class="nt-mi-k">✓</span>':'')+'</button>';}).join('');
  else if(mode==='color')html='<div class="nt-mg">'+L('Tekstfarve','Color')+'</div>'+COLORS.map(function(c){return '<button class="nt-mi" data-col="'+c[0]+'"><span class="nt-mi-i"><span class="nt-sw nt-c-'+(c[0]||'x')+'">A</span></span>'+c[1]+((b.color||'')===c[0]?'<span class="nt-mi-k">✓</span>':'')+'</button>';}).join('')+'<div class="nt-mg">'+L('Baggrund','Background')+'</div>'+COLORS.map(function(c){return '<button class="nt-mi" data-bg="'+c[0]+'"><span class="nt-mi-i"><span class="nt-sw nt-bg-'+(c[0]||'x')+'">A</span></span>'+c[1]+'</button>';}).join('');
  else html=(isTxt(b.type)||b.type==='code'?'<button class="nt-mi" data-a="turn"><span class="nt-mi-i">↻</span>'+L('Lav om til','Turn into')+'<span class="nt-mi-k">›</span></button>':'')+
    '<button class="nt-mi" data-a="color"><span class="nt-mi-i">🎨</span>'+L('Farve','Color')+'<span class="nt-mi-k">›</span></button>'+
    (b.type==='table'?'<button class="nt-mi" data-a="thdr"><span class="nt-mi-i">▦</span>'+L('Overskriftsrække','Header row')+'<span class="nt-mi-k">'+(b.header?'✓':'')+'</span></button>':'')+
    (/^(image|video|audio|file|pdf|bookmark|embed)$/.test(b.type)?'<button class="nt-mi" data-a="media"><span class="nt-mi-i">↻</span>'+L('Erstat','Replace')+'</button>':'')+
    (b.type==='bookmark'?'<button class="nt-mi" data-a="toembed"><span class="nt-mi-i">🧩</span>'+L('Vis som indlejring','Show as embed')+'</button>':'')+(b.type==='embed'?'<button class="nt-mi" data-a="tobm"><span class="nt-mi-i">🔖</span>'+L('Vis som link-kort','Show as bookmark')+'</button>':'')+
    '<div class="nt-sep"></div><button class="nt-mi" data-a="dup"><span class="nt-mi-i">⧉</span>'+L('Duplikér','Duplicate')+'<span class="nt-mi-k">'+MOD+'D</span></button>'+
    '<button class="nt-mi" data-a="up"><span class="nt-mi-i">↑</span>'+L('Flyt op','Move up')+'<span class="nt-mi-k">'+MOD+'⇧↑</span></button><button class="nt-mi" data-a="down"><span class="nt-mi-i">↓</span>'+L('Flyt ned','Move down')+'<span class="nt-mi-k">'+MOD+'⇧↓</span></button>'+
    '<button class="nt-mi" data-a="link"><span class="nt-mi-i">🔗</span>'+L('Kopiér link til blok','Copy link to block')+'</button>'+
    '<button class="nt-mi" data-a="comment"><span class="nt-mi-i">💬</span>'+L('Kommentér','Comment')+'</button>'+
    '<div class="nt-sep"></div><button class="nt-mi" data-a="del"><span class="nt-mi-i">🗑</span>'+L('Slet','Delete')+'<span class="nt-mi-k">Del</span></button>';
  var el=pop(anchor,html,{type:'list',width:250,cls:'small'});
  hl($$('.nt-mi',el),-1);
  el.addEventListener('click',function(e){
    var x=e.target.closest('.nt-mi');if(!x)return;var ids=S.sel.length?S.sel.slice():[id];
    if(x.dataset.a==='turn'||x.dataset.a==='color'){blockMenu(id,x.dataset.a,anchor);return;}
    closePop();
    if(x.dataset.turn){op(function(){ids.forEach(function(i){var g=find(i);if(g&&(isTxt(g.b.type)||g.b.type==='code'))turnInto(g.b,x.dataset.turn);});});if(ids.length>1){renderDoc();reselect(ids);}else{S.sel=[];renderDoc({id:id,pos:'end'});selBar();}return;}
    if(x.dataset.col!=null){op(function(){ids.forEach(function(i){var g=find(i);if(g)g.b.color=x.dataset.col||undefined;});});S.lastColor='c:'+x.dataset.col;renderDoc();reselect(ids);return;}
    if(x.dataset.bg!=null){op(function(){ids.forEach(function(i){var g=find(i);if(g)g.b.bg=x.dataset.bg||(g.b.type==='callout'?'gray':undefined);});});S.lastColor='bg:'+x.dataset.bg;renderDoc();reselect(ids);return;}
    var a=x.dataset.a;
    if(a==='dup')duplicateBlock(id);else if(a==='up')moveBlock(id,-1);else if(a==='down')moveBlock(id,1);else if(a==='del')deleteBlocks(ids);
    else if(a==='media')mediaPop(id);else if(a==='comment')openComments();
    else if(a==='thdr'){op(function(){b.header=!b.header;});renderDoc();}
    else if(a==='toembed'){op(function(){b.type='embed';});renderDoc();}else if(a==='tobm'){op(function(){b.type='bookmark';});renderDoc();fetchPreview(b);}
    else if(a==='link'){copyText(location.origin+'/admin#kb-notes/'+S.page.id+'/'+id);toast(L('Link kopieret','Link copied'),'🔗');}
  });
}
function copyText(t){try{navigator.clipboard.writeText(t);}catch(e){var x=document.createElement('textarea');x.value=t;document.body.appendChild(x);x.select();document.execCommand('copy');x.remove();}}

// ── medier ──────────────────────────────────────────────────
var ACCEPT={image:'image/*',video:'video/*',audio:'audio/*',pdf:'application/pdf',file:''};
function mediaPop(id){
  var f=find(id);if(!f)return;var b=f.b,anchor=$('.nt-b[data-id="'+id+'"] .nt-bc');
  var canUp=ACCEPT[b.type]!=null,link=b.type==='bookmark'||b.type==='embed';
  var hint={youtube:'https://www.youtube.com/watch?v=…',maps:L('Adresse eller Google Maps-link','Address or Google Maps link'),drive:L('Link til Google Docs/Sheets/Slides/Drive (delt)','Link to a shared Google Doc/Sheet/Slides/Drive file'),loom:'https://www.loom.com/share/…',figma:'https://www.figma.com/design/…'}[b.sub]||(b.type==='bookmark'?L('Indsæt link…','Paste a link…'):b.type==='video'?L('Link til YouTube, Vimeo, Loom eller videofil','YouTube, Vimeo, Loom or video file link'):L('Indsæt link…','Paste a link…'));
  var html='<div class="nt-tabs">'+(canUp?'<button class="on" data-tab="up">'+L('Upload','Upload')+'</button>':'')+'<button class="'+(canUp?'':'on')+'" data-tab="ln">'+(link?L('Link','Link'):L('Indsæt link','Embed link'))+'</button></div>'+
    '<div class="nt-pop-pad" data-pane="up"'+(canUp?'':' hidden')+'><button class="nt-btn" data-up="1" style="width:100%">'+L('Vælg fil','Choose a file')+'</button><div style="font-size:12px;color:#8a8178;margin-top:8px;text-align:center">'+L('Maks. 25 MB · eller træk filen ind på siden','Max 25 MB · or drop the file on the page')+'</div></div>'+
    '<div class="nt-pop-pad" data-pane="ln"'+(canUp?' hidden':'')+'><input type="text" placeholder="'+H(hint)+'" value="'+H(b.url||'')+'"'+(canUp?'':' autofocus')+'><button class="nt-btn" data-ok="1" style="width:100%;margin-top:8px">'+(link?L('Indsæt','Embed'):L('Indsæt link','Embed link'))+'</button></div>';
  var el=pop(anchor,html,{width:420});
  el.addEventListener('click',function(e){
    var t=e.target.closest('[data-tab]');if(t){$$('[data-tab]',el).forEach(function(x){x.classList.toggle('on',x===t);});$$('[data-pane]',el).forEach(function(p){p.hidden=p.dataset.pane!==t.dataset.tab;});var i=$('input',el);if(t.dataset.tab==='ln'&&i)i.focus();return;}
    if(e.target.closest('[data-up]')){pickFiles(ACCEPT[b.type],false,function(files){closePop();uploadInto(b,files[0]);});}
    if(e.target.closest('[data-ok]'))doLink();
  });
  var inp=$('input',el);inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();doLink();}if(e.key==='Escape')closePop();});
  function doLink(){
    var v=inp.value.trim();if(!v)return;
    if(b.sub==='maps'&&!/^https?:/i.test(v))v='https://maps.google.com/maps?q='+encodeURIComponent(v)+'&output=embed';
    if(!/^https?:\/\//i.test(v)&&!/^\/filer\//.test(v))v='https://'+v;
    closePop();op(function(){b.url=v;delete b.uploading;if(b.type!=='bookmark'&&!b.name){try{b.name=decodeURIComponent(v.split('/').pop().split('?')[0]);}catch(e){}}});
    var nx=find(b.id)?ensureAfter(b,'p'):null;renderDoc(nx?{id:nx.id,pos:0}:null);if(b.type==='bookmark')fetchPreview(b);
  }
}
async function fetchPreview(b){
  var r=await api('/api/notes/link-preview?url='+encodeURIComponent(b.url));
  if(r&&!r.error){b.title=r.title;b.desc=r.desc;b.image=r.image;b.site=r.site;renderDoc();changed();}
}
function pickFiles(accept,multi,cb){var i=document.createElement('input');i.type='file';if(accept)i.accept=accept;i.multiple=!!multi;i.onchange=function(){if(i.files.length)cb(Array.prototype.slice.call(i.files));};i.click();}
async function upload(file){
  if(file.size>25*1024*1024){toast(L('Filen er over 25 MB','File is larger than 25 MB'),'⚠️');return null;}
  try{
    var r=await fetch('/api/notes/upload',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(file.name||'fil'),'X-File-Type':file.type||'application/octet-stream'},body:file});
    var d=await r.json();if(!r.ok)throw new Error(d.error||'Upload fejlede');return d;
  }catch(e){toast(e.message||L('Upload fejlede','Upload failed'),'⚠️');return null;}
}
function typeForFile(f){var t=f.type||'';return /^image\//.test(t)?'image':/^video\//.test(t)?'video':/^audio\//.test(t)?'audio':t==='application/pdf'?'pdf':'file';}
async function uploadInto(b,file){
  b.uploading=file.name;renderDoc();
  var d=await upload(file);
  var f=find(b.id);if(!f)return;
  delete b.uploading;
  if(!d){renderDoc();return;}
  op(function(){b.url=d.url;b.name=d.name;b.size=d.size;b.mime=d.mime;});renderDoc();
}
async function uploadFiles(files,afterId){
  var anchorId=afterId,created=[];
  op(function(){files.forEach(function(file){var nb=bl(typeForFile(file),'');nb.uploading=file.name;if(anchorId){var f=find(anchorId);if(f&&isTxt(f.b.type)&&!plain(f.b.html).trim()&&!created.length){replaceBlock(f.b,nb);}else insertAfter(anchorId,nb,true);}else S.page.blocks.push(nb);anchorId=nb.id;created.push([nb,file]);});});
  renderDoc();
  for(var i=0;i<created.length;i++){var nb=created[i][0],d=await upload(created[i][1]);var f=find(nb.id);if(!f)continue;delete nb.uploading;if(d){nb.url=d.url;nb.name=d.name;nb.size=d.size;nb.mime=d.mime;}else f.list.splice(f.i,1);renderDoc();}
  if(created.length)after(created[created.length-1][0],'p');
  changed();snapshot();
}

// ── AI ──────────────────────────────────────────────────────
function pageText(limit){
  var out=[];walk(S.page.blocks,function(b){var t=b.html!=null?plain(b.html):(b.code||'');if(b.rows)t=b.rows.map(function(r){return r.map(plain).join(' | ');}).join('\n');if(!t.trim())return;var pre={h1:'# ',h2:'## ',h3:'### ',th1:'# ',th2:'## ',th3:'### ',bullet:'- ',num:'1. ',todo:b.checked?'[x] ':'[ ] ',quote:'> '}[b.type]||'';out.push('  '.repeat(b.indent||0)+pre+t);});
  return ((S.page.title?'# '+S.page.title+'\n':'')+out.join('\n')).slice(0,limit||15000);
}
function aiBlock(b,k){
  var auto={'ai-sum':'summarize','ai-todo':'todos','ai-cont':'continue'}[k];
  var anchor=$('.nt-b[data-id="'+b.id+'"]')||$('#nt-doc');
  var html='<div class="nt-pop-pad"><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;font-weight:600;color:#8b4bd1">✨ AI</div>'+
    '<textarea rows="2" placeholder="'+L('Bed AI om at skrive noget… fx “Lav en tjekliste til aflevering af et badeværelse”','Ask AI to write… e.g. “A checklist for handing over a bathroom”')+'" autofocus></textarea>'+
    '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">'+[['summarize',L('Opsummér siden','Summarize page')],['todos',L('Find opgaver','Find action items')],['continue',L('Fortsæt med at skrive','Continue writing')]].map(function(x){return '<button class="nt-btn sec" data-q="'+x[0]+'" style="padding:5px 10px;font-weight:500">'+x[1]+'</button>';}).join('')+'</div>'+
    '<div data-res></div></div>';
  var el=pop(anchor.getBoundingClientRect(),html,{width:520});
  var ta=$('textarea',el),res=$('[data-res]',el),last=null;
  async function run(action){
    var prompt=ta.value.trim();if(action==='write'&&!prompt){ta.focus();return;}
    res.innerHTML='<div style="padding:10px 0;color:#8a8178"><span class="nt-spin"></span> '+L('AI skriver…','AI is writing…')+'</div>';
    var r=await api('/api/notes/ai',{method:'POST',body:JSON.stringify({action:action,prompt:prompt,text:action==='write'?'':pageText(),context:action==='write'?pageText(8000):''})});
    if(!r||r.ok===false||(!r.blocks&&!r.text)){res.innerHTML='<div style="color:#b3261e;padding:8px 0">'+H((r&&r.error)||L('AI svarede ikke','AI did not respond'))+'</div>';return;}
    last=r.blocks||[{type:'p',html:r.text}];
    res.innerHTML='<div class="nt-aires">'+last.map(function(x){return ({h1:'# ',h2:'## ',h3:'### ',bullet:'• ',num:'1. ',todo:'☐ ',quote:'❝ '}[x.type]||'')+plain(x.html);}).join('\n')+'</div><div style="display:flex;gap:6px"><button class="nt-btn" data-ins="1">'+L('Indsæt','Insert')+'</button><button class="nt-btn sec" data-again="1">'+L('Prøv igen','Try again')+'</button><button class="nt-btn sec" data-close="1">'+L('Kassér','Discard')+'</button></div>';
    S.aiLast=action;place(el,anchor.getBoundingClientRect());
  }
  el.addEventListener('click',function(e){
    var q=e.target.closest('[data-q]');if(q){run(q.dataset.q);return;}
    if(e.target.closest('[data-again]')){run(S.aiLast||'write');return;}
    if(e.target.closest('[data-close]')){closePop();return;}
    if(e.target.closest('[data-ins]')&&last){closePop();op(function(){var ins=last.map(function(x){return bl(x.type,x.html);}),f=find(b.id);if(!f){S.page.blocks=S.page.blocks.concat(ins);return;}var empty=isTxt(b.type)&&!plain(b.html).trim();ins.forEach(function(x){x.indent=b.indent||0;});f.list.splice.apply(f.list,[empty?f.i:f.i+1,empty?1:0].concat(ins));});renderDoc();renderTemplates(false);}
  });
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();run('write');}if(e.key==='Escape')closePop();});
  if(auto)run(auto);
}
function aiSelection(range,anchor){
  var el0=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement;
  var ed=el0.closest('.nt-txt,.nt-cell,.nt-cap'),be=ed&&ed.closest('.nt-b');if(!ed||!be)return;
  var d=document.createElement('div');d.appendChild(range.cloneContents());var text=d.innerHTML;
  var acts=[['improve','✍️',L('Forbedr sproget','Improve writing')],['fix','✔️',L('Ret stavning og grammatik','Fix spelling & grammar')],['shorter','↘️',L('Gør kortere','Make shorter')],['longer','↗️',L('Gør længere','Make longer')],['tone_friendly','😊',L('Venligere tone','Friendlier tone')],['tone_formal','👔',L('Mere formel tone','More formal tone')],['translate_en','🇬🇧',L('Oversæt til engelsk','Translate to English')],['translate_da','🇩🇰',L('Oversæt til dansk','Translate to Danish')],['summarize','📝',L('Opsummér','Summarize')],['todos','☑️',L('Lav til to-dos','Turn into to-dos')]];
  var html='<div class="nt-mg">✨ '+L('Gør det med AI','Edit with AI')+'</div>'+acts.map(function(a){return '<button class="nt-mi" data-ai="'+a[0]+'"><span class="nt-mi-i">'+a[1]+'</span>'+a[2]+'</button>';}).join('');
  var el=pop(anchor,html,{type:'list',width:280,cls:'small'});hl($$('.nt-mi',el),-1);
  el.addEventListener('click',async function(e){
    var x=e.target.closest('[data-ai]');if(!x)return;var action=x.dataset.ai;
    el.innerHTML='<div class="nt-pop-pad" style="color:#8a8178"><span class="nt-spin"></span> '+L('AI arbejder…','AI is working…')+'</div>';
    var r=await api('/api/notes/ai',{method:'POST',body:JSON.stringify({action:action,text:text,context:pageText(6000)})});
    if(!r||r.ok===false||(!r.text&&!r.blocks)){el.innerHTML='<div class="nt-pop-pad" style="color:#b3261e">'+H((r&&r.error)||L('AI svarede ikke','AI did not respond'))+'</div>';return;}
    var out=r.text,blocks=r.blocks;
    el.innerHTML='<div class="nt-pop-pad" style="width:440px;box-sizing:border-box"><div class="nt-aires">'+(blocks?blocks.map(function(x){return ({bullet:'• ',num:'1. ',todo:'☐ '}[x.type]||'')+plain(x.html);}).join('\n'):H(plain(out)))+'</div><div style="display:flex;gap:6px">'+(blocks?'':'<button class="nt-btn" data-rep="1">'+L('Erstat','Replace')+'</button>')+'<button class="nt-btn'+(blocks?'':' sec')+'" data-below="1">'+L('Indsæt under','Insert below')+'</button><button class="nt-btn sec" data-close="1">'+L('Kassér','Discard')+'</button></div></div>';
    place(el,anchor);
    el.onclick=function(ev){
      if(ev.target.closest('[data-close]'))return closePop();
      var id=be.dataset.id,f=find(id);if(!f)return closePop();
      if(ev.target.closest('[data-rep]')){closePop();restoreRange(range);var s=getSelection(),rg=s.getRangeAt(0);rg.deleteContents();var t=document.createElement('template');t.innerHTML=out;rg.insertNode(t.content);syncEditable(ed);snapshot();}
      if(ev.target.closest('[data-below]')){closePop();op(function(){var ins=(blocks||[{type:'p',html:out}]).map(function(x){var n=bl(x.type,x.html);n.indent=f.b.indent||0;return n;});f.list.splice.apply(f.list,[groupEnd(f.list,f.i),0].concat(ins));});renderDoc();}
    };
  });
}

// ── markeringslinje ────────────────────────────────────────
var stbEl=null;
function hideStb(){if(stbEl){stbEl.remove();stbEl=null;}}
function showStb(){
  var s=getSelection();if(!s.rangeCount||s.isCollapsed){hideStb();return;}
  var r=s.getRangeAt(0),c=r.commonAncestorContainer,e=c.nodeType===1?c:c.parentElement;
  var ed=e&&e.closest('#nt-doc .nt-txt,#nt-doc .nt-cell,#nt-doc .nt-cap');if(!ed||!r.toString().trim()){hideStb();return;}
  var rect=r.getBoundingClientRect();
  if(!stbEl){stbEl=document.createElement('div');stbEl.className='nt-stb';stbEl.setAttribute('data-no-i18n','');document.body.appendChild(stbEl);
    stbEl.addEventListener('mousedown',function(ev){ev.preventDefault();});
    stbEl.addEventListener('click',stbClick);}
  var isT=ed.classList.contains('nt-txt');
  stbEl.innerHTML='<button class="ai" data-s="ai">✨ AI</button><i></i>'+(isT?'<button data-s="turn">'+H(typeName(find(ed.closest('.nt-b').dataset.id).b.type))+' ▾</button><i></i>':'')+
    '<button data-s="bold" title="'+MOD+'B"><b>B</b></button><button data-s="italic" title="'+MOD+'I"><i style="width:auto;background:none;margin:0;font-style:italic">i</i></button><button data-s="underline" title="'+MOD+'U"><u>U</u></button><button data-s="strikeThrough" title="'+MOD+'⇧S"><s>S</s></button><button data-s="code" title="'+MOD+'E">&lt;/&gt;</button><button data-s="link" title="'+MOD+'K">🔗</button><i></i><button data-s="size" title="'+L('Skriftstørrelse','Text size')+'">Aa</button><button data-s="align" title="'+L('Justering (venstre, centreret, højre)','Alignment')+'">'+alIcon('')+'</button><button data-s="color" title="'+L('Farve','Color')+'">A ▾</button><button data-s="comment" title="'+L('Kommentér','Comment')+'">💬</button>';
  var w=stbEl.offsetWidth,x=Math.max(8,Math.min(innerWidth-w-8,rect.left+rect.width/2-w/2)),y=rect.top-stbEl.offsetHeight-8;if(y<8)y=rect.bottom+8;
  stbEl.style.left=x+'px';stbEl.style.top=y+'px';
}
function syncEditable(ed){
  var be=ed&&ed.closest('.nt-b');if(!be)return;var f=find(be.dataset.id);if(!f)return;
  if(ed.classList.contains('nt-txt'))f.b.html=norm(ed.innerHTML);
  else if(ed.classList.contains('nt-cap'))f.b.caption=norm(ed.innerHTML);
  else if(ed.classList.contains('nt-cell')){var r=+ed.dataset.r,c=+ed.dataset.c;if(f.b.rows&&f.b.rows[r])f.b.rows[r][c]=norm(ed.innerHTML);}
  changed();
}
function curEditable(){var s=getSelection();if(!s.rangeCount)return null;var n=s.anchorNode;var e=n&&(n.nodeType===1?n:n.parentElement);return e&&e.closest('#nt-doc .nt-txt,#nt-doc .nt-cell,#nt-doc .nt-cap');}
function wrapSel(tag,cls){
  var s=getSelection();if(!s.rangeCount||s.isCollapsed)return;var r=s.getRangeAt(0),ed=curEditable();
  // allerede formateret? så fjern formateringen
  var anc=r.commonAncestorContainer;anc=anc.nodeType===1?anc:anc.parentElement;var ex=anc.closest(tag+(cls?'.'+cls.split(' ')[0]:''));
  if(ex&&ed&&ed.contains(ex)&&!cls){var p=ex.parentNode;while(ex.firstChild)p.insertBefore(ex.firstChild,ex);p.removeChild(ex);}
  else{var e=document.createElement(tag);if(cls)e.className=cls;e.appendChild(r.extractContents());if(cls){var pre=cls.indexOf('nt-bg-')===0?'nt-bg-':'nt-c-';$$('span[class^="'+pre+'"]',e).forEach(function(x){while(x.firstChild)x.parentNode.insertBefore(x.firstChild,x);x.remove();});}r.insertNode(e);r.selectNodeContents(e);s.removeAllRanges();s.addRange(r);}
  if(ed)syncEditable(ed);
}
function applyColor(k){
  var ed=curEditable();if(!ed)return;var v=k.split(':')[1];
  if(!v){var s=getSelection(),r=s.getRangeAt(0),d=document.createElement('div');d.appendChild(r.extractContents());$$('[class*="nt-c-"],[class*="nt-bg-"]',d).forEach(function(x){if(x.tagName==='SPAN'&&!x.dataset.user){while(x.firstChild)x.parentNode.insertBefore(x.firstChild,x);x.remove();}});var fr=document.createDocumentFragment();while(d.firstChild)fr.appendChild(d.firstChild);r.insertNode(fr);syncEditable(ed);return;}
  wrapSel('span',(k[0]==='c'?'nt-c-':'nt-bg-')+v);S.lastColor=k;
}
function linkSel(anchor){
  var saved=saveRange(),ed=curEditable();if(!saved||!ed)return;
  var el=pop(anchor||caretRect(),'<div class="nt-pop-pad"><input type="text" placeholder="'+L('Indsæt link eller søg efter side','Paste link or search pages')+'" autofocus><div data-pl></div></div>',{width:340});
  var inp=$('input',el),pl=$('[data-pl]',el);
  function apply(href){closePop();restoreRange(saved);if(!href){document.execCommand('unlink');}else{document.execCommand('createLink',false,href);var s=getSelection();var a=s.anchorNode&&(s.anchorNode.nodeType===1?s.anchorNode:s.anchorNode.parentElement);var ae=a&&a.closest('a');if(ae&&/^https?:/.test(href)){ae.target='_blank';ae.rel='noopener';}}syncEditable(ed);}
  inp.addEventListener('input',function(){var q=inp.value.toLowerCase().trim();pl.innerHTML=q&&!/^https?:|\./.test(q)?S.tree.filter(function(p){return (p.title||'').toLowerCase().indexOf(q)>-1;}).slice(0,6).map(function(p){return '<button class="nt-mi" data-pid="'+p.id+'"><span class="nt-mi-i">'+H(p.icon||'📄')+'</span>'+H(p.title||L('Uden titel','Untitled'))+'</button>';}).join(''):'';});
  pl.addEventListener('click',function(e){var x=e.target.closest('[data-pid]');if(x)apply('#kb-notes/'+x.dataset.pid);});
  inp.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var v=inp.value.trim();if(v&&!/^(https?:|mailto:|tel:|#|\/)/.test(v))v='https://'+v;apply(v);}if(e.key==='Escape'){closePop();restoreRange(saved);}});
}
function stbClick(e){
  var x=e.target.closest('[data-s]');if(!x)return;var k=x.dataset.s,s=getSelection();if(!s.rangeCount)return;var r=s.getRangeAt(0).cloneRange();
  var xr=x.getBoundingClientRect();
  if(k==='ai'){hideStb();aiSelection(r,xr);return;}
  if(k==='turn'){var ed=curEditable();if(ed){hideStb();blockMenu(ed.closest('.nt-b').dataset.id,'turn',xr);}return;}
  if(k==='code'){wrapSel('code');return;}
  if(k==='size'){var ed2=curEditable();if(ed2){hideStb();sizePop(xr,[ed2.closest('.nt-b').dataset.id]);}return;}
  if(k==='align'){var ed3=curEditable();if(ed3){hideStb();alignPop(xr,[ed3.closest('.nt-b').dataset.id]);}return;}
  if(k==='link'){hideStb();linkSel(xr);return;}
  if(k==='comment'){hideStb();openComments('“'+r.toString().slice(0,120)+'” – ');return;}
  if(k==='color'){var saved=saveRange();var el=pop(xr,'<div class="nt-mg">'+L('Tekstfarve','Color')+'</div>'+COLORS.map(function(c){return '<button class="nt-mi" data-k="c:'+c[0]+'"><span class="nt-mi-i"><span class="nt-sw nt-c-'+(c[0]||'x')+'">A</span></span>'+c[1]+'</button>';}).join('')+'<div class="nt-mg">'+L('Baggrund','Background')+'</div>'+COLORS.slice(1).map(function(c){return '<button class="nt-mi" data-k="bg:'+c[0]+'"><span class="nt-mi-i"><span class="nt-sw nt-bg-'+c[0]+'">A</span></span>'+c[1]+'</button>';}).join(''),{type:'list',cls:'small',width:220});
    hl($$('.nt-mi',el),-1);el.addEventListener('mousedown',function(ev){ev.preventDefault();});el.addEventListener('click',function(ev){var y=ev.target.closest('[data-k]');if(!y)return;closePop();restoreRange(saved);applyColor(y.dataset.k);});return;}
  document.execCommand(k);var ed2=curEditable();if(ed2)syncEditable(ed2);setTimeout(showStb,0);
}

// ── vælgere ─────────────────────────────────────────────────
function emojiPicker(anchor,cb,o){
  o=o||{};
  var html='<div class="nt-tabs" style="justify-content:space-between"><span style="padding:6px 0;font-size:13px;font-weight:600">'+L('Vælg ikon','Pick an icon')+'</span><span>'+(o.remove?'<button data-x="rm">'+L('Fjern','Remove')+'</button>':'')+'<button data-x="rnd">🎲 '+L('Tilfældig','Random')+'</button></span></div><div style="max-height:320px;overflow:auto">'+
    Object.keys(EMOJI).map(function(k){return '<div class="nt-mg">'+H(k)+'</div><div class="nt-egrid">'+EMOJI[k].split(' ').map(function(e){return '<button data-e="'+e+'">'+e+'</button>';}).join('')+'</div>';}).join('')+'</div>';
  var el=pop(anchor,html,{width:380});
  el.addEventListener('mousedown',function(e){if(e.target.closest('button'))e.preventDefault();});
  el.addEventListener('click',function(e){var b=e.target.closest('[data-e]');if(b){closePop();cb(b.dataset.e);return;}var x=e.target.closest('[data-x]');if(!x)return;closePop();cb(x.dataset.x==='rm'?null:ALL_EMOJI[Math.floor(Math.random()*ALL_EMOJI.length)]);});
}
function datePop(anchor,d,cb){
  var el=pop(anchor,'<div class="nt-pop-pad"><input type="date" value="'+ymd(d)+'" autofocus><button class="nt-btn" style="width:100%;margin-top:8px">'+L('Indsæt','Insert')+'</button></div>',{width:240});
  var i=$('input',el);$('button',el).onclick=function(){if(i.value){closePop();cb(new Date(i.value+'T12:00'));}};
  i.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();$('button',el).click();}});
}
function coverPicker(anchor){
  var p=S.page;
  var html='<div class="nt-tabs"><button class="on" data-tab="g">'+L('Galleri','Gallery')+'</button><button data-tab="u">'+L('Upload','Upload')+'</button><button data-tab="l">'+L('Link','Link')+'</button></div>'+
    '<div data-pane="g"><div class="nt-cgrid">'+Object.keys(GRADS).map(function(k){return '<button data-g="'+k+'" style="background:'+GRADS[k]+'" title="'+k+'"></button>';}).join('')+'</div></div>'+
    '<div data-pane="u" hidden class="nt-pop-pad"><button class="nt-btn" data-up="1" style="width:100%">'+L('Upload billede','Upload image')+'</button><div style="font-size:12px;color:#8a8178;margin-top:8px;text-align:center">'+L('Bredformat på mindst 1500 pixels virker bedst','Images wider than 1500 pixels work best')+'</div></div>'+
    '<div data-pane="l" hidden class="nt-pop-pad"><input type="text" placeholder="https://…"><button class="nt-btn" data-ok="1" style="width:100%;margin-top:8px">'+L('Brug billedet','Use image')+'</button></div>';
  var el=pop(anchor,html,{width:420});
  el.addEventListener('click',async function(e){
    var t=e.target.closest('[data-tab]');if(t){$$('[data-tab]',el).forEach(function(x){x.classList.toggle('on',x===t);});$$('[data-pane]',el).forEach(function(x){x.hidden=x.dataset.pane!==t.dataset.tab;});return;}
    var g=e.target.closest('[data-g]');if(g){closePop();setCover('gradient:'+g.dataset.g);return;}
    if(e.target.closest('[data-up]')){pickFiles('image/*',false,async function(fs){closePop();toast(L('Uploader cover…','Uploading cover…'),'⏳');var d=await upload(fs[0]);if(d)setCover(d.url,50);});return;}
    if(e.target.closest('[data-ok]')){var v=$('input',el).value.trim();if(v){closePop();setCover(/^https?:/.test(v)?v:'https://'+v,50);}}
  });
}
function setCover(u,pos){S.page.cover_url=u;if(pos!=null)S.page.cover_pos=pos;var f={cover_url:1};if(pos!=null)f.cover_pos=1;markDirty(f);renderPage();var ti=S.byId[S.page.id];}
function pagePicker(anchor,title,cb,exclude){
  var el=pop(anchor,'<div class="nt-pop-pad" style="padding-bottom:4px"><input type="text" placeholder="'+H(title)+'…" autofocus></div><div data-l style="padding-bottom:6px"></div>',{type:'list',width:320,cls:'small'});
  var inp=$('input',el),l=$('[data-l]',el);
  function r(){var q=inp.value.toLowerCase().trim();var ps=S.tree.filter(function(p){return (!exclude||!exclude[p.id])&&(!q||(p.title||'').toLowerCase().indexOf(q)>-1);}).slice(0,30);
    l.innerHTML=ps.map(function(p){return '<button class="nt-mi" data-pid="'+p.id+'"><span class="nt-mi-i">'+H(p.icon||'📄')+'</span>'+H(p.title||L('Uden titel','Untitled'))+'<span class="nt-mi-k">'+(p.scope==='private'?'🔒':'')+'</span></button>';}).join('')||'<div class="nt-mg">'+L('Ingen sider','No pages')+'</div>';S.menu.act=0;hl($$('.nt-mi',l),0);}
  inp.addEventListener('input',r);r();
  l.addEventListener('click',function(e){var x=e.target.closest('[data-pid]');if(x){closePop();cb(+x.dataset.pid);}});
}

// ── sider: opret, flyt, slet ───────────────────────────────
async function createPage(scope,parentId,extra){
  var body=Object.assign({scope:notesOnly()?'private':(scope||'shared')},extra||{});if(parentId)body.parent_id=parentId;
  if(parentId&&S.page&&S.page.id===parentId)body.link_in_parent=false;
  var r=await api('/api/notes',{method:'POST',body:JSON.stringify(body)});
  if(!r||!r.id){toast((r&&r.error)||L('Kunne ikke oprette siden','Could not create page'),'⚠️');return;}
  if(parentId&&S.page&&S.page.id===parentId){op(function(){var nb=bl('page','');nb.pageId=r.id;S.page.blocks.push(nb);});await save();}
  if(parentId)setExp(String(parentId),true);
  await loadTree();go(r.id);
  setTimeout(function(){var t=$('.nt-title');if(t)t.focus();},120);
}
/* ── Importér fra Notion (nov. 2026) ──────────────────────────────
   Tager Notions eksport (Indstillinger → Eksportér alt arbejdsområde-
   indhold → HTML, .zip) og genskaber alle sider som NYE sider under én ny
   rodside "Notion-import (dato)". Eksisterende noter røres aldrig.
   Undersider, toggles, to-do, tabeller, kolonner, callouts, billeder og
   filer følger med; billeder/filer uploades til portalen. */
function loadJSZip(){if(window.JSZip)return Promise.resolve(window.JSZip);return new Promise(function(res,rej){var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';s.onload=function(){res(window.JSZip);};s.onerror=function(){rej(new Error(L('Kunne ikke hente zip-læseren','Could not load zip reader')));};document.head.appendChild(s);});}
function impNorm(p){var out=[];String(p).split('/').forEach(function(s){if(!s||s==='.')return;if(s==='..')out.pop();else out.push(s);});return out.join('/');}
function impDir(p){var i=p.lastIndexOf('/');return i<0?'':p.slice(0,i);}
function impKey(s){return String(s).replace(/\.html?$/i,'').replace(/\s+[0-9a-f]{32}$/i,'').replace(/\s+[0-9a-f-]{36}$/i,'').trim().toLowerCase();}
function impMime(n){var e=(String(n).split('.').pop()||'').toLowerCase();return ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',heic:'image/heic',pdf:'application/pdf',mp4:'video/mp4',mov:'video/quicktime',mp3:'audio/mpeg',m4a:'audio/mp4',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',csv:'text/csv',txt:'text/plain',zip:'application/zip'})[e]||'application/octet-stream';}
function openNotionImport(){
  closeDialog();
  var ov=document.createElement('div');ov.className='nt-ovl';ov.id='nt-ovl';ov.setAttribute('data-no-i18n','');
  ov.innerHTML='<div class="nt-dlg" style="max-height:86vh"><div class="nt-dlg-h"><span>📥 '+L('Importér fra Notion','Import from Notion')+'</span><button class="nt-ib" data-x="1" style="margin-left:auto">✕</button></div>'+
   '<div class="nt-imp" style="padding:18px 20px;overflow:auto;line-height:1.55">'+
   '<ol style="margin:0 0 14px;padding-left:20px">'+
   '<li>'+L('Åbn Notion → <b>Settings</b> → <b>General</b> → <b>Export all workspace content</b> (eller ••• på en enkelt side → <b>Export</b>).','In Notion open <b>Settings</b> → <b>General</b> → <b>Export all workspace content</b> (or ••• on one page → <b>Export</b>).')+'</li>'+
   '<li>'+L('Vælg <b>HTML</b>, “Everything” og “Include subpages”. Notion mailer et link — download .zip-filen.','Pick <b>HTML</b>, “Everything” and “Include subpages”. Notion emails a link — download the .zip.')+'</li>'+
   '<li>'+L('Vælg filen herunder. Alt lægges under én ny side, så dine nuværende noter ikke røres.','Choose the file below. Everything goes under one new page, so your existing notes are untouched.')+'</li></ol>'+
   '<label style="display:block;margin:0 0 10px"><input type="file" accept=".zip,application/zip" class="nt-imp-f"></label>'+
   '<div style="display:'+(notesOnly()?'none':'flex')+';gap:16px;margin:0 0 14px;flex-wrap:wrap"><label><input type="radio" name="nt-imp-s" value="private" checked> 🔒 '+L('Mine private sider','My private pages')+'</label><label><input type="radio" name="nt-imp-s" value="shared"> 👥 '+L('Fælles','Shared')+'</label></div>'+
   '<button class="nt-imp-go" disabled style="background:#2b2622;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer;opacity:.5">'+L('Start import','Start import')+'</button>'+
   '<div class="nt-imp-st" style="margin-top:14px;color:#6d655d;white-space:pre-wrap"></div>'+
   '<div class="nt-imp-bar" hidden style="height:6px;background:#ece6de;border-radius:4px;margin-top:8px;overflow:hidden"><div style="height:100%;width:0;background:#c0704f;transition:width .2s"></div></div>'+
   '</div></div>';
  document.body.appendChild(ov);
  var f=$('.nt-imp-f',ov),gob=$('.nt-imp-go',ov),st=$('.nt-imp-st',ov),bar=$('.nt-imp-bar',ov),busy=false;
  f.addEventListener('change',function(){gob.disabled=!f.files.length;gob.style.opacity=f.files.length?1:.5;});
  ov.addEventListener('mousedown',function(e){if(busy)return;if(e.target===ov||e.target.closest('[data-x]'))closeDialog();});
  gob.addEventListener('click',async function(){
    if(busy||!f.files.length)return;busy=true;gob.disabled=true;gob.style.opacity=.5;f.disabled=true;bar.hidden=false;
    var scope=($('input[name=nt-imp-s]:checked',ov)||{}).value||'private';
    try{
      var res=await importNotionZip(f.files[0],scope,function(msg,frac){st.textContent=msg;if(frac!=null)bar.firstChild.style.width=Math.round(frac*100)+'%';});
      st.textContent=L('Færdig ✓ ','Done ✓ ')+res.pages+' '+L('sider','pages')+(res.files?', '+res.files+' '+L('billeder/filer','images/files'):'')+(res.warn.length?'\n'+L('Bemærk:','Note:')+'\n• '+res.warn.slice(0,8).join('\n• '):'');
      bar.firstChild.style.width='100%';busy=false;
      await loadTree();setExp(String(res.root),true);renderTree();go2(res.root);
    }catch(e){busy=false;st.textContent='⚠️ '+(e&&e.message||e);f.disabled=false;gob.disabled=false;gob.style.opacity=1;}
  });
  function go2(id){var b=document.createElement('button');b.textContent=L('Åbn importen','Open import');b.style.cssText='margin-top:12px;background:#c0704f;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer';b.onclick=function(){closeDialog();go(id);};st.parentNode.appendChild(b);}
}
async function importNotionZip(file,scope,prog){
  prog(L('Læser zip-filen…','Reading zip…'),0);
  var JSZip=await loadJSZip();
  var files={};
  async function addZip(z,depth){
    var ents=[];z.forEach(function(p,e){if(!e.dir)ents.push(e);});
    for(var i=0;i<ents.length;i++){var e=ents[i];
      if(/\.zip$/i.test(e.name)&&depth<2){var inner=await JSZip.loadAsync(await e.async('arraybuffer'));await addZip(inner,depth+1);}
      else if(!/(^|\/)(__MACOSX|\.DS_Store)/.test(e.name))files[impNorm(e.name)]=e;}
  }
  await addZip(await JSZip.loadAsync(file),0);
  var htmlPaths=Object.keys(files).filter(function(p){return /\.html?$/i.test(p);});
  if(!htmlPaths.length){if(Object.keys(files).some(function(p){return /\.md$/i.test(p);}))throw new Error(L('Filen er en Markdown-eksport. Eksportér igen og vælg “HTML” som format.','This is a Markdown export. Export again and choose “HTML”.'));throw new Error(L('Fandt ingen Notion-sider i filen.','No Notion pages found in the file.'));}
  // Notions egen oversigtsside (index.html i roden) springes over
  htmlPaths=htmlPaths.filter(function(p){return !(p.toLowerCase()==='index.html'&&htmlPaths.length>1);});
  // Forældre: "Mappe/Side abc.html" hører under "Mappe.html" i niveauet over (matcher også uden Notion-id'er)
  var byKey={};htmlPaths.forEach(function(p){byKey[impDir(p)+'|'+impKey(p.split('/').pop())]=p;});
  function parentOf(p){var d=impDir(p);while(d){var pd=impDir(d),nm=d.split('/').pop();var cand=byKey[pd+'|'+impKey(nm)];if(cand&&cand!==p)return cand;d=pd;}return null;}
  var parent={},kids={},roots=[];
  htmlPaths.sort(function(a,b){return a.localeCompare(b,'da');});
  htmlPaths.forEach(function(p){var par=parentOf(p);parent[p]=par;if(par)(kids[par]=kids[par]||[]).push(p);else roots.push(p);});
  var warn=[],total=htmlPaths.length,done=0,nfiles=0;
  // Rodside til hele importen
  var d=new Date(),stamp=d.getDate()+'. '+MON_DA[d.getMonth()]+' '+d.getFullYear();
  var root=await api('/api/notes',{method:'POST',body:JSON.stringify({scope:scope,title:'Notion-import '+stamp,icon:'📥',blocks:[]})});
  if(!root||!root.id)throw new Error((root&&root.error)||L('Kunne ikke oprette importsiden','Could not create import page'));
  // Fase 1: læs alle sider og opret tomme sider i rækkefølge (forældre før børn)
  var info={},ids={},order=[];
  (function walk(list){list.forEach(function(p){order.push(p);walk(kids[p]||[]);});})(roots);
  for(var i=0;i<order.length;i++){var p=order[i];
    prog(L('Opretter sider ','Creating pages ')+(i+1)+'/'+total+'…',0.05+0.35*(i/total));
    var html=await files[p].async('string');var doc=new DOMParser().parseFromString(html,'text/html');
    var t=doc.querySelector('.page-title'),ic=doc.querySelector('.page-header-icon');
    var title=(t&&t.textContent.trim())||(doc.title||'').trim()||impKey(p.split('/').pop())||L('Uden titel','Untitled');
    var icon=ic&&!ic.querySelector('img')?ic.textContent.trim().slice(0,8):null;
    info[p]={doc:doc,title:title};
    var r=await api('/api/notes',{method:'POST',body:JSON.stringify({parent_id:parent[p]?ids[parent[p]]:root.id,title:title.slice(0,300),icon:icon||null,blocks:[],link_in_parent:false})});
    if(!r||!r.id)throw new Error((r&&r.error)||L('Kunne ikke oprette siden ','Could not create page ')+title);
    ids[p]=r.id;
  }
  // Fase 2: byg indholdet (billeder/filer uploades) og gem
  var upl={};
  async function upload(path){
    if(upl[path]!==undefined)return upl[path];
    var e=files[path];if(!e){upl[path]=null;return null;}
    var blob=await e.async('blob');var name=path.split('/').pop();
    if(blob.size>25*1024*1024){warn.push(L('For stor fil sprunget over: ','File too large, skipped: ')+name);upl[path]=null;return null;}
    var r=await fetch((window.API||'')+'/api/notes/upload',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/octet-stream','X-File-Name':encodeURIComponent(name),'X-File-Type':impMime(name)},body:blob});
    var j=await r.json().catch(function(){return null;});
    upl[path]=j&&j.url?{url:j.url,name:j.name||name,size:j.size||blob.size,mime:j.mime||impMime(name)}:null;
    if(upl[path])nfiles++;else warn.push(L('Kunne ikke uploade ','Could not upload ')+name);
    return upl[path];
  }
  function local(href,base){if(!href||/^(https?:|mailto:|tel:|#|data:)/i.test(href))return null;var h=href.split('#')[0].split('?')[0];try{h=decodeURIComponent(h);}catch(x){}return impNorm((impDir(base)?impDir(base)+'/':'')+h);}
  async function convert(el,base){
    var marks=[],M=function(o){marks.push(o);var p=el.ownerDocument.createElement('p');p.textContent='⟦NT'+(marks.length-1)+'⟧';return p;};
    // Kolonner først (de konverteres rekursivt)
    $$(':scope .column-list',el).forEach(function(cl){if(cl.parentNode&&!cl.parentNode.closest('.column-list')){var cols=$$(':scope > .column',cl);cl.replaceWith(M({k:'cols',cols:cols}));}});
    $$('nav.table_of_contents',el).forEach(function(n){n.replaceWith(M({k:'toc'}));});
    $$('figure.link-to-page',el).forEach(function(fg){var a=fg.querySelector('a');fg.replaceWith(M({k:'page',path:local(a&&a.getAttribute('href'),base),text:fg.textContent.trim()}));});
    $$('figure.callout',el).forEach(function(fg){var ic=fg.querySelector('.icon'),kids2=fg.children,body=kids2[kids2.length-1]||fg;fg.replaceWith(M({k:'callout',icon:ic&&!ic.querySelector('img')?ic.textContent.trim():'💡',html:body.innerHTML}));});
    $$('figure.bookmark',el).forEach(function(fg){var a=fg.querySelector('a');var tt=fg.querySelector('.bookmark-title');fg.replaceWith(M({k:'bm',url:a&&a.getAttribute('href'),title:tt&&tt.textContent.trim()}));});
    $$('img',el).forEach(function(im){if(im.closest('.page-header-icon')||im.classList.contains('icon'))return;var src=im.getAttribute('src')||'';var fg=im.closest('figure')||im;var cap=fg.querySelector&&fg.querySelector('figcaption');fg.replaceWith(M({k:'img',src:src,path:local(src,base),cap:cap?cap.innerHTML:''}));});
    $$('figure',el).forEach(function(fg){var a=fg.querySelector('a[href]');if(!a)return;var lp=local(a.getAttribute('href'),base);if(lp&&!/\.html?$/i.test(lp)&&files[lp])fg.replaceWith(M({k:'file',path:lp}));else if(lp&&/\.html?$/i.test(lp))fg.replaceWith(M({k:'page',path:lp,text:fg.textContent.trim()}));});
    // Løse links til filer i eksporten
    $$('a[href]',el).forEach(function(a){var lp=local(a.getAttribute('href'),base);if(lp&&!/\.html?$/i.test(lp)&&files[lp]&&a.parentNode&&a.parentNode.childNodes.length===1)(a.parentNode.tagName==='P'?a.parentNode:a).replaceWith(M({k:'file',path:lp}));});
    var blocks=htmlToBlocks(el.innerHTML),out=[];
    for(var bi=0;bi<blocks.length;bi++){var b=blocks[bi],m=(b.html?plain(b.html).trim():'').match(/^⟦NT(\d+)⟧$/);
      if(!m){out.push(b);continue;}
      var o=marks[+m[1]],nb=null,ind=b.indent||0;
      if(o.k==='page'){if(o.path&&ids[o.path]){nb=bl('page','');nb.pageId=ids[o.path];o.used=o.path;}else if(o.text)nb=bl('p',H(o.text));}
      else if(o.k==='toc')nb=bl('toc','');
      else if(o.k==='callout'){var h=cleanInline(String(o.html).replace(/<\/(p|div|h[1-6]|li)>/gi,'<br>')).replace(/(<br>\s*)+$/,'');nb=bl('callout',h);nb.icon=o.icon||'💡';}
      else if(o.k==='bm'){if(o.url&&/^https?:/i.test(o.url)){nb=bl('bookmark','');nb.url=o.url;if(o.title)nb.title=o.title;}}
      else if(o.k==='img'){var u=null;if(o.path&&files[o.path]){var up=await upload(o.path);u=up&&up.url;}else if(/^https?:/i.test(o.src))u=o.src;if(u){nb=bl('image','');nb.url=u;if(o.cap)nb.caption=cleanInline(o.cap);}}
      else if(o.k==='file'){var uf=await upload(o.path);if(uf){var isPdf=/pdf/.test(uf.mime);nb=bl(isPdf?'pdf':'file','');nb.url=uf.url;nb.name=uf.name;nb.size=uf.size;nb.mime=uf.mime;}}
      else if(o.k==='cols'){var cols=[];for(var ci=0;ci<o.cols.length&&ci<4;ci++)cols.push(await convert(o.cols[ci],base));if(o.cols.length>4)for(var cj=4;cj<o.cols.length;cj++)cols[3]=cols[3].concat(await convert(o.cols[cj],base));
        if(cols.length>1){nb=bl('columns','');nb.cols=cols;nb.widths=cols.map(function(){return 1/cols.length;});}else if(cols.length){cols[0].forEach(function(x){out.push(x);});}}
      if(nb){if(ind)nb.indent=ind;out.push(nb);}
    }
    return out;
  }
  for(var j=0;j<order.length;j++){var q=order[j],inf=info[q];
    prog(L('Indsætter indhold ','Adding content ')+(j+1)+'/'+total+': '+inf.title.slice(0,40),0.4+0.6*(j/total));
    var bodyEl=inf.doc.querySelector('.page-body')||inf.doc.body;
    var blocks=await convert(bodyEl,q);
    // Undersider der ikke allerede er linket i teksten (fx databaserækker) lægges nederst
    var linked={};(function w(list){list.forEach(function(x){if(x.type==='page'&&x.pageId)linked[x.pageId]=1;if(x.cols)x.cols.forEach(w);});})(blocks);
    (kids[q]||[]).forEach(function(k){if(!linked[ids[k]]){var pb=bl('page','');pb.pageId=ids[k];blocks.push(pb);}});
    if(blocks.length>3000){warn.push(L('Meget lang side forkortet: ','Very long page truncated: ')+inf.title);blocks=blocks.slice(0,3000);}
    var body={blocks:blocks};
    var cov=inf.doc.querySelector('.page-cover-image');if(cov){var cs=cov.getAttribute('src')||'',cl=local(cs,q);if(cl&&files[cl]){var cu=await upload(cl);if(cu)body.cover_url=cu.url;}else if(/^https?:/i.test(cs))body.cover_url=cs;}
    var r2=await api('/api/notes/'+ids[q],{method:'PUT',body:JSON.stringify(body)});
    if(!r2||r2.ok===false)warn.push(L('Indhold ikke gemt: ','Content not saved: ')+inf.title);
    info[q].doc=null;
  }
  // Rodsiden linker til de øverste sider
  var rb=roots.map(function(p){var pb=bl('page','');pb.pageId=ids[p];return pb;});
  await api('/api/notes/'+root.id,{method:'PUT',body:JSON.stringify({blocks:[bl('callout',L('Importeret fra Notion d. ','Imported from Notion on ')+H(stamp)+'. '+total+' '+L('sider.','pages.')),].map(function(b){b.icon='📥';return b;}).concat(rb)})});
  prog(L('Færdig','Done'),1);
  return {root:root.id,pages:total,files:nfiles,warn:warn};
}
// ── Invitér til Noter (nov. 2026) – kun admin. Inviterede får KUN adgang til
// deres egne private noter; ikke Fælles, ikke resten af portalen.
function notesOnly(){try{return !!(me&&me.role==='notes');}catch(e){return false;}}
function defScope(){return notesOnly()?'private':'shared';}
function openInvite(){
  closeDialog();
  var ov=document.createElement('div');ov.className='nt-ovl';ov.id='nt-ovl';ov.setAttribute('data-no-i18n','');
  ov.innerHTML='<div class="nt-dlg" style="max-height:86vh;width:min(560px,94vw)"><div class="nt-dlg-h"><span>👥 '+L('Invitér til Noter','Invite to Notes')+'</span><button class="nt-ib" data-x="1" style="margin-left:auto">✕</button></div>'+
   '<div style="padding:16px 20px;overflow:auto;line-height:1.5">'+
   '<p style="margin:0 0 12px;color:#6d655d;font-size:13.5px">'+L('Personen får en mail med et link til at vælge adgangskode. De kan <b>kun</b> bruge Noter med deres egne private sider – de kan ikke se Fælles-sider, kunder eller noget andet i portalen.','They get an email with a link to choose a password. They can <b>only</b> use Notes with their own private pages – no shared pages, customers or anything else in the portal.')+'</p>'+
   '<form class="nt-inv-f"><input name="n" placeholder="'+L('Navn','Name')+'" autocomplete="off" required><input name="e" type="email" placeholder="'+L('E-mail','Email')+'" autocomplete="off" required><button class="go" type="submit">'+L('Send invitation','Send invite')+'</button></form>'+
   '<div class="nt-inv-msg" style="font-size:13px;min-height:18px;margin:2px 0 12px;white-space:pre-wrap;word-break:break-all"></div>'+
   '<div class="nt-mg" style="padding:0 0 4px">'+L('Inviterede','Invited')+'</div><div class="nt-inv-l"><div class="nt-up">'+L('Henter…','Loading…')+'</div></div></div></div>';
  document.body.appendChild(ov);
  var form=$('.nt-inv-f',ov),msg=$('.nt-inv-msg',ov),list=$('.nt-inv-l',ov);
  ov.addEventListener('mousedown',function(e){if(e.target===ov||e.target.closest('[data-x]'))closeDialog();});
  function say(t,bad){msg.style.color=bad?'#9a3b2c':'#2f6b3a';msg.textContent=t;}
  function result(r,who){
    if(!r||r.ok===false){say('⚠️ '+((r&&r.error)||L('Noget gik galt','Something went wrong')),true);return;}
    if(r.mail_sent)say('✓ '+L('Invitation sendt til ','Invite sent to ')+who);
    else{say(L('Brugeren er oprettet, men mailen kunne ikke sendes','User created, but the email could not be sent')+(r.reason?' ('+r.reason+')':'')+'.\n'+L('Send dette link til personen selv (virker i 72 timer):','Send this link yourself (valid 72 hours):')+'\n'+(r.link||''),true);
      if(r.link&&navigator.clipboard)navigator.clipboard.writeText(r.link).then(function(){toast2(L('Linket er kopieret','Link copied'));},function(){});}
  }
  async function load(){
    var r=await api('/api/notes-users');
    if(!Array.isArray(r)){list.innerHTML='<div class="nt-up">'+H((r&&r.error)||L('Kunne ikke hente listen','Could not load list'))+'</div>';return;}
    list.innerHTML=r.length?r.map(function(u){
      var tag=!u.active?'<span class="nt-inv-tag off">'+L('Deaktiveret','Disabled')+'</span>':u.pending?'<span class="nt-inv-tag">'+L('Inviteret','Invited')+'</span>':'<span class="nt-inv-tag ok">'+L('Aktiv','Active')+'</span>';
      return '<div class="nt-inv-row"><div class="nm"><b>'+H(u.name)+'</b><span>'+H(u.email)+'</span></div>'+tag+
        (u.active?'<button data-iv="resend" data-id="'+u.id+'" data-e="'+H(u.email)+'">'+L('Send igen','Resend')+'</button><button data-iv="off" data-id="'+u.id+'">'+L('Fjern adgang','Remove access')+'</button>':'<button data-iv="on" data-id="'+u.id+'">'+L('Genaktivér','Reactivate')+'</button>')+'</div>';
    }).join(''):'<div class="nt-up">'+L('Du har ikke inviteret nogen endnu.','You have not invited anyone yet.')+'</div>';
  }
  form.addEventListener('submit',async function(e){e.preventDefault();var n=form.n.value.trim(),em=form.e.value.trim();if(!n||!em)return;
    var b=$('button',form);b.disabled=true;say(L('Sender…','Sending…'));
    var r=await api('/api/notes-users',{method:'POST',body:JSON.stringify({name:n,email:em})});b.disabled=false;
    result(r,em);if(r&&r.ok!==false){form.reset();load();}});
  list.addEventListener('click',async function(e){var x=e.target.closest('[data-iv]');if(!x)return;var id=x.dataset.id,k=x.dataset.iv;
    if(k==='off'&&!confirm(L('Fjern personens adgang til Noter? Deres noter bliver liggende, og du kan genaktivere dem senere.','Remove access? Their notes are kept and you can reactivate later.')))return;
    x.disabled=true;
    if(k==='resend'){var r=await api('/api/notes-users/'+id+'/resend',{method:'POST'});result(r,x.dataset.e);}
    else{var r2=await api('/api/notes-users/'+id,{method:'PUT',body:JSON.stringify({active:k==='on'})});if(r2&&r2.ok!==false)say(k==='on'?L('✓ Genaktiveret – send evt. invitationen igen','✓ Reactivated – resend the invite if needed'):L('✓ Adgang fjernet','✓ Access removed'));else say('⚠️ '+((r2&&r2.error)||''),true);}
    load();});
  setTimeout(function(){form.n.focus();},50);
  load();
}
function descendants(id){var out={};(function w(i){out[i]=1;(S.kids[i]||[]).forEach(function(c){w(c.id);});})(id);return out;}
function moveDialog(id){
  var ex=descendants(id);
  openDialog(L('Flyt siden til…','Move page to…'),function(q){
    var ql=q.toLowerCase(),roots=[{id:'r-shared',t:'👥 '+L('Fælles (øverst)','Shared (top level)')},{id:'r-private',t:'🔒 '+L('Mine private sider (øverst)','My private pages (top level)')}].filter(function(x){return !(notesOnly()&&x.id==='r-shared');}).filter(function(x){return !ql||x.t.toLowerCase().indexOf(ql)>-1;});
    return roots.map(function(x){return {key:x.id,html:x.t};}).concat(S.tree.filter(function(p){return !ex[p.id]&&(!ql||(p.title||'').toLowerCase().indexOf(ql)>-1);}).slice(0,40).map(function(p){return {key:String(p.id),html:'<span>'+H(p.icon||'📄')+'</span> '+H(p.title||L('Uden titel','Untitled'))+' <span style="margin-left:auto;color:#a69d93;font-size:12px">'+(p.scope==='private'?'🔒':'👥')+'</span>'};}));
  },async function(key){
    var body=key.indexOf('r-')===0?{parent_id:null,scope:key.slice(2)}:{parent_id:+key};
    var r=await api('/api/notes/'+id+'/move',{method:'POST',body:JSON.stringify(body)});
    if(r&&r.ok){toast(L('Siden er flyttet','Page moved'),'✅');await loadTree();if(S.page&&S.page.id===id)openPage(id);}else toast((r&&r.error)||L('Kunne ikke flytte','Could not move'),'⚠️');
  });
}
async function deletePage(id){
  var p=S.byId[id];
  var r=await api('/api/notes/'+id,{method:'DELETE'});if(!r||!r.ok)return toast(L('Kunne ikke slette','Could not delete'),'⚠️');
  toast(L('Flyttet til papirkurven','Moved to trash'),'🗑',function(){api('/api/notes/'+id+'/restore',{method:'POST'}).then(function(){loadTree();go(id);});});
  await loadTree();
  if(S.page&&(S.page.id===id||ancestors(S.page.id).indexOf(id)>-1||!S.byId[S.page.id])){var par=p&&p.parent_id&&S.byId[p.parent_id];go(par?par.id:null);}
}
async function duplicatePage(id){var r=await api('/api/notes/'+id+'/duplicate',{method:'POST'});if(r&&r.id){await loadTree();go(r.id);toast(L('Siden er duplikeret','Page duplicated'),'⧉');}}
async function toggleFav(id){var on=S.fav.indexOf(id)<0;await api('/api/notes/'+id+'/favorite',{method:'POST',body:JSON.stringify({on:on})});if(on)S.fav.push(id);else S.fav=S.fav.filter(function(x){return x!==id;});if(S.page&&S.page.id===id){S.page.favorite=on;renderTop();}renderTree();}
function treeMenu(id,anchor){
  var fav=S.fav.indexOf(id)>-1;
  var el=pop(anchor,'<button class="nt-mi" data-a="fav"><span class="nt-mi-i">'+(fav?'★':'☆')+'</span>'+(fav?L('Fjern fra favoritter','Remove from favorites'):L('Tilføj til favoritter','Add to favorites'))+'</button><button class="nt-mi" data-a="ren"><span class="nt-mi-i">✏️</span>'+L('Omdøb','Rename')+'</button><button class="nt-mi" data-a="dup"><span class="nt-mi-i">⧉</span>'+L('Duplikér','Duplicate')+'</button><button class="nt-mi" data-a="move"><span class="nt-mi-i">↪</span>'+L('Flyt til…','Move to…')+'</button><button class="nt-mi" data-a="link"><span class="nt-mi-i">🔗</span>'+L('Kopiér link','Copy link')+'</button><div class="nt-sep"></div><button class="nt-mi" data-a="del"><span class="nt-mi-i">🗑</span>'+L('Slet','Delete')+'</button>',{type:'list',cls:'small',width:230});
  hl($$('.nt-mi',el),-1);
  el.addEventListener('click',function(e){var x=e.target.closest('[data-a]');if(!x)return;closePop();var a=x.dataset.a;
    if(a==='fav')toggleFav(id);else if(a==='dup')duplicatePage(id);else if(a==='move')moveDialog(id);else if(a==='del')deletePage(id);
    else if(a==='link'){copyText(location.origin+'/admin#kb-notes/'+id);toast(L('Link kopieret','Link copied'),'🔗');}
    else if(a==='ren')renameInTree(id);});
}
function renameInTree(id){
  var row=$('.nt-ti[data-tid="'+id+'"] .nt-ti-t');if(!row)return;var p=S.byId[id];
  var inp=document.createElement('input');inp.value=p.title||'';inp.style.cssText='width:100%;border:1px solid #e3ddd4;border-radius:5px;padding:2px 6px;font:inherit;font-size:13.5px';
  row.replaceWith(inp);inp.focus();inp.select();
  var done=false;function fin(ok){if(done)return;done=true;if(ok&&inp.value!==p.title){p.title=inp.value;api('/api/notes/'+id,{method:'PUT',body:JSON.stringify({title:inp.value})});if(S.page&&S.page.id===id){S.page.title=inp.value;var t=$('.nt-title');if(t)t.textContent=inp.value;renderTop();}}renderTree();}
  inp.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Enter')fin(true);if(e.key==='Escape')fin(false);});inp.addEventListener('blur',function(){fin(true);});inp.addEventListener('click',function(e){e.stopPropagation();});
}
function pageMenu(anchor){
  var p=S.page;
  var el=pop(anchor,'<button class="nt-mi" data-a="full"><span class="nt-mi-i">↔</span>'+L('Fuld bredde','Full width')+'<span class="nt-mi-k">'+(p.full_width?'✓':'')+'</span></button>'+
   '<button class="nt-mi" data-a="fav"><span class="nt-mi-i">'+(p.favorite?'★':'☆')+'</span>'+(p.favorite?L('Fjern fra favoritter','Remove from favorites'):L('Tilføj til favoritter','Add to favorites'))+'</button>'+
   '<button class="nt-mi" data-a="link"><span class="nt-mi-i">🔗</span>'+L('Kopiér link','Copy link')+'</button>'+
   '<button class="nt-mi" data-a="dup"><span class="nt-mi-i">⧉</span>'+L('Duplikér','Duplicate')+'</button>'+
   '<button class="nt-mi" data-a="move"><span class="nt-mi-i">↪</span>'+L('Flyt til…','Move to…')+'</button>'+
   '<button class="nt-mi" data-a="scope"><span class="nt-mi-i">'+(p.scope==='private'?'👥':'🔒')+'</span>'+(p.scope==='private'?L('Del med alle (gør fælles)','Share with everyone'):L('Gør privat','Make private'))+'</button>'+
   '<div class="nt-mg">'+L('Tekststørrelse på hele siden','Text size for the page')+'</div><div class="nt-pxg">'+[13,14,15,16,17,18,20,22].map(function(n){var on=String(n)===String(p.text_size||'')||(!p.text_size&&n===15);return '<button data-ts="'+n+'" class="'+(on?'on':'')+'">'+n+'</button>';}).join('')+'</div>'+
   '<button class="nt-mi" data-a="hist"><span class="nt-mi-i">🕘</span>'+L('Sidehistorik','Page history')+'</button>'+
   '<div class="nt-sep"></div><button class="nt-mi" data-a="print"><span class="nt-mi-i">🖨</span>'+L('Udskriv / gem som PDF','Print / save as PDF')+'</button>'+
   '<button class="nt-mi" data-a="md"><span class="nt-mi-i">⬇</span>'+L('Eksportér som Markdown','Export as Markdown')+'</button>'+
   '<div class="nt-sep"></div><button class="nt-mi" data-a="del"><span class="nt-mi-i">🗑</span>'+L('Slet','Delete')+'</button>'+
   '<div class="nt-mg" style="font-weight:400;line-height:1.5">'+wordCount()+'<br>'+L('Sidst redigeret ','Last edited ')+fmtDT(p.updated_at)+'</div>',{type:'list',cls:'small',width:260});
  hl($$('.nt-mi',el),-1);
  el.addEventListener('click',function(e){var tsb=e.target.closest('[data-ts]');if(tsb){var v=tsb.dataset.ts==='15'?null:tsb.dataset.ts;p.text_size=v;var d=$('#nt-doc');FS.forEach(function(k){d.classList.remove('nt-ts-'+k);});d.style.fontSize=v?v+'px':'';markDirty({text_size:1});$$('[data-ts]',el).forEach(function(y){y.classList.toggle('on',y===tsb);});return;}
    var x=e.target.closest('[data-a]');if(!x)return;closePop();var a=x.dataset.a;
    if(a==='full'){p.full_width=!p.full_width;$('#nt-page').classList.toggle('nt-full',p.full_width);markDirty({full_width:1});}
    else if(a==='fav')toggleFav(p.id);else if(a==='dup')duplicatePage(p.id);else if(a==='move')moveDialog(p.id);else if(a==='del')deletePage(p.id);
    else if(a==='scope')switchScope();
    else if(a==='link'){copyText(location.origin+'/admin#kb-notes/'+p.id);toast(L('Link kopieret','Link copied'),'🔗');}
    else if(a==='print')printPage();else if(a==='md')exportMd();else if(a==='hist')openHistory();});
}
// ── sidehistorik: tidligere udgaver af siden kan ses og gendannes ──
var REASON={delete:['🧹','Før meget blev slettet','Before a large deletion'],'before-restore':['↩︎','Før gendannelse','Before restore'],auto:['🕘','Automatisk','Automatic']};
function histPreview(blocks){var o=[];walk(blocks||[],function(b){if(b.html!=null||b.code||b.url||b.rows)o.push(b);});
  return o.length?o.map(function(b){var h=b.html!=null?b.html:H(b.code||b.url||(b.rows?b.rows.map(function(r){return r.map(plain).join(' · ');}).join(' / '):''));var pad='padding-left:'+((b.indent||0)*22)+'px';
    var pre={bullet:'• ',num:'1. ',todo:(b.checked?'☑ ':'☐ '),toggle:'▸ ',th1:'▸ ',th2:'▸ ',th3:'▸ ',quote:'│ '}[b.type]||'';var tag=/^t?h1$/.test(b.type)?'h2':/^t?h2$/.test(b.type)?'h3':/^t?h3$/.test(b.type)?'h4':'div';
    return '<'+tag+' style="'+pad+';margin:'+(tag==='div'?'2px':'10px')+' 0">'+pre+h+'</'+tag+'>';}).join(''):'<div class="nt-dlg-e">'+L('Tom side','Empty page')+'</div>';}
async function openHistory(){
  if(!S.page)return;await save();var pid=S.page.id;closeDialog();
  var ov=document.createElement('div');ov.className='nt-ovl';ov.id='nt-ovl';ov.setAttribute('data-no-i18n','');
  ov.innerHTML='<div class="nt-dlg nt-hist"><div class="nt-dlg-h"><span>🕘 '+L('Sidehistorik','Page history')+'</span><button class="nt-ib" data-x="1">✕</button></div><div class="nt-hist-b"><div class="nt-hist-l"><div class="nt-dlg-e">'+L('Henter…','Loading…')+'</div></div><div class="nt-hist-p"><div class="nt-dlg-e">'+L('Vælg en udgave til venstre','Pick a version on the left')+'</div></div></div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('mousedown',function(e){if(e.target===ov||e.target.closest('[data-x]'))closeDialog();});
  var r=await api('/api/notes/'+pid+'/versions');var vs=(r&&r.versions)||[],l=$('.nt-hist-l',ov),pv=$('.nt-hist-p',ov);
  if(!vs.length){l.innerHTML='<div class="nt-dlg-e" style="font-size:13px">'+L('Der er ingen tidligere udgaver endnu. Siden gemmes automatisk hvert 10. minut, mens du arbejder – og altid lige før der bliver slettet meget på én gang.','No earlier versions yet. A version is kept every 10 minutes while you work – and always right before a large deletion.')+'</div>';return;}
  var cur=r.current||{};
  l.innerHTML='<div class="nt-hist-i cur"><b>'+L('Nuværende udgave','Current version')+'</b><span>'+fmtDT(cur.updated_at)+' · '+(cur.chars||0)+L(' tegn',' chars')+'</span></div>'+vs.map(function(v){var rs=REASON[v.reason]||REASON.auto;var diff=(v.chars||0)-(cur.chars||0);
    return '<button class="nt-hist-i" data-v="'+v.id+'"><b>'+rs[0]+' '+fmtDT(v.created_at)+'</b><span>'+H(L(rs[1],rs[2]))+(v.user_name?' · '+H(v.user_name):'')+'</span><span>'+(v.chars||0)+L(' tegn',' chars')+(diff>0?' <em class="plus">+'+diff+L(' i forhold til nu',' vs. now')+'</em>':'')+'</span></button>';}).join('');
  l.addEventListener('click',async function(e){var x=e.target.closest('[data-v]');if(!x)return;$$('.nt-hist-i',l).forEach(function(y){y.classList.toggle('on',y===x);});
    pv.innerHTML='<div class="nt-dlg-e">'+L('Henter…','Loading…')+'</div>';var v=await api('/api/notes/'+pid+'/versions/'+x.dataset.v);if(!v||!v.blocks){pv.innerHTML='<div class="nt-dlg-e">'+L('Kunne ikke hente','Could not load')+'</div>';return;}
    pv.innerHTML='<div class="nt-hist-bar"><span>'+fmtDT(v.created_at)+'</span><button class="nt-btn ghost" data-copy="1">'+L('Kopiér tekst','Copy text')+'</button><button class="nt-btn" data-restore="'+v.id+'">'+L('Gendan denne udgave','Restore this version')+'</button></div><div class="nt-hist-doc"><h1>'+H(v.title||'')+'</h1>'+histPreview(v.blocks)+'</div>';
    $('[data-copy]',pv).onclick=function(){var b2=clone(v.blocks);S.clip={text:blocksText(b2),blocks:b2};copyText(S.clip.text);toast2(L('Teksten er kopieret – sæt den ind hvor du vil','Copied – paste it anywhere'));};
    $('[data-restore]',pv).onclick=async function(){if(!confirm(L('Gendan denne udgave? Den nuværende udgave gemmes i historikken, så du kan fortryde.','Restore this version? The current version is kept in history.')))return;
      await save();var rr=await api('/api/notes/'+pid+'/versions/'+v.id+'/restore',{method:'POST'});if(rr&&rr.ok){closeDialog();await openPage(pid);toast2(L('Udgaven er gendannet','Version restored'));}else toast2(L('Kunne ikke gendanne','Could not restore'));};
  });
  var first=$('[data-v]',l);if(first)first.click();
}
function wordCount(){var t=pageText(1e6).replace(/^#+\s/gm,'');var w=(t.match(/\S+/g)||[]).length;return w+L(' ord · ',' words · ')+t.length+L(' tegn',' characters');}
async function switchScope(){
  var p=S.page,to=p.scope==='private'?'shared':'private';
  if(p.parent_id&&S.byId[p.parent_id]){if(!confirm(L('Siden ligger under en anden side. Den flyttes øverst i ','This page is nested. It will move to the top of ')+(to==='private'?L('Mine private sider','My private pages'):L('Fælles','Shared'))+'. OK?'))return;}
  await flush();var r=await api('/api/notes/'+p.id+'/move',{method:'POST',body:JSON.stringify({parent_id:null,scope:to})});
  if(r&&r.ok){toast(to==='private'?L('Siden er nu privat','Page is now private'):L('Siden er nu fælles for alle','Page is now shared'),to==='private'?'🔒':'👥');await loadTree();openPage(p.id);}
}

// ── søgning, papirkurv, dialog ─────────────────────────────
function openDialog(placeholder,source,pick,o){
  o=o||{};closeDialog();
  var ov=document.createElement('div');ov.className='nt-ovl';ov.id='nt-ovl';ov.setAttribute('data-no-i18n','');
  ov.innerHTML='<div class="nt-dlg">'+(o.title?'<div class="nt-dlg-h"><span>'+o.title+'</span><button class="nt-ib" data-x="1">✕</button></div>':'')+'<input class="nt-dlg-in" placeholder="'+H(placeholder)+'"><div class="nt-dlg-l"></div></div>';
  document.body.appendChild(ov);
  var inp=$('.nt-dlg-in',ov),l=$('.nt-dlg-l',ov),act=0,items=[],seq=0;
  async function r(){var my=++seq;var res=source(inp.value.trim());if(res&&res.then)res=await res;if(my!==seq)return;items=res||[];act=0;
    l.innerHTML=items.length?items.map(function(x,i){return '<button class="nt-mi'+(i===0?' act':'')+'" data-i="'+i+'">'+x.html+'</button>';}).join(''):'<div class="nt-dlg-e">'+(o.empty||L('Ingen resultater','No results'))+'</div>';}
  inp.addEventListener('input',debounce(r,140));r();
  inp.addEventListener('keydown',function(e){var b=$$('.nt-mi',l);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();act=(act+(e.key==='ArrowDown'?1:-1)+b.length)%Math.max(1,b.length);hl(b,act);}if(e.key==='Enter'&&items[act]){e.preventDefault();var it=items[act];closeDialog();pick(it.key,it);}if(e.key==='Escape')closeDialog();});
  l.addEventListener('click',function(e){var x=e.target.closest('[data-i]');if(!x)return;var it=items[+x.dataset.i];if(o.keep&&e.target.closest('[data-keep]')){pick(it.key,it,e.target.closest('[data-keep]').dataset.keep,r);return;}closeDialog();pick(it.key,it);});
  ov.addEventListener('mousedown',function(e){if(e.target===ov||e.target.closest('[data-x]'))closeDialog();});
  setTimeout(function(){inp.focus();},10);
}
function closeDialog(){var o=$('#nt-ovl');if(o)o.remove();}
function debounce(fn,ms){var t;return function(){var a=arguments;clearTimeout(t);t=setTimeout(function(){fn.apply(null,a);},ms);};}
function markQ(s,q){var t=H(s);if(!q)return t;var i=t.toLowerCase().indexOf(H(q).toLowerCase());return i<0?t:t.slice(0,i)+'<mark>'+t.slice(i,i+H(q).length)+'</mark>'+t.slice(i+H(q).length);}
function openSearch(){
  openDialog(L('Søg i alle noter…','Search all notes…'),async function(q){
    if(!q){return S.tree.slice().sort(function(a,b){return new Date(b.updated_at)-new Date(a.updated_at);}).slice(0,10).map(function(p){return {key:p.id,html:'<span style="font-size:17px">'+H(p.icon||'📄')+'</span><span>'+H(p.title||L('Uden titel','Untitled'))+'<span class="sn">'+(p.scope==='private'?'🔒 ':'👥 ')+rel(p.updated_at)+'</span></span>'};});}
    var r=await api('/api/notes/search?q='+encodeURIComponent(q))||[];
    var out=r.map(function(p){return {key:p.id,html:'<span style="font-size:17px">'+H(p.icon||'📄')+'</span><span style="min-width:0">'+markQ(p.title||L('Uden titel','Untitled'),q)+'<span class="sn">'+markQ((p.snippet||'').trim(),q)+'</span></span>'};});
    out.push({key:'new:'+q,html:'<span style="font-size:17px">＋</span><span>'+L('Opret side','Create page')+' “'+H(q)+'”</span>'});
    return out;
  },function(key){if(String(key).indexOf('new:')===0)createPage(defScope(),null,{title:String(key).slice(4)});else go(+key);},{empty:L('Ingen sider fundet','No pages found')});
}
function openTrash(){
  openDialog(L('Søg i papirkurven…','Search trash…'),async function(q){
    var r=await api('/api/notes/trash')||[],ql=q.toLowerCase();
    return r.filter(function(p){return !ql||(p.title||'').toLowerCase().indexOf(ql)>-1;}).map(function(p){return {key:p.id,html:'<span style="font-size:17px">'+H(p.icon||'📄')+'</span><span style="flex:1;min-width:0">'+H(p.title||L('Uden titel','Untitled'))+'<span class="sn">'+(p.scope==='private'?'🔒 ':'👥 ')+L('Slettet ','Deleted ')+rel(p.deleted_at)+'</span></span><span class="nt-ib" data-keep="restore" title="'+L('Gendan','Restore')+'">↩︎</span><span class="nt-ib" data-keep="kill" title="'+L('Slet permanent','Delete forever')+'">🗑</span>'};});
  },async function(key,it,action,refresh){
    if(action==='kill'){if(!confirm(L('Slet siden permanent? Det kan ikke fortrydes.','Delete this page forever? This cannot be undone.')))return;await api('/api/notes/'+key+'/permanent',{method:'DELETE'});refresh();return;}
    await api('/api/notes/'+key+'/restore',{method:'POST'});await loadTree();closeDialog();go(+key);toast(L('Siden er gendannet','Page restored'),'↩︎');
  },{title:'🗑 '+L('Papirkurv','Trash'),keep:true,empty:L('Papirkurven er tom','Trash is empty')});
}

// ── kommentarer ─────────────────────────────────────────────
function closeComments(){var c=$('#nt-cm');if(c)c.remove();S.cmOpen=false;}
async function openComments(prefill){
  if(!S.page)return;S.cmOpen=true;
  var c=$('#nt-cm');if(!c){c=document.createElement('div');c.className='nt-cm';c.id='nt-cm';$('.nt-main').appendChild(c);}
  c.innerHTML='<div class="nt-cm-h"><span>💬 '+L('Kommentarer','Comments')+'</span><button class="nt-ib" data-act="cm-close">✕</button></div><div class="nt-cm-l"><div class="nt-up">'+L('Henter…','Loading…')+'</div></div><div class="nt-cm-f"><textarea placeholder="'+L('Skriv en kommentar… (Enter sender)','Write a comment… (Enter to send)')+'"></textarea><div style="display:flex;justify-content:flex-end;margin-top:6px"><button class="nt-btn" data-act="cm-send">'+L('Send','Send')+'</button></div></div>';
  var ta=$('textarea',c);if(prefill){ta.value=prefill;}setTimeout(function(){ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);},20);
  ta.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendComment();}});
  loadComments();
}
async function loadComments(){
  var c=$('#nt-cm');if(!c||!S.page)return;var r=await api('/api/notes/'+S.page.id+'/comments')||[];
  var open=r.filter(function(x){return !x.resolved;}).length;S.page.comment_count=open;renderTop();
  $('.nt-cm-l',c).innerHTML=r.length?r.map(function(x){return '<div class="nt-cmi'+(x.resolved?' res':'')+'"><div class="nt-cmi-h"><span class="nt-av" style="background:'+H(x.color||'#4F46E5')+'">'+H(x.initials||(x.user_name||'?').slice(0,2))+'</span><b>'+H(x.user_name||'')+'</b>'+rel(x.created_at)+'</div><div class="nt-cmi-b">'+H(x.body)+'</div><div class="nt-cmi-a"><button data-act="cm-res" data-cid="'+x.id+'" data-r="'+(x.resolved?0:1)+'">'+(x.resolved?L('Genåbn','Reopen'):'✓ '+L('Løst','Resolve'))+'</button>'+(me&&(+x.user_id===+me.id||me.role==='admin')?'<button data-act="cm-del" data-cid="'+x.id+'">'+L('Slet','Delete')+'</button>':'')+'</div></div>';}).join(''):'<div class="nt-up">'+L('Ingen kommentarer endnu. Skriv den første nedenfor – ejeren af siden får besked.','No comments yet. Write the first one below – the page owner is notified.')+'</div>';
}
async function sendComment(){var c=$('#nt-cm'),ta=$('textarea',c),v=ta.value.trim();if(!v)return;ta.value='';await api('/api/notes/'+S.page.id+'/comments',{method:'POST',body:JSON.stringify({body:v})});loadComments();}

// ── eksport ─────────────────────────────────────────────────
function printPage(){
  var p=S.page,doc=$('#nt-doc').cloneNode(true);
  $$('.nt-hdl,.nt-mtools,.nt-tadd,.nt-tbar,.nt-code-bar,.nt-tempty,.nt-hide',doc).forEach(function(e){e.remove();});
  $$('[contenteditable]',doc).forEach(function(e){e.removeAttribute('contenteditable');});
  $$('textarea',doc).forEach(function(t){var pre=document.createElement('pre');pre.className='nt-code-txt';pre.textContent=$('.nt-b[data-id="'+t.closest('.nt-b').dataset.id+'"] textarea').value;t.replaceWith(pre);});
  $$('input[type=checkbox]',doc).forEach(function(c){var o=$('.nt-b[data-id="'+c.closest('.nt-b').dataset.id+'"] input[type=checkbox]');if(o&&o.checked)c.setAttribute('checked','');});
  $$('.nt-rem input,.nt-rem select',doc).forEach(function(x){var s=document.createElement('span');s.textContent=x.tagName==='SELECT'?(x.options[x.selectedIndex]||{}).text||'':fmtDT(x.value);x.replaceWith(s);});
  var w=window.open('','_blank');if(!w)return toast(L('Tillad pop-up-vinduer for at udskrive','Allow pop-ups to print'),'⚠️');
  w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>'+H(p.title||'Note')+'</title><style>'+CSS+'\nbody{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#2b2622;-webkit-print-color-adjust:exact;print-color-adjust:exact}.nt-page{padding:0 40px 40px;max-width:820px}.nt-cover{margin:0 -40px;height:200px}.nt-hbtns,.nt-cover-btns{display:none!important}@media print{.nt-pdf iframe,.nt-emb iframe{display:none}}</style></head><body><div class="nt-app" style="display:block;height:auto;border:0;overflow:visible"><div class="nt-page'+(p.full_width?' nt-full':'')+'">'+
    (p.cover_url?'<div class="nt-cover" style="'+coverCss(p.cover_url,p.cover_pos)+'"></div>':'')+'<div class="nt-head'+(p.cover_url?' has-cover':'')+'" style="padding-top:'+(p.cover_url?'0':'30px')+'">'+(p.icon?'<div class="nt-icon" style="display:inline-block">'+H(p.icon)+'</div>':'')+'<h1 class="nt-title">'+H(p.title||'')+'</h1></div><div class="nt-doc">'+doc.innerHTML+'</div></div></div></body></html>');
  w.document.close();setTimeout(function(){w.focus();w.print();},500);
}
function htmlToMd(h){
  var d=document.createElement('div');d.innerHTML=h||'';
  (function w(n){$$('b,strong',n).forEach(function(e){e.replaceWith('**'+e.textContent+'**');});$$('i,em',n).forEach(function(e){e.replaceWith('*'+e.textContent+'*');});$$('s,strike,del',n).forEach(function(e){e.replaceWith('~~'+e.textContent+'~~');});$$('code',n).forEach(function(e){e.replaceWith('`'+e.textContent+'`');});$$('a',n).forEach(function(e){var hr=e.getAttribute('href')||'';e.replaceWith('['+e.textContent+']('+(hr[0]==='#'?location.origin+'/admin'+hr:hr)+')');});$$('br',n).forEach(function(e){e.replaceWith('\n');});})(d);
  return d.textContent;
}
function exportMd(){
  var p=S.page,lines=['# '+(p.icon?p.icon+' ':'')+(p.title||'Note'),''];
  (function out(list){var num={};list.forEach(function(b){var ind='  '.repeat(b.indent||0),t=htmlToMd(b.html),i=b.indent||0;if(b.type==='num')num[i]=(num[i]||0)+1;else delete num[i];
    var L2={p:t,h1:'# '+t,h2:'## '+t,h3:'### '+t,th1:'# '+t,th2:'## '+t,th3:'### '+t,bullet:'- '+t,num:(num[i]||1)+'. '+t,todo:'- ['+(b.checked?'x':' ')+'] '+t,toggle:'- '+t,quote:'> '+t,callout:'> '+(b.icon||'💡')+' '+t,remind:'🔔 '+t+' ('+fmtDT(b.at)+')',divider:'---',code:'```\n'+(b.code||'')+'\n```',image:'!['+plain(b.caption)+']('+abs(b.url)+')',video:'['+L('Video','Video')+']('+abs(b.url)+')',audio:'['+(b.name||'Audio')+']('+abs(b.url)+')',file:'['+(b.name||'Fil')+']('+abs(b.url)+')',pdf:'['+(b.name||'PDF')+']('+abs(b.url)+')',bookmark:'['+(b.title||b.url)+']('+b.url+')',embed:'['+(b.url||'')+']('+b.url+')',page:'['+((S.byId[b.pageId]||{}).title||'Side')+']('+location.origin+'/admin#kb-notes/'+b.pageId+')',toc:''}[b.type];
    if(b.type==='table'&&b.rows){var rows=b.rows.map(function(r){return '| '+r.map(function(c){return htmlToMd(c).replace(/\|/g,'\\|');}).join(' | ')+' |';});rows.splice(1,0,'|'+b.rows[0].map(function(){return ' --- ';}).join('|')+'|');L2=rows.join('\n');}
    if(b.type==='columns'){(b.cols||[]).forEach(out);return;}
    if(b.type==='tabs'){(b.cols||[]).forEach(function(c,i){lines.push('**'+((b.titles||[])[i]||'')+'**','');out(c);lines.push('');});return;}
    if(L2!=null&&L2!=='')lines.push(ind+L2.split('\n').join('\n'+ind));if(/^h|^th|divider|code|table|image/.test(b.type))lines.push('');});})(p.blocks);
  var blob=new Blob([lines.join('\n')],{type:'text/markdown'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=(p.title||'note').replace(/[\\\/:*?"<>|]/g,'-')+'.md';a.click();setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
}
function abs(u){return u&&u[0]==='/'?location.origin+u:(u||'');}

// ── træk og slip (blokke) ──────────────────────────────────
var dropLine=null;
function showDrop(rect,vertical){
  var sc=$('#nt-scroll');if(!dropLine){dropLine=document.createElement('div');dropLine.className='nt-dropline';sc.appendChild(dropLine);}
  var sr=sc.getBoundingClientRect();dropLine.classList.toggle('v',!!vertical);
  if(vertical){dropLine.style.left=(rect.right-sr.left+sc.scrollLeft-2)+'px';dropLine.style.top=(rect.top-sr.top+sc.scrollTop)+'px';dropLine.style.height=rect.height+'px';dropLine.style.width='';}
  else{dropLine.style.left=(rect.left-sr.left)+'px';dropLine.style.width=rect.width+'px';dropLine.style.top=(rect.y-sr.top+sc.scrollTop-1)+'px';dropLine.style.height='';}
}
function hideDrop(){if(dropLine){dropLine.remove();dropLine=null;}}
function dropTarget(e){
  var tab=e.target.closest&&e.target.closest('.nt-tab');
  if(tab&&S.drag){var tbe=tab.closest('.nt-b');if(tbe.dataset.id!==S.drag&&!$('.nt-b[data-id="'+S.drag+'"]').contains(tbe))return {el:tbe,zone:'tab',ti:+tab.dataset.ti,tabEl:tab};return null;}
  var t=e.target.closest&&e.target.closest('.nt-b');var d=$('#nt-doc');
  if(!t){var bs=$$(':scope > .nt-b:not(.nt-hide)',d);if(!bs.length)return null;var last=bs[bs.length-1];var lr=last.getBoundingClientRect();if(e.clientY>lr.bottom)return {el:last,zone:'after'};var first=bs[0];if(e.clientY<first.getBoundingClientRect().top)return {el:first,zone:'before'};return null;}
  // en kolonne-blok som helhed: brug blokken under markøren inde i kolonnen
  if(S.drag&&(t.dataset.id===S.drag||t.closest('.nt-b[data-id="'+S.drag+'"]')))return null;
  var r=t.getBoundingClientRect(),inCol=!!t.parentElement.closest('.nt-col');
  if(t.classList.contains('nt-t-columns'))return {el:t,zone:e.clientY<r.top+r.height/2?'before':'after'};
  if(e.clientX>r.right-Math.min(90,r.width*0.18))return {el:t,zone:'right',inCol:inCol};
  if(e.clientX<r.left+30&&!inCol&&$('.nt-b[data-id="'+S.drag+'"]')&&!$('.nt-b[data-id="'+S.drag+'"]').classList.contains('nt-t-columns'))return {el:t,zone:'left'};
  return {el:t,zone:e.clientY<r.top+r.height/2?'before':'after'};
}
function doDrop(dragId,tg){
  var tid=tg.el.dataset.id;if(tid===dragId)return;
  op(function(){
    var src=find(dragId);if(!src)return;
    var end=groupEnd(src.list,src.i),g=src.list.splice(src.i,end-src.i),srcOwner=src.owner;
    var t=find(tid);if(!t){src.list.splice.apply(src.list,[src.i,0].concat(g));return;}
    var hasCols=g.some(function(x){return x.type==='columns'||x.type==='tabs';});
    if(tg.zone==='tab'){if(hasCols){src.list.splice.apply(src.list,[Math.min(src.i,src.list.length),0].concat(g));return;}g.forEach(function(x){x.indent=Math.max(0,(x.indent||0)-(g[0].indent||0));});var dst=t.b.cols[tg.ti];if(dst.length===1&&isTxt(dst[0].type)&&!plain(dst[0].html).trim())dst.length=0;dst.push.apply(dst,g);t.b.active=tg.ti;if(srcOwner&&!src.list.length)cleanupCols(srcOwner);return;}
    if(hasCols&&t.owner){t=find(t.owner.id);tg.zone=tg.zone==='before'?'before':'after';}
    var base=t.b.indent||0,delta=base-(g[0].indent||0);
    if(tg.zone==='right'||tg.zone==='left'){
      g.forEach(function(x){x.indent=Math.max(0,(x.indent||0)-(g[0].indent||0));});
      if(t.owner&&t.owner.type==='columns'){var oc=t.owner.cols;if(oc.length<4){oc.splice(t.col+(tg.zone==='right'?1:0),0,g);delete t.owner.widths;}else t.list.splice.apply(t.list,[t.i+1,0].concat(g));}
      else{var tend=groupEnd(t.list,t.i),tg2=t.list.splice(t.i,tend-t.i);tg2.forEach(function(x){x.indent=Math.max(0,(x.indent||0)-base);});var cb=bl('columns','');cb.cols=tg.zone==='right'?[tg2,g]:[g,tg2];t.list.splice(t.i,0,cb);}
    }else{
      g.forEach(function(x){x.indent=Math.max(0,(x.indent||0)+delta);});
      var at=tg.zone==='before'?t.i:groupEnd(t.list,t.i);
      if(tg.zone==='after'&&isTog(t.b.type)&&t.b.open&&groupEnd(t.list,t.i)===t.i+1){g.forEach(function(x){x.indent=(x.indent||0)+1;});at=t.i+1;}
      t.list.splice.apply(t.list,[at,0].concat(g));
    }
    if(srcOwner&&!src.list.length)cleanupCols(srcOwner);
  });
  renderDoc();
}

// ── hændelser ───────────────────────────────────────────────
function bindApp(app){
  app.addEventListener('click',onClick);
  app.addEventListener('input',onInput);
  app.addEventListener('keydown',onKeydown);
  app.addEventListener('paste',onPaste);
  app.addEventListener('change',onChange);
  app.addEventListener('focusin',function(e){if(S.applying||!e.target.closest('.nt-doc'))return;if(e.target.classList.contains('nt-cell')){var cb=e.target.closest('.nt-b');S.cell={id:cb.dataset.id,r:+e.target.dataset.r,c:+e.target.dataset.c};}if(S.sel.length&&!e.target.closest('.nt-selb'))selectBlocks([]);});
  app.addEventListener('mousedown',function(e){if(e.target.closest('[data-keep]'))e.preventDefault();
    if(e.button!==0)return;
    var inScroll=e.target.closest('#nt-scroll'),be=e.target.closest('#nt-doc .nt-b');
    // Shift-klik: vælg alt fra den aktive/valgte blok til denne
    if(e.shiftKey&&be&&S.page){var anc=null,ae0=document.activeElement;
      if(S.xsel)anc={id:S.xsel.a,o:S.xsel.ao};
      else if(ae0&&ae0.classList&&ae0.classList.contains('nt-txt')&&ae0.closest('#nt-doc')){var sl0=getSelection(),o0=caretOffset(ae0);if(sl0.anchorNode&&ae0.contains(sl0.anchorNode)){var pr0=document.createRange();pr0.selectNodeContents(ae0);pr0.setEnd(sl0.anchorNode,sl0.anchorOffset);o0=pr0.toString().length;}anc={id:ae0.closest('.nt-b').dataset.id,o:o0};}
      else if(S.sel.length)anc={id:S.sel[0],o:0};
      var leaf=leafAt(e.clientX,e.clientY);
      if(anc&&leaf&&anc.id!==leaf.dataset.id){e.preventDefault();startX(anc.id,anc.o,leaf.dataset.id,offIn(leaf,e.clientX,e.clientY));return;}}
    if(S.sel.length&&!e.target.closest('.nt-grip')&&!e.target.closest('.nt-pop'))selectBlocks([]);
    if(!inScroll||!S.page)return;
    var ed=e.target.closest('#nt-doc .nt-txt,#nt-doc .nt-cell,#nt-doc .nt-cap');
    var blocked=e.target.closest('button,a,input,select,textarea,iframe,img,video,audio,.nt-tab,.nt-hdl,.nt-head,.nt-cover,.nt-tbar,.nt-tadd,.nt-colrs,.nt-subs,.nt-tpl,[contenteditable="true"]');
    if(ed){var sb=ed.closest('.nt-b');S.msel={mode:'text',start:sb.dataset.id,ao:ed.classList.contains('nt-txt')?offAtPoint(ed,e.clientX,e.clientY):0,x:e.clientX,y:e.clientY,on:false};}
    else if(!blocked){S.msel={mode:'box',x:e.clientX,y:e.clientY,on:false};}
  });
  // titel
  app.addEventListener('input',function(e){if(!e.target.classList.contains('nt-title'))return;var v=e.target.textContent.replace(/\n/g,' ');S.page.title=v;if(S.byId[S.page.id])S.byId[S.page.id].title=v;markDirty({title:1});
    $$('.nt-ti[data-tid="'+S.page.id+'"] .nt-ti-t').forEach(function(x){x.textContent=v||L('Uden titel','Untitled');});var cr=$('#nt-crumbs');if(cr)cr.innerHTML=crumbsHtml();setAppTitleSafe((S.page.icon?S.page.icon+' ':'')+(v||L('Uden titel','Untitled')));});
  // træk/slip: blokke
  app.addEventListener('dragstart',function(e){
    var g=e.target.closest&&e.target.closest('.nt-grip');
    if(g){var be=g.closest('.nt-b');S.drag=be.dataset.id;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain','');e.dataTransfer.setDragImage(be,10,10);}catch(x){}setTimeout(function(){be.classList.add('nt-dragging');},0);closePop();return;}
    var ti=e.target.closest&&e.target.closest('.nt-ti');if(ti){S.tdrag=+ti.dataset.tid;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain','');}catch(x){}}
  });
  app.addEventListener('dragover',function(e){
    if(!e.target.closest)return;
    if(S.drag||(!S.tdrag&&e.dataTransfer&&Array.prototype.indexOf.call(e.dataTransfer.types||[],'Files')>-1)){
      if(!e.target.closest('#nt-scroll'))return;e.preventDefault();var tg=dropTarget(e);$$('.nt-tab-dz').forEach(function(x){x.classList.remove('nt-tab-dz');});if(!tg){hideDrop();return;}
      if(tg.zone==='tab'){hideDrop();tg.tabEl.classList.add('nt-tab-dz');S.dropTg=tg;return;}var r=tg.el.getBoundingClientRect(),bc=$('.nt-bc',tg.el)||tg.el,br=bc.getBoundingClientRect();
      if(tg.zone==='right'||tg.zone==='left')showDrop({right:tg.zone==='right'?br.right:br.left-4,top:br.top,height:br.height},true);else showDrop({left:br.left,width:br.width,y:tg.zone==='before'?r.top:r.bottom});S.dropTg=tg;return;}
    if(S.tdrag){var ti=e.target.closest('.nt-ti'),sh=e.target.closest('[data-drop]');$$('.nt-dz-in,.nt-dz-top,.nt-dz-bot,.nt-dropin').forEach(function(x){x.classList.remove('nt-dz-in','nt-dz-top','nt-dz-bot','nt-dropin');});
      if(sh){e.preventDefault();sh.classList.add('nt-dropin');S.tdz={scope:sh.dataset.drop};return;}
      if(!ti||+ti.dataset.tid===S.tdrag||descendants(S.tdrag)[+ti.dataset.tid]){S.tdz=null;return;}
      e.preventDefault();var rr=ti.getBoundingClientRect(),y=e.clientY-rr.top,z=y<rr.height*0.28?'top':y>rr.height*0.72?'bot':'in';ti.classList.add('nt-dz-'+z);S.tdz={id:+ti.dataset.tid,z:z};}
  });
  app.addEventListener('dragleave',function(e){if(!e.relatedTarget||!app.contains(e.relatedTarget))hideDrop();});
  app.addEventListener('drop',async function(e){
    if(!e.target.closest)return;
    if(S.drag){e.preventDefault();var id=S.drag,tg=S.dropTg;endDrag();if(tg)doDrop(id,tg);return;}
    if(S.tdrag){e.preventDefault();var src=S.tdrag,z=S.tdz;endDrag();if(!z)return;var body;
      if(z.scope)body={parent_id:null,scope:z.scope};
      else if(z.z==='in')body={parent_id:z.id};
      else{var tp=S.byId[z.id],sib=(S.kids[tp.parent_id&&S.byId[tp.parent_id]?tp.parent_id:'r-'+tp.scope]||[]).filter(function(x){return x.id!==src;}),ix=sib.indexOf(tp),nb=z.z==='top'?sib[ix-1]:sib[ix+1];
        var pos=nb?(Number(tp.position)+Number(nb.position))/2:Number(tp.position)+(z.z==='top'?-1:1);body={parent_id:tp.parent_id&&S.byId[tp.parent_id]?tp.parent_id:null,scope:tp.scope,position:pos};}
      if(body.parent_id)setExp(String(body.parent_id),true);
      var r=await api('/api/notes/'+src+'/move',{method:'POST',body:JSON.stringify(body)});if(r&&r.ok){await loadTree();if(S.page&&S.page.id===src)openPage(src);}else toast((r&&r.error)||L('Kunne ikke flytte','Could not move'),'⚠️');return;}
    if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length&&S.page&&e.target.closest('#nt-scroll')){e.preventDefault();var tg2=dropTarget(e);hideDrop();uploadFiles(Array.prototype.slice.call(e.dataTransfer.files),tg2?tg2.el.dataset.id:null);}
  });
  app.addEventListener('dragend',endDrag);
  // kolonnebredde
  app.addEventListener('mousedown',function(e){var rs=e.target.closest&&e.target.closest('.nt-colrs');if(rs&&e.button===0)colResize(e,rs);});
  app.addEventListener('dblclick',function(e){var rs=e.target.closest&&e.target.closest('.nt-colrs');if(!rs)return;var f=find(rs.closest('.nt-b').dataset.id);if(f){op(function(){delete f.b.widths;});renderDoc();}});
  // cover-placering
  app.addEventListener('mousedown',function(e){var c=e.target.closest('.nt-cover.nt-repos');if(!c||e.target.closest('button'))return;e.preventDefault();var y0=e.clientY,p0=S.page.cover_pos==null?50:S.page.cover_pos,h=c.offsetHeight;
    function mv(ev){var p=Math.max(0,Math.min(100,p0-(ev.clientY-y0)/h*100));S.page.cover_pos=Math.round(p);c.style.backgroundPosition='center '+S.page.cover_pos+'%';}
    function up(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);});
  var sc=$('#nt-scroll');sc.addEventListener('scroll',function(){hideStb();posSelBar();if(S.menu&&S.menu.type!=='pop')closePop();},{passive:true});
}
function mselMove(e){
  var m=S.msel;if(!m)return;
  if(!m.on&&Math.abs(e.clientX-m.x)+Math.abs(e.clientY-m.y)<6)return;
  if(m.mode==='text'){
    var be=leafAt(e.clientX,e.clientY);if(!be)return;var fo=offIn(be,e.clientX,e.clientY);
    if(be.dataset.id===m.start){
      if(m.on){ // tilbage i startblokken → almindelig tekstmarkering igen
        m.on=false;S.xsel=null;clearHL();S.sel=[];selBar();document.body.classList.remove('nt-noselect');
        var st=txtOf($('.nt-b[data-id="'+m.start+'"]'));if(st){st.focus();var p1=pointAt(st,m.ao),p2=pointAt(st,fo);getSelection().setBaseAndExtent(p1[0],p1[1],p2[0],p2[1]);}}
      return;}
    if(!m.on){m.on=true;document.body.classList.add('nt-noselect');var ae=document.activeElement;if(ae&&ae.blur&&ae.closest&&ae.closest('#nt-doc'))ae.blur();}
    getSelection().removeAllRanges();S.xsel={a:m.start,ao:m.ao,f:be.dataset.id,fo:fo};paintX();
    var sc0=$('#nt-scroll'),sr0=sc0.getBoundingClientRect();if(e.clientY>sr0.bottom-30)sc0.scrollTop+=14;else if(e.clientY<sr0.top+30)sc0.scrollTop-=14;
    return;
  }
  if(!m.on){m.on=true;document.body.classList.add('nt-noselect');m.box=document.createElement('div');m.box.className='nt-marq';document.body.appendChild(m.box);}
  var x1=Math.min(m.x,e.clientX),y1=Math.min(m.y,e.clientY),x2=Math.max(m.x,e.clientX),y2=Math.max(m.y,e.clientY);
  m.box.style.cssText='left:'+x1+'px;top:'+y1+'px;width:'+(x2-x1)+'px;height:'+(y2-y1)+'px';
  var ids=leafEls().filter(function(el){var r=el.getBoundingClientRect();return r.bottom>y1&&r.top<y2&&r.right>x1&&r.left<x2;}).map(function(el){return el.dataset.id;});
  var key=ids.join(',');if(key!==m.last){m.last=key;selectBlocks(ids);}
  var sc=$('#nt-scroll'),sr=sc.getBoundingClientRect();if(e.clientY>sr.bottom-30)sc.scrollTop+=12;else if(e.clientY<sr.top+30)sc.scrollTop-=12;
}
function mselEnd(){var m=S.msel;S.msel=null;if(!m)return;document.body.classList.remove('nt-noselect');if(m.box)m.box.remove();if(m.on){S.suppressClick=true;setTimeout(function(){S.suppressClick=false;},0);selBar();}}
document.addEventListener('mousemove',function(e){if(S.msel)mselMove(e);});
document.addEventListener('mouseup',mselEnd);
function endDrag(){$$('.nt-tab-dz').forEach(function(x){x.classList.remove('nt-tab-dz');});if(S.drag){var be=$('.nt-b[data-id="'+S.drag+'"]');if(be)be.classList.remove('nt-dragging');}S.drag=null;S.tdrag=null;S.tdz=null;S.dropTg=null;hideDrop();$$('.nt-dz-in,.nt-dz-top,.nt-dz-bot,.nt-dropin').forEach(function(x){x.classList.remove('nt-dz-in','nt-dz-top','nt-dz-bot','nt-dropin');});}

function onClick(e){
  if(S.suppressClick){S.suppressClick=false;return;}
  var a=e.target.closest('[data-act]'),app=$('#nt-app');
  // links i teksten
  var link=e.target.closest('.nt-txt a,.nt-cell a,.nt-cap a');
  if(link&&!a){e.preventDefault();var href=link.getAttribute('href')||'';
    if(link.dataset.page){go(+link.dataset.page);return;}
    if(e.metaKey||e.ctrlKey){if(href[0]==='#')location.hash=href.slice(1);else window.open(href,'_blank','noopener');return;}
    linkPop(link);return;}
  var chip=e.target.closest('.nt-date');if(chip&&!a){var ed=chip.closest('.nt-txt');datePop(chip.getBoundingClientRect(),new Date(chip.dataset.date+'T12:00'),function(d){chip.outerHTML=dateChip(d);syncEditable(ed);});return;}
  if(!a){
    // klik under sidste blok / i tom side
    return;}
  var act=a.dataset.act,be=a.closest('.nt-b'),id=be&&be.dataset.id,f=id&&S.page?find(id):null;
  switch(act){
    case 'side-off':app.classList.add('nt-side-off');app.classList.remove('nt-side-on');try{localStorage.setItem('nt_side','off');}catch(x){}return;
    case 'side-on':if(innerWidth<860)app.classList.toggle('nt-side-on');else{app.classList.remove('nt-side-off');try{localStorage.setItem('nt_side','on');}catch(x){}}return;
    case 'side-close':app.classList.remove('nt-side-on');return;
    case 'search':openSearch();return;
    case 'home':go(null);return;
    case 'trash':openTrash();return;
    case 'notion-import':openNotionImport();return;
    case 'new':e.preventDefault();createPage(a.dataset.scope);return;
    case 'open':e.preventDefault();var pid=+a.dataset.pid;if(pid&&S.byId[pid])go(pid);else if(pid)toast(L('Siden findes ikke længere','This page no longer exists'),'⚠️');return;
    case 'team-tg':setExp('u'+a.dataset.uid,!S.exp['u'+a.dataset.uid]);renderTree();return;
    case 'tex':e.stopPropagation();var ti=a.closest('.nt-ti'),k=ti.dataset.ctx+ti.dataset.tid;setExp(k,!S.exp[k]);renderTree();return;
    case 'tadd':e.stopPropagation();var t2=a.closest('.nt-ti'),pp=S.byId[t2.dataset.tid];createPage(pp.scope,pp.id);return;
    case 'tmenu':e.stopPropagation();treeMenu(+a.closest('.nt-ti').dataset.tid,a.getBoundingClientRect());return;
    case 'fav':toggleFav(S.page.id);return;
    case 'pmenu':pageMenu(a.getBoundingClientRect());return;
    case 'comments':if(S.cmOpen)closeComments();else openComments();return;
    case 'cm-close':closeComments();return;
    case 'cm-send':sendComment();return;
    case 'cm-res':api('/api/notes/comments/'+a.dataset.cid,{method:'PUT',body:JSON.stringify({resolved:a.dataset.r==='1'})}).then(loadComments);return;
    case 'cm-del':api('/api/notes/comments/'+a.dataset.cid,{method:'DELETE'}).then(loadComments);return;
    case 'scope':if(!notesOnly())switchScope();return;
    case 'invite':openInvite();return;
    case 'icon':emojiPicker(a.getBoundingClientRect(),function(em){S.page.icon=em;if(S.byId[S.page.id])S.byId[S.page.id].icon=em;markDirty({icon:1});renderPage();renderTree();},{remove:!!S.page.icon});return;
    case 'coveradd':setCover('gradient:'+Object.keys(GRADS)[Math.floor(Math.random()*8)]);return;
    case 'cover':coverPicker(a.getBoundingClientRect());return;
    case 'coverrm':S.page.cover_url=null;markDirty({cover_url:1});renderPage();return;
    case 'coverpos':var cv=$('#nt-cover');if(cv.classList.contains('nt-repos')){cv.classList.remove('nt-repos');var hi=$('.nt-cover-hint',cv);if(hi)hi.remove();markDirty({cover_pos:1});renderPage();}else{cv.classList.add('nt-repos');a.textContent=L('Gem placering','Save position');cv.insertAdjacentHTML('beforeend','<div class="nt-cover-hint">'+L('Træk billedet op eller ned','Drag image to reposition')+'</div>');}return;
    case 'conf-reload':$('#nt-conf').innerHTML='';S.pending={};openPage(S.page.id);return;
    case 'conf-force':$('#nt-conf').innerHTML='';save(true);return;
    case 'tpl':var tp=TEMPLATES.find(function(x){return x.k===a.dataset.k;});
      if(a.dataset.k==='ai'){renderTemplates(false);aiBlock(S.page.blocks[0],'ai');return;}
      op(function(){S.page.blocks=tp.blocks();if(!S.page.icon){S.page.icon=tp.icon;markDirty({icon:1});if(S.byId[S.page.id])S.byId[S.page.id].icon=tp.icon;}if(!S.page.title){S.page.title=tp.t;markDirty({title:1});if(S.byId[S.page.id])S.byId[S.page.id].title=tp.t;}});
      renderPage();renderTree();var fe=editables()[0];if(fe)setCaret(fe,'end');return;
    case 'tail':var lst=S.page.blocks[S.page.blocks.length-1];
      if(lst&&isTxt(lst.type)&&!plain(lst.html).trim()&&!(lst.indent)){focusBlock(lst.id,'end');return;}
      op(function(){S.page.blocks.push(newBlock('p'));});renderDoc({id:S.page.blocks[S.page.blocks.length-1].id,pos:0});renderTemplates(false);return;
    // blokke
    case 'addb':if(!f)return;var nb=bl('p','');nb.indent=f.b.indent||0;op(function(){insertAfter(id,nb,true);});renderDoc({id:nb.id,pos:0});
      setTimeout(function(){insertTextAtCaret('/');var el=$('.nt-b[data-id="'+nb.id+'"] .nt-txt');checkTriggers(el,nb);},10);return;
    case 'bmenu':if(!f)return;blockMenu(id,null,a.getBoundingClientRect());return;
    case 'check':if(!f)return;op(function(){f.b.checked=a.checked;});be.classList.toggle('nt-done',a.checked);return;
    case 'toggle':if(!f)return;f.b.open=!f.b.open;changed();rerenderKeep();return;
    case 'tchild':if(!f)return;var cb=bl('p','');cb.indent=(f.b.indent||0)+1;op(function(){f.list.splice(f.i+1,0,cb);});renderDoc({id:cb.id,pos:0});return;
    case 'cicon':if(!f)return;emojiPicker(a.getBoundingClientRect(),function(em){op(function(){f.b.icon=em||'💡';});rerenderKeep();});return;
    case 'media':if(!f)return;mediaPop(id);return;
    case 'zoom':var lb=document.createElement('div');lb.className='nt-lb';lb.innerHTML='<img src="'+H(a.getAttribute('src'))+'">';lb.onclick=function(){lb.remove();};document.body.appendChild(lb);return;
    case 'tocgo':revealBlock(a.dataset.to);var tb=$('.nt-b[data-id="'+a.dataset.to+'"]');if(tb){tb.scrollIntoView({block:'start',behavior:'smooth'});tb.classList.remove('nt-flash');void tb.offsetWidth;tb.classList.add('nt-flash');}return;
    case 'ccopy':if(f){copyText(f.b.code||'');a.textContent=L('Kopieret ✓','Copied ✓');setTimeout(function(){a.textContent=L('Kopiér','Copy');},1500);}return;
    case 'selb':if(f)selectBlocks([id]);return;
    case 'tab':if(!f)return;var ti=+a.dataset.ti;if(ti!==(f.b.active||0)){f.b.active=ti;changed();renderDoc();}return;
    case 'tabadd':if(!f)return;op(function(){f.b.cols.push([bl('p','')]);f.b.titles.push(L('Fane ','Tab ')+f.b.cols.length);f.b.active=f.b.cols.length-1;});renderDoc();editTabTitle(id,f.b.active);return;
    case 'tabmenu':e.stopPropagation();if(f)tabMenu(id,+a.dataset.ti,a.getBoundingClientRect());return;
  }
  if(act.indexOf('w:')===0&&f){op(function(){f.b.width=act.slice(2);});renderDoc();return;}
  if(act.indexOf('t:')===0&&f)tableAct(f.b,act.slice(2));
}
function linkPop(a){
  var href=a.getAttribute('href')||'',ed=a.closest('[contenteditable="true"]');
  var el=pop(a.getBoundingClientRect(),'<div style="display:flex;align-items:center;gap:4px;padding:6px 8px;max-width:420px"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#8a8178">'+H(href)+'</span><button class="nt-btn sec" data-o="1" style="padding:4px 9px">'+L('Åbn','Open')+' ↗</button><button class="nt-btn sec" data-e="1" style="padding:4px 9px">'+L('Redigér','Edit')+'</button><button class="nt-btn sec" data-r="1" style="padding:4px 9px">'+L('Fjern','Remove')+'</button></div>',{});
  el.addEventListener('click',function(e){
    if(e.target.closest('[data-o]')){closePop();if(href[0]==='#')location.hash=href.slice(1);else window.open(href,'_blank','noopener');}
    if(e.target.closest('[data-r]')){closePop();while(a.firstChild)a.parentNode.insertBefore(a.firstChild,a);a.remove();syncEditable(ed);}
    if(e.target.closest('[data-e]')){closePop();var r=document.createRange();r.selectNodeContents(a);var s=getSelection();ed.focus();s.removeAllRanges();s.addRange(r);linkSel(a.getBoundingClientRect());}
  });
}
function tableAct(b,k){
  var c=S.cell&&S.cell.id===b.id?S.cell:{r:b.rows.length-1,c:0},rows=b.rows,nc=rows[0]?rows[0].length:1;
  op(function(){
    if(k==='hdr')b.header=!b.header;
    else if(k==='ra'||k==='rb'||k==='add-r'){var at=k==='ra'?c.r:k==='rb'?c.r+1:rows.length;rows.splice(at,0,new Array(nc).fill(''));c={r:at,c:c.c};}
    else if(k==='cl'||k==='cr'||k==='add-c'){var ac=k==='cl'?c.c:k==='cr'?c.c+1:nc;rows.forEach(function(r){r.splice(ac,0,'');});c={r:c.r,c:ac};}
    else if(k==='dr'&&rows.length>1){rows.splice(c.r,1);c={r:Math.min(c.r,rows.length-1),c:c.c};}
    else if(k==='dc'&&nc>1){rows.forEach(function(r){r.splice(c.c,1);});c={r:c.r,c:Math.min(c.c,nc-2)};}
  });
  renderDoc();var cell=$('.nt-b[data-id="'+b.id+'"] .nt-cell[data-r="'+c.r+'"][data-c="'+c.c+'"]');if(cell)setCaret(cell,'end');
}
function onChange(e){
  var t=e.target,be=t.closest('.nt-b');if(!be||!S.page)return;var f=find(be.dataset.id);if(!f)return;
  if(t.dataset.act==='clang'){f.b.lang=t.value;changed();}
  if(t.dataset.act==='remat'&&t.value){op(function(){f.b.at=new Date(t.value).toISOString();});var st=$('.nt-rem-st',be);if(st)st.textContent='';}
  if(t.dataset.act==='remwho'){op(function(){f.b.userId=+t.value;});}
}
// Pæn typografi mens man skriver: -> bliver →, <- bliver ←, -- bliver –
function smartTypo(ed,ch){
  var sl=getSelection();if(!sl.rangeCount||!sl.isCollapsed)return false;var n=sl.anchorNode,o=sl.anchorOffset;if(!n||n.nodeType!==3||!ed.contains(n))return false;
  if(n.parentElement&&n.parentElement.closest('code'))return false;
  var before=n.data.slice(0,o),rep=null;
  if(ch==='>'&&/->$/.test(before))rep='→';
  if(ch==='>'&&/←>$/.test(before))rep='↔';
  if(ch==='-'&&/<-$/.test(before))rep='←';
  if(ch==='-'&&!rep&&/--$/.test(before)&&!/^-+$/.test(ed.textContent.replace(/\u00a0/g,' ').trim()))rep='–';
  if(!rep)return false;var cut=2;
  snapshot();n.replaceData(o-cut,cut,rep);var r=document.createRange();r.setStart(n,o-cut+rep.length);r.collapse(true);sl.removeAllRanges();sl.addRange(r);
  return true;
}
function onInput(e){
  var t=e.target;if(!S.page)return;
  if(t.classList&&t.classList.contains('nt-tab-t')){var ft=find(t.closest('.nt-b').dataset.id);if(ft){ft.b.titles[+t.dataset.ti]=t.textContent.replace(/\s+/g,' ').slice(0,80);changed();}return;}
  if(t.classList.contains('nt-code-txt')){var f0=find(t.closest('.nt-b').dataset.id);if(f0){f0.b.code=t.value;autoGrow(t);changed();}return;}
  var ed=t.closest&&t.closest('#nt-doc .nt-txt,#nt-doc .nt-cell,#nt-doc .nt-cap');if(!ed)return;
  var be=ed.closest('.nt-b'),f=find(be.dataset.id);if(!f)return;var b=f.b;
  if(ed.innerHTML==='<br>')ed.innerHTML='';
  // fortryd-punkter mens man skriver: ved pause, ordskifte eller sletning
  var now=Date.now(),it=e.inputType||'',del=/^delete/.test(it);
  if(now-(S.lastTypeSnap||0)>900||(it==='insertText'&&e.data===' '&&S.lastKind!=='space')||(del&&S.lastKind!=='del')||(!del&&S.lastKind==='del')||/Paste|Drop|Format/.test(it)){snapshot();}
  S.lastTypeSnap=now;S.lastKind=del?'del':(e.data===' '?'space':'ins');
  if(ed.classList.contains('nt-txt')){
    b.html=norm(ed.innerHTML);
    if(e.inputType==='insertText'&&(e.data==='>'||e.data==='-')&&smartTypo(ed,e.data)){b.html=norm(ed.innerHTML);changed();return;}
    if(e.inputType==='insertText'||e.inputType==='insertCompositionText'){
      if(e.data===' '||e.data==='`'||e.data==='-'||e.data==='_'||e.data==='*'){if(mdShortcut(ed,b))return;}
      if(e.data&&/[*`~]/.test(e.data))inlineMd(ed,b);
    }
    checkTriggers(ed,b);
    if(b.type==='p'||/^t?h/.test(b.type))renderTemplates(false);
    if(/^t?h[123]$/.test(b.type))refreshToc();
  }else syncEditable(ed);
  changed();
}
var refreshToc=debounce(function(){$$('#nt-doc .nt-t-toc').forEach(function(el){var f=find(el.dataset.id);if(f){var hs=headings();$('.nt-bc',el).innerHTML='<div class="nt-toc" contenteditable="false">'+(hs.length?hs.map(function(x){return '<a data-act="tocgo" data-to="'+x.id+'" class="lv'+x.lv+'">'+H(x.t)+'</a>';}).join(''):'<div class="nt-toc-e">'+L('Tilføj overskrifter, så vises de her.','Add headings to build a table of contents.')+'</div>')+'</div>';}});},400);

function selKeys(e){
  var mod=e.metaKey||e.ctrlKey;
    if(e.key==='Tab'){e.preventDefault();indentMany(S.sel.slice(),e.shiftKey?-1:1);return;}
    if(e.key==='/'&&!mod){e.preventDefault();var fe=$('.nt-b[data-id="'+S.sel[0]+'"]');blockMenu(S.sel[0],'turn',fe?$('.nt-bc',fe).getBoundingClientRect():null);return;}
    if(mod&&(e.key==='c'||e.key==='C'||e.key==='x'||e.key==='X')){e.preventDefault();copySel(e.key.toLowerCase()==='x');return;}
    if(mod&&!e.altKey&&!e.shiftKey&&/^[biue]$/i.test(e.key)){e.preventDefault();applyFmt({b:'bold',i:'italic',u:'underline',e:'code'}[e.key.toLowerCase()]);return;}
    if(mod&&e.key==='Enter'){e.preventDefault();var todos=S.sel.map(function(i){return find(i);}).filter(function(f){return f&&f.b.type==='todo';});if(todos.length){var on=!todos.every(function(f){return f.b.checked;});op(function(){todos.forEach(function(f){f.b.checked=on;});});var k2=S.sel.slice();renderDoc();reselect(k2);}return;}
    if(mod&&(e.key==='a'||e.key==='A')){e.preventDefault();selectBlocks(leafEls().map(function(x){return x.dataset.id;}));return;}
    if(e.key==='Backspace'||e.key==='Delete'){e.preventDefault();deleteBlocks(S.sel.slice());return;}
    if(e.key==='Escape'){selectBlocks([]);return;}
    if(e.key==='Enter'){e.preventDefault();var sid=S.sel[S.sel.length-1];selectBlocks([]);focusBlock(sid,'end');return;}
    if(mod&&(e.key==='d'||e.key==='D')){e.preventDefault();duplicateMany(S.sel.slice());return;}
    if(mod&&e.shiftKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();moveBlock(S.sel[0],e.key==='ArrowUp'?-1:1);return;}
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();var all=$$('#nt-doc .nt-b:not(.nt-hide)').filter(function(x){return !x.classList.contains('nt-t-columns');}).map(function(x){return x.dataset.id;}),cur=S.sel[e.key==='ArrowUp'?0:S.sel.length-1],ix=all.indexOf(cur)+(e.key==='ArrowUp'?-1:1);if(ix<0||ix>=all.length)return;
      if(e.shiftKey){var ns=S.sel.slice();if(ns.indexOf(all[ix])<0){if(e.key==='ArrowUp')ns.unshift(all[ix]);else ns.push(all[ix]);}selectBlocks(ns);}else selectBlocks([all[ix]]);var se=$('.nt-b[data-id="'+all[ix]+'"]');if(se)se.scrollIntoView({block:'nearest'});return;}
    if(mod&&e.key==='z'){e.preventDefault();undo(e.shiftKey);return;}
    if(!mod&&!e.shiftKey&&QUICK_TURN[e.code]){e.preventDefault();var qk=S.sel.slice();if(quickTurn(qk,QUICK_TURN[e.code])){renderDoc();reselect(qk);}return;}
    if(mod&&e.shiftKey&&(e.code==='Period'||e.code==='Comma')){e.preventDefault();stepSize(S.sel.slice(),e.code==='Period'?1:-1);return;}
    if(mod&&e.altKey&&DIGIT_TURN[e.code]){e.preventDefault();var tt=DIGIT_TURN[e.code];op(function(){S.sel.forEach(function(i){var g=find(i);if(g&&(isTxt(g.b.type)||g.b.type==='code'))turnInto(g.b,tt);});});var keep=S.sel.slice();renderDoc();reselect(keep);return;}
}
// Hurtig-omdan: B = toggle, P = punktliste (igen = tilbage til tekst)
var QUICK_TURN={KeyB:'toggle',KeyP:'todo'};
function quickTurn(ids,type){
  // B = toggle, P = to-do (igen = tilbage til tekst). Toggle og to-do kombineres ikke længere (okt. 2026).
  var fs=ids.map(function(i){return find(i);}).filter(function(g){return g&&isTxt(g.b.type);});if(!fs.length)return false;
  var to=fs.every(function(g){return g.b.type===type;})?'p':type;
  op(function(){fs.forEach(function(g){var b=g.b,c=b.checked;delete b.todo;turnInto(b,to);if(to==='todo')b.checked=!!c&&type==='todo';});});
  toast2((to==='p'?L('Tekst','Text'):to==='toggle'?L('Toggle','Toggle'):L('To-do','To-do'))+(fs.length>1?' ('+fs.length+')':''));
  return true;
}
function applyFsEl(b){var e=$('.nt-b[data-id="'+b.id+'"]');if(!e)return;FS.concat(['n']).forEach(function(k){e.classList.remove('nt-fs-'+k);});e.classList.remove('nt-fsn');e.style.removeProperty('--fs');
  if(typeof b.fs==='number'){e.classList.add('nt-fsn');e.style.setProperty('--fs',b.fs+'px');}else if(b.fs)e.classList.add('nt-fs-'+b.fs);}
function setSize(ids,fs){var fl=ids.map(function(i){return find(i);}).filter(function(g){return g&&isTxt(g.b.type);});if(!fl.length)return;
  if(fs!=null&&/^\d+$/.test(String(fs)))fs=Math.max(8,Math.min(96,+fs));
  op(function(){fl.forEach(function(g){if(!fs||fs==='m')delete g.b.fs;else g.b.fs=fs;});});
  fl.forEach(function(g){applyFsEl(g.b);});
  toast2(L('Skriftstørrelse: ','Text size: ')+(typeof fs==='number'?fs+' px':FSN[fs||'m']));if(S.sel.length)posSelBar();}
function curPx(id){var e=$('.nt-b[data-id="'+id+'"] .nt-txt');return e?Math.round(parseFloat(getComputedStyle(e).fontSize)):16;}
function stepSize(ids,dir){var g=find(ids[0]);if(!g)return;var px=typeof g.b.fs==='number'?g.b.fs:curPx(ids[0]);setSize(ids,px+dir*2);}
var PXS=[12,14,16,18,20,24,28,32,40];
function sizePop(anchor,ids){var g=find(ids[0]),cur=g&&typeof g.b.fs==='number'?g.b.fs:curPx(ids[0]);
  var el=pop(anchor,'<div class="nt-mg">'+L('Skriftstørrelse','Text size')+'</div><div class="nt-pxg">'+PXS.map(function(n){return '<button data-px="'+n+'" class="'+(n===cur?'on':'')+'">'+n+'</button>';}).join('')+'</div>'+
    '<div class="nt-pxr"><input type="number" min="8" max="96" step="1" value="'+cur+'" class="nt-pxi"><span>px</span><button data-px-ok="1" class="nt-btn">OK</button><button data-fs="m" class="nt-btn ghost">'+L('Normal','Reset')+'</button></div>'+
    '<div class="nt-mg" style="font-weight:400">'+MOD+'⇧. '+L('større','bigger')+' · '+MOD+'⇧, '+L('mindre','smaller')+'</div>',{type:'list',width:300,cls:'small'});
  var inp=$('.nt-pxi',el);setTimeout(function(){inp.focus();inp.select();},20);
  inp.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Enter'){e.preventDefault();closePop();setSize(ids,inp.value);}if(e.key==='Escape')closePop();});
  el.addEventListener('click',function(e){var x=e.target.closest('[data-px],[data-fs],[data-px-ok]');if(!x)return;closePop();
    if(x.dataset.px)setSize(ids,x.dataset.px);else if(x.dataset.pxOk)setSize(ids,inp.value);else setSize(ids,'m');});}
// Justering (nov. 2026): venstre / centreret / højre pr. tekstblok – virker overalt, også i faner og kolonner
var AL_LBL={'':['Venstre','Left'],center:['Centreret','Center'],right:['Højre','Right']};
function alIcon(al){var y=[4,8,12,16],w=[14,9,14,9];return '<svg width="14" height="14" viewBox="0 0 18 18" style="vertical-align:-2px">'+y.map(function(yy,i){var x=al==='center'?(18-w[i])/2:al==='right'?16-w[i]:2;return '<rect x="'+x+'" y="'+(yy-1)+'" width="'+w[i]+'" height="1.8" rx=".9" fill="currentColor"/>';}).join('')+'</svg>';}
function selAl(){var g=S.sel.length&&find(S.sel[0]);return g&&g.b.al||'';}
function alignable(b){return b&&(isTxt(b.type)||b.type==='callout');}
function setAlign(ids,al){var fl=ids.map(function(i){return find(i);}).filter(function(g){return g&&alignable(g.b);});if(!fl.length)return;
  if(al!=='center'&&al!=='right')al='';
  op(function(){fl.forEach(function(g){if(al)g.b.al=al;else delete g.b.al;});});
  fl.forEach(function(g){var e=$('.nt-b[data-id="'+g.b.id+'"]');if(!e)return;e.classList.remove('nt-al-center','nt-al-right');if(al)e.classList.add('nt-al-'+al);});
  toast2(L('Justering: ','Alignment: ')+L(AL_LBL[al][0],AL_LBL[al][1]));if(S.sel.length){posSelBar();selBar();}}
function alignPop(anchor,ids){var g=find(ids[0]),cur=g&&g.b.al||'';
  var el=pop(anchor,'<div class="nt-mg">'+L('Justering','Alignment')+'</div><div class="nt-alg">'+['','center','right'].map(function(a){return '<button data-al="'+a+'" class="'+(a===cur?'on':'')+'">'+alIcon(a)+'<span>'+L(AL_LBL[a][0],AL_LBL[a][1])+'</span></button>';}).join('')+'</div>',{type:'list',width:260,cls:'small'});
  el.addEventListener('mousedown',function(e){e.preventDefault();});
  el.addEventListener('click',function(e){var x=e.target.closest('[data-al]');if(!x)return;closePop();setAlign(ids,x.dataset.al);});}
function toast2(m){var o=document.querySelector('.nt-qtoast');if(o)o.remove();var t=document.createElement('div');t.className='nt-qtoast';t.textContent=m;document.body.appendChild(t);setTimeout(function(){t.remove();},1600);}
var DIGIT_TURN={Digit0:'p',Digit1:'h1',Digit2:'h2',Digit3:'h3',Digit4:'todo',Digit5:'bullet',Digit6:'num',Digit7:'toggle',Digit8:'code'};
function onKeydown(e){
  var t=e.target,mod=e.metaKey||e.ctrlKey;
  if(t.classList&&t.classList.contains('nt-tab-t')){
    if(e.key==='Enter'||e.key==='ArrowDown'||e.key==='Escape'){e.preventDefault();var pane=t.closest('.nt-tabsb').querySelector('.nt-tabpane .nt-txt, .nt-tabpane .nt-code-txt');if(pane)setCaret(pane,'end');else t.blur();}
    return;
  }
  // titel
  if(t.classList&&t.classList.contains('nt-title')){
    if(e.key==='Enter'||(e.key==='ArrowDown'&&lineEdge(t,false))){e.preventDefault();var fb=S.page.blocks[0];if(e.key==='Enter'&&fb&&isTxt(fb.type)&&plain(fb.html).trim()){op(function(){S.page.blocks.unshift(newBlock('p'));});renderDoc();}var first=editables()[0];if(first)setCaret(first,'start');renderTemplates(false);}
    return;
  }
  // kodeblok
  if(t.classList&&t.classList.contains('nt-code-txt')){
    if(e.key==='Tab'){e.preventDefault();document.execCommand('insertText',false,'  ');return;}
    if(e.key==='Escape'||(mod&&e.key==='Enter')){e.preventDefault();var bc=find(t.closest('.nt-b').dataset.id).b;var nx=after(bc,'p');focusBlock(nx.id,0);return;}
    if(e.key==='ArrowUp'&&t.selectionStart===0){if(moveFocus(t,-1,'end'))e.preventDefault();return;}
    if(e.key==='ArrowDown'&&t.selectionStart===t.value.length){if(moveFocus(t,1,'start'))e.preventDefault();return;}
    if(e.key==='Backspace'&&!t.value){e.preventDefault();var bb=find(t.closest('.nt-b').dataset.id).b;op(function(){turnInto(bb,'p');});renderDoc({id:bb.id,pos:0});return;}
    return;
  }
  // tabelcelle
  if(t.classList&&t.classList.contains('nt-cell')){
    var be0=t.closest('.nt-b'),tb=find(be0.dataset.id).b,r=+t.dataset.r,c=+t.dataset.c;S.cell={id:tb.id,r:r,c:c};
    if(e.key==='Tab'){e.preventDefault();var nc=tb.rows[0].length,i=r*nc+c+(e.shiftKey?-1:1);if(i>=tb.rows.length*nc){tableAct(tb,'add-r');return;}if(i<0)return;var nx2=$('.nt-cell[data-r="'+Math.floor(i/nc)+'"][data-c="'+(i%nc)+'"]',be0);if(nx2)setCaret(nx2,'end');return;}
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();var dn=$('.nt-cell[data-r="'+(r+1)+'"][data-c="'+c+'"]',be0);if(dn)setCaret(dn,'end');else{var nx3=after(tb,'p');focusBlock(nx3.id,0);}return;}
    if(e.key==='ArrowUp'&&lineEdge(t,true)){var up=$('.nt-cell[data-r="'+(r-1)+'"][data-c="'+c+'"]',be0);e.preventDefault();if(up)setCaret(up,'end');else moveFocusFromBlock(be0,-1);return;}
    if(e.key==='ArrowDown'&&lineEdge(t,false)){var dn2=$('.nt-cell[data-r="'+(r+1)+'"][data-c="'+c+'"]',be0);e.preventDefault();if(dn2)setCaret(dn2,'start');else moveFocusFromBlock(be0,1);return;}
    if(mod)formatKeys(e);
    return;
  }
  if(t.classList&&t.classList.contains('nt-cap')){if(e.key==='Enter'){e.preventDefault();var cb=find(t.closest('.nt-b').dataset.id).b;var nx4=after(cb,'p');focusBlock(nx4.id,0);}else if(mod)formatKeys(e);return;}
  var ed=t.closest&&t.closest('#nt-doc .nt-txt');if(!ed)return;
  var be=ed.closest('.nt-b'),f=find(be.dataset.id);if(!f)return;var b=f.b;
  if(e.isComposing)return;
  if(e.key==='Enter'&&!e.shiftKey&&!mod){e.preventDefault();b.html=norm(ed.innerHTML);splitBlock(ed,b);return;}
  if(e.key==='Enter'&&mod){e.preventDefault();if(b.type==='todo'){op(function(){b.checked=!b.checked;});be.classList.toggle('nt-done',b.checked);$('.nt-chk',be).checked=b.checked;}else if(isTog(b.type)){b.open=!b.open;changed();rerenderKeep();}return;}
  var s=getSelection(),coll=s.isCollapsed;
  if(e.key==='Backspace'&&coll&&caretOffset(ed)===0){e.preventDefault();b.html=norm(ed.innerHTML);backspaceAtStart(ed,b);return;}
  if(e.key==='Delete'&&coll&&caretOffset(ed)===ed.textContent.length){e.preventDefault();b.html=norm(ed.innerHTML);deleteAtEnd(ed,b);return;}
  if(e.key==='Tab'){e.preventDefault();indentBlock(b.id,e.shiftKey?-1:1);return;}
  if(e.altKey&&!mod&&!e.shiftKey&&QUICK_TURN[e.code]){e.preventDefault();b.html=norm(ed.innerHTML);if(quickTurn([b.id],QUICK_TURN[e.code]))rerenderKeep();return;}
  if(e.key==='Escape'){e.preventDefault();selectBlocks([b.id]);return;}
  if(e.shiftKey&&!mod&&(e.key==='ArrowUp'||e.key==='ArrowDown')&&lineEdge(ed,e.key==='ArrowUp')){var sl=getSelection(),all0=leafEls().map(function(x){return x.dataset.id;}),ix0=all0.indexOf(b.id),nx0=all0[ix0+(e.key==='ArrowUp'?-1:1)];
    if(nx0){e.preventDefault();var ao0=sl.anchorNode&&ed.contains(sl.anchorNode)?(function(){var pr=document.createRange();pr.selectNodeContents(ed);pr.setEnd(sl.anchorNode,sl.anchorOffset);return pr.toString().length;})():caretOffset(ed);var nl=txtOf($('.nt-b[data-id="'+nx0+'"]'));startX(b.id,ao0,nx0,e.key==='ArrowUp'?0:(nl?nl.textContent.length:0));return;}}
  if(e.key==='ArrowUp'&&!e.shiftKey&&!mod&&lineEdge(ed,true)){if(moveFocus(ed,-1,'end'))e.preventDefault();else{e.preventDefault();var ti=$('.nt-title');if(ti)setCaret(ti,'end');}return;}
  if(e.key==='ArrowDown'&&!e.shiftKey&&!mod&&lineEdge(ed,false)){if(moveFocus(ed,1,'start'))e.preventDefault();return;}
  if(e.key==='ArrowLeft'&&coll&&!e.shiftKey&&caretOffset(ed)===0){if(moveFocus(ed,-1,'end'))e.preventDefault();return;}
  if(e.key==='ArrowRight'&&coll&&!e.shiftKey&&caretOffset(ed)===ed.textContent.length){if(moveFocus(ed,1,'start'))e.preventDefault();return;}
  if(!mod)return;
  if(e.altKey&&DIGIT_TURN[e.code]){e.preventDefault();b.html=norm(ed.innerHTML);var to=DIGIT_TURN[e.code];op(function(){turnInto(b,to);});renderDoc({id:b.id,pos:'end'});if(to==='code'){var ta=$('.nt-b[data-id="'+b.id+'"] .nt-code-txt');if(ta)ta.focus();}return;}
  if(e.shiftKey&&(e.code==='Period'||e.code==='Comma')){e.preventDefault();b.html=norm(ed.innerHTML);stepSize([b.id],e.code==='Period'?1:-1);return;}
  if(e.altKey&&e.code==='Digit9'){e.preventDefault();createSubpage(b,!plain(b.html).trim());return;}
  if(e.key==='z'||e.key==='Z'){e.preventDefault();undo(e.shiftKey);return;}
  if(e.key==='y'||e.key==='Y'){e.preventDefault();undo(true);return;}
  if((e.key==='d'||e.key==='D')&&!e.shiftKey){e.preventDefault();duplicateBlock(b.id);return;}
  if(e.shiftKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();b.html=norm(ed.innerHTML);moveBlock(b.id,e.key==='ArrowUp'?-1:1);return;}
  if(e.key==='a'&&s.toString().length>=ed.textContent.length&&ed.textContent.length){e.preventDefault();selectBlocks($$('#nt-doc .nt-b:not(.nt-hide)').filter(function(x){return !x.parentElement.closest('.nt-b');}).map(function(x){return x.dataset.id;}));return;}
  formatKeys(e);
}
function formatKeys(e){
  var k=e.key.toLowerCase();
  if(k==='e'){e.preventDefault();wrapSel('code');return;}
  if(k==='k'&&!getSelection().isCollapsed){e.preventDefault();linkSel();return;}
  if(k==='s'&&e.shiftKey){e.preventDefault();document.execCommand('strikeThrough');var ed=curEditable();if(ed)syncEditable(ed);return;}
  if(k==='h'&&e.shiftKey){e.preventDefault();if(S.lastColor)applyColor(S.lastColor);return;}
}
function moveFocusFromBlock(be,dir){var a=editables();var all=$$('#nt-doc .nt-txt,#nt-doc .nt-code-txt,#nt-doc .nt-b');var idx=all.indexOf(be);for(var i=idx+dir;i>=0&&i<all.length;i+=dir){var x=all[i];if(a.indexOf(x)>-1&&!be.contains(x)){setCaret(x,dir<0?'end':'start');return;}}}
function pasteIntoLine(ed,b,pb){
  snapshot();adoptListType(b,pb.slice(1).filter(function(x){return (x.indent||0)===(pb[0].indent||0);}));
  var first=pb[0],rest=pb.slice(1),fi=first.indent||0,kids=[],sibs=[];
  rest.forEach(function(x){if(!sibs.length&&(x.indent||0)>fi)kids.push(x);else sibs.push(x);});
  if(first.html)document.execCommand('insertHTML',false,first.html);
  var pos=caretOffset(ed);b.html=norm(ed.innerHTML);
  op(function(){var f=find(b.id);if(!f)return;var base=b.indent||0,at=groupEnd(f.list,f.i);
    kids.forEach(function(x){x.indent=Math.min(10,base+(x.indent||0)-fi);if(!x.indent)delete x.indent;});
    sibs.forEach(function(x){x.indent=Math.min(10,Math.max(base,base+(x.indent||0)-fi));if(!x.indent)delete x.indent;});
    // har det indsatte indhold under sig, åbnes linjen hvis den er en toggle
    if(kids.length&&isTog(b.type))b.open=true;
    f.list.splice.apply(f.list,[at,0].concat(kids,sibs));
  });
  renderDoc({id:b.id,pos:pos});
}
function onPaste(e){
  var t=e.target;if(!S.page)return;
  if(t.classList&&(t.classList.contains('nt-title')||t.classList.contains('nt-tab-t'))){e.preventDefault();insertTextAtCaret((e.clipboardData.getData('text/plain')||'').replace(/\s*\n\s*/g,' '));return;}
  if(t.classList&&t.classList.contains('nt-code-txt'))return;
  var ed=t.closest&&t.closest('#nt-doc .nt-txt,#nt-doc .nt-cell,#nt-doc .nt-cap');if(!ed)return;
  var cd=e.clipboardData,be=ed.closest('.nt-b'),f=find(be.dataset.id);if(!f)return;
  var files=Array.prototype.slice.call(cd.files||[]);
  if(files.length){e.preventDefault();uploadFiles(files,f.b.id);return;}
  if(ed.classList.contains('nt-txt')){var pb=pastedBlocks(cd);
    // Indsæt midt i en linje med tekst: første linje flettes ind hvor markøren står, og dens indhold lægges ind under linjen
    if(pb&&pb[0]&&pb[0].html!=null&&isTxt(f.b.type)&&plain(norm(ed.innerHTML)).trim()){e.preventDefault();pasteIntoLine(ed,f.b,pb);return;}
    if(pb){e.preventDefault();var lastB;f.b.html=norm(ed.innerHTML);op(function(){lastB=insertBlocksAfter(f.b.id,pb);});renderDoc(lastB?{id:lastB.id,pos:'end'}:null);renderTemplates(false);return;}}
  var txt=cd.getData('text/plain')||'';e.preventDefault();
  var url=/^https?:\/\/\S+$/.test(txt.trim())?txt.trim():null;
  if(url&&!getSelection().isCollapsed){document.execCommand('createLink',false,url);syncEditable(ed);return;}
  if(url&&ed.classList.contains('nt-txt')&&!plain(f.b.html).trim()){urlPasteMenu(f.b,url);return;}
  if(url){insertChip('<a href="'+H(url)+'" target="_blank" rel="noopener">'+H(url)+'</a>');syncEditable(ed);return;}
  var lines=txt.replace(/\r/g,'').split('\n');
  if(!ed.classList.contains('nt-txt')){insertTextAtCaret(txt);syncEditable(ed);return;}
  var lw=function(l){return ((l.match(/^[ \t]*/)||[''])[0].replace(/\t/g,'    ')).length;},unit=lines.map(lw).filter(function(x){return x>0;}).reduce(function(a,x){return Math.min(a,x);},99);if(unit===99)unit=2;
  var parse=function(l){var m,ind=Math.round(lw(l)/unit);l=l.replace(/^\s+/,'');
    if((m=l.match(/^(?:[-*•]\s+)?(?:\[( |x|X)?\]|(☐)|(☑|☒|✅|✔️?|✓))\s*(.*)/)))return {t:'todo',x:m[4],c:!!(m[3]||(m[1]&&m[1].toLowerCase()==='x')),ind:ind};
    if((m=l.match(/^(?:▶️?|▸|►|‣|▷)\s*(.*)/)))return {t:'toggle',x:m[1],ind:ind};
    if((m=l.match(/^(#{1,3})\s+(.*)/)))return {t:'h'+m[1].length,x:m[2]};if((m=l.match(/^[-*•]\s+\[( |x)\]\s+(.*)/i)))return {t:'todo',x:m[2],c:m[1]!==' ',ind:ind};if((m=l.match(/^[-*•]\s+(.*)/)))return {t:'bullet',x:m[1],ind:ind};if((m=l.match(/^\d+[.)]\s+(.*)/)))return {t:'num',x:m[1],ind:ind};if((m=l.match(/^>\s?(.*)/)))return {t:'quote',x:m[1],ind:ind};return {t:'p',x:l,ind:ind};};
  var kidsToggle=function(arr){arr.forEach(function(p,i){var n=arr[i+1];if(n&&(p.t==='p')&&(n.ind||0)>(p.ind||0))p.t='toggle';});return arr;};
  var mk=function(p){var nb=bl(p.t,H(p.x).replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>'));if(p.c)nb.checked=true;if(isTog(p.t))nb.open=true;nb._ind=p.ind||0;return nb;};
  f.b.html=norm(ed.innerHTML);var curEmpty=!plain(f.b.html).trim()&&!/<(img|span|a)\b/.test(f.b.html||'');
  var nonEmpty=lines.filter(function(l){return l.trim();}),parsed=kidsToggle(nonEmpty.map(parse));
  if(curEmpty&&parsed.some(function(p){return p.t!=='p';})){ // tom linje: alle linjer bliver blokke med deres type (Notion, Markdown, Docs…)
    var min=Math.min.apply(null,parsed.map(function(p){return p.ind||0;})),ins0=parsed.map(mk);ins0.forEach(function(nb){nb.indent=Math.min(10,(f.b.indent||0)+nb._ind-min);if(!nb.indent)delete nb.indent;delete nb._ind;});
    op(function(){f.list.splice.apply(f.list,[f.i,1].concat(ins0));});renderDoc({id:ins0[ins0.length-1].id,pos:'end'});return;}
  if(lines.length<2){insertTextAtCaret(txt);syncEditable(ed);return;}
  // flere linjer → første linje ind i blokken, resten som blokke (med markdown-genkendelse)
  insertTextAtCaret(lines[0]);f.b.html=norm(ed.innerHTML);
  op(function(){var at=f.i+1,rest=lines.slice(1).filter(function(l,i,a){return l.trim()||i<a.length-1;}).map(parse);kidsToggle(rest);var m0=rest.length?Math.min.apply(null,rest.map(function(p){return p.ind||0;})):0;
    var ins=rest.map(function(p){var nb=mk(p);nb.indent=Math.min(10,(f.b.indent||0)+nb._ind-m0);if(!nb.indent)delete nb.indent;delete nb._ind;return nb;}).filter(function(nb){return nb.type!=='p'||nb.html;});
    f.list.splice.apply(f.list,[at,0].concat(ins));if(ins.length)renderDoc({id:ins[ins.length-1].id,pos:'end'});});
}
function urlPasteMenu(b,url){
  var e=embedInfo(url);
  var el=pop(caretRect(),'<div class="nt-mg">'+L('Indsæt som','Paste as')+'</div><button class="nt-mi" data-k="link"><span class="nt-mi-i">🔗</span>'+L('Link','Link')+'</button><button class="nt-mi" data-k="bookmark"><span class="nt-mi-i">🔖</span>'+L('Link-kort','Bookmark')+'</button><button class="nt-mi" data-k="embed"><span class="nt-mi-i">🧩</span>'+L('Indlejr','Embed')+(e.kind!=='web'?' ('+e.label+')':'')+'</button>',{type:'list',cls:'small',width:240});
  S.menu.act=e.kind!=='web'?2:0;hl($$('.nt-mi',el),S.menu.act);
  var saved=saveRange();
  el.addEventListener('mousedown',function(ev){ev.preventDefault();});
  el.addEventListener('click',function(ev){var x=ev.target.closest('[data-k]');if(!x)return;closePop();
    if(x.dataset.k==='link'){restoreRange(saved);insertChip('<a href="'+H(url)+'" target="_blank" rel="noopener">'+H(url)+'</a>');var ed=$('.nt-b[data-id="'+b.id+'"] .nt-txt');if(ed)syncEditable(ed);return;}
    op(function(){turnInto(b,x.dataset.k);delete b.html;b.url=url;});after(b,'p');renderDoc();if(x.dataset.k==='bookmark')fetchPreview(b);});
}

// ── globale lyttere ─────────────────────────────────────────
document.addEventListener('selectionchange',debounce(function(){if(!S.built||!isActive()||S.applying||S.xsel||S.sel.length)return;if(S.menu&&/slash|mention/.test(S.menu.type))return;showStb();},120));
document.addEventListener('mousedown',function(e){
  if(S.menu&&!S.menu.el.contains(e.target)&&!(stbEl&&stbEl.contains(e.target)))closePop();
  if(stbEl&&!stbEl.contains(e.target)&&!(e.target.closest&&e.target.closest('.nt-txt,.nt-cell,.nt-cap')))hideStb();
},true);
document.addEventListener('keydown',function(e){
  if(!S.built||!isActive())return;var mod=e.metaKey||e.ctrlKey;
  if(S.menu&&menuNav(e)){e.stopPropagation();return;}
  if(e.key==='Escape'&&S.menu&&!/slash|mention|list/.test(S.menu.type)){closePop();return;}
  if(document.getElementById('nt-ovl'))return;
  var ae=document.activeElement;
  var editing=ae&&(ae.isContentEditable||/INPUT|TEXTAREA|SELECT/.test(ae.tagName));
  if(mod&&!e.altKey&&!editing&&S.page&&(e.key==='z'||e.key==='Z'||e.key==='y'||e.key==='Y')){e.preventDefault();e.stopPropagation();undo(e.shiftKey||e.key==='y'||e.key==='Y');return;}
  if(S.xsel&&!editing){xselKeys(e);if(e.defaultPrevented)return;}
  else if(S.sel.length&&!editing){selKeys(e);if(e.defaultPrevented)return;}
  if(e.key==='Escape'&&S.menu){closePop();e.preventDefault();return;}
  if(mod&&(e.key==='k'||e.key==='p')&&!(getSelection().toString()&&curEditable())){e.preventDefault();openSearch();return;}
  if(mod&&e.key==='\\'){e.preventDefault();var app=$('#nt-app');if(app.classList.contains('nt-side-off'))app.classList.remove('nt-side-off');else app.classList.add('nt-side-off');return;}
  if(mod&&e.shiftKey&&(e.key==='l'||e.key==='L')&&S.page){e.preventDefault();openComments();return;}
},true);
function isActive(){var p=document.getElementById('page-kb-notes');return p&&p.classList.contains('active');}
window.addEventListener('pagehide',flush);
window.addEventListener('beforeunload',flush);
window.addEventListener('focus',async function(){
  if(!S.page||!isActive())return;
  await pullRemote();loadTree();
});
setInterval(pullRemote,4000);
document.addEventListener('compositionstart',function(){S.composing=true;},true);
document.addEventListener('compositionend',function(){S.composing=false;},true);
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')flush();});

function fitHeight(){var a=$('#nt-app');if(!a||!isActive())return;var top=a.getBoundingClientRect().top+scrollY;a.style.height=Math.max(480,innerHeight-top)+'px';}
window.addEventListener('resize',debounce(fitHeight,100));
// ── værktøjslinje over tastaturet på telefon (okt. 2026): Tab/Shift+Tab, toggle,
// to-do, punkt, fortryd – det man ellers kun har på et fysisk tastatur.
var kbar=null;
function isTouchUI(){return (window.matchMedia&&matchMedia('(pointer:coarse)').matches)||innerWidth<700;}
function kbarCur(){var ed=curEditable();if(!ed||!ed.classList.contains('nt-txt'))return null;var be=ed.closest('.nt-b'),f=be&&find(be.dataset.id);return f?{ed:ed,b:f.b}:null;}
function kbarBuild(){
  if(kbar)return kbar;kbar=document.createElement('div');kbar.className='nt-kbar';kbar.setAttribute('data-no-i18n','');
  kbar.innerHTML='<button data-k="out" aria-label="'+L('Ryk ud','Outdent')+'">⇤</button><button data-k="in" aria-label="'+L('Ryk ind','Indent')+'">⇥</button><i></i><button data-k="toggle" aria-label="Toggle">▸</button><button data-k="todo" aria-label="To-do">☐</button><button data-k="bullet" aria-label="'+L('Punkt','Bullet')+'">•</button><button data-k="slash" aria-label="'+L('Flere blokke','More blocks')+'">/</button><button data-k="at" aria-label="@">@</button><i></i><button data-k="undo" aria-label="'+L('Fortryd','Undo')+'">↶</button><button data-k="redo" aria-label="'+L('Gentag','Redo')+'">↷</button><span class="sp"></span><button data-k="done" aria-label="'+L('Luk tastatur','Hide keyboard')+'">⌄</button>';
  document.body.appendChild(kbar);
  function act(e){var x=e.target.closest('[data-k]');e.preventDefault();if(!x)return;var k=x.dataset.k,c=kbarCur();
    if(k==='done'){var a=document.activeElement;if(a&&a.blur)a.blur();kbarHide();return;}
    if(k==='undo'||k==='redo'){undo(k==='redo');return;}
    if(!c)return;c.b.html=norm(c.ed.innerHTML);
    if(k==='in'||k==='out'){indentBlock(c.b.id,k==='in'?1:-1);return;}
    if(k==='toggle'||k==='todo'){if(quickTurn([c.b.id],k))rerenderKeep();return;}
    if(k==='bullet'){op(function(){turnInto(c.b,c.b.type==='bullet'?'p':'bullet');});rerenderKeep();return;}
    if(k==='slash'||k==='at'){document.execCommand('insertText',false,k==='slash'?'/':'@');return;}
  }
  kbar.addEventListener('pointerdown',act);kbar.addEventListener('mousedown',function(e){e.preventDefault();});
  return kbar;
}
function kbarPos(){if(!kbar||!kbar.classList.contains('on'))return;var vv=window.visualViewport,h=kbar.offsetHeight;var top=vv?vv.offsetTop+vv.height-h:innerHeight-h;kbar.style.transform='translateY('+Math.round(top)+'px)';}
function kbarHide(){if(kbar)kbar.classList.remove('on');}
document.addEventListener('focusin',function(e){if(!S.built||!isActive()||!isTouchUI())return;if(e.target.closest&&e.target.closest('#nt-doc .nt-txt')){kbarBuild().classList.add('on');kbarPos();setTimeout(kbarPos,300);}});
document.addEventListener('focusout',function(){setTimeout(function(){var a=document.activeElement;if(!(a&&a.closest&&a.closest('#nt-doc .nt-txt')))kbarHide();},120);});
if(window.visualViewport){visualViewport.addEventListener('resize',kbarPos);visualViewport.addEventListener('scroll',kbarPos);}
function appHint(){ // i portalen på telefon: tilbyd den hurtige app-udgave
  if(window.NOTER_STANDALONE||innerWidth>=700)return;try{if(localStorage.getItem('nt_app_hint'))return;}catch(e){}
  if(document.getElementById('nt-apphint'))return;var d=document.createElement('div');d.id='nt-apphint';d.setAttribute('data-no-i18n','');
  d.style.cssText='position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:10040;background:#241f1a;color:#fff;border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:center;font-size:14px;box-shadow:0 8px 24px rgba(0,0,0,.25)';
  d.innerHTML='<span style="flex:1">📱 '+L('Brug Noter som app – hurtigere på telefonen','Use Notes as an app – faster on your phone')+'</span><a href="/noter'+H(location.hash)+'" style="background:#fff;color:#241f1a;border-radius:8px;padding:7px 12px;text-decoration:none;font-weight:600">'+L('Åbn','Open')+'</a><button style="background:transparent;border:0;color:#fff;font-size:18px" aria-label="Luk">✕</button>';
  d.querySelector('button').onclick=function(){d.remove();try{localStorage.setItem('nt_app_hint','1');}catch(e){}};document.body.appendChild(d);
}
window.NOTES={init:function(){build();fitHeight();appHint();init().then(function(){var app=$('#nt-app');try{if(localStorage.getItem('nt_side')==='off'&&innerWidth>=860)app.classList.add('nt-side-off');}catch(e){}});},leave:function(){flush();S.sel=[];selBar();S.msel=null;kbarHide();var ah=document.getElementById("nt-apphint");if(ah)ah.remove();},_S:S};
})();
