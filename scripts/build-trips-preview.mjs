import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [domain,ui,css]=await Promise.all(['js/trips-domain.mjs','js/trips.js','css/trips-redesign.css'].map(file=>readFile(path.join(root,file),'utf8')));
// The preview uses the same renderer and rules, with an in-memory API adapter.
const adapter=String.raw`
const el=html=>{const template=document.createElement('template');template.innerHTML=html.trim();return template.content.firstElementChild;};
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ymd=(date=new Date())=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
const toast=(message)=>{const node=document.getElementById('preview-toast');node.textContent=message;clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>node.textContent='',4500);};
const confirmDialog=async message=>window.confirm(message);
const saveBlob=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);};
function sheet({title,body,footer,onClose,cls}){const wrap=el('<div class="sheet-mask in"><div class="sheet '+cls+'"><header class="sheet-head"><strong class="sheet-title"></strong><button class="sheet-close" aria-label="关闭">×</button></header><div class="sheet-body"></div>'+(footer?'<div class="sheet-foot"></div>':'')+'</div></div>');wrap.querySelector('.sheet-title').textContent=title;wrap.querySelector('.sheet-body').append(body);if(footer)wrap.querySelector('.sheet-foot').append(footer);const previous=document.activeElement;let closed=false;const close=()=>{if(closed)return;closed=true;wrap.remove();document.removeEventListener('keydown',key);onClose?.();previous?.focus();};const key=event=>{if(event.key==='Escape')close();};wrap.querySelector('.sheet-close').onclick=close;wrap.onclick=event=>{if(event.target===wrap)close();};document.addEventListener('keydown',key);document.body.append(wrap);wrap.querySelector('input,select,textarea,button')?.focus();return{wrap,close};}
const sampleMonth=ymd().slice(0,7);
let sampleRows=[{id:1,start_date:sampleMonth+'-05',from_place:'学校',to_place:'咸丰教育局',reason:'送高考资料',companions:'邹龙、袁正涛主任',is_driving:1,driver:'邹龙',km:20,total_amount:140,remark:''}];
let nextId=2;
const api={get:async(url)=>url==='/trips'?sampleRows.map(row=>({...row})):url==='/attachments'?[]:{...sampleRows.find(row=>String(row.id)===url.split('/').pop()),items:[]},post:async(url,body)=>{if(url==='/trips/bulk'){for(const values of body.rows)sampleRows.push({...values,id:nextId++});return{ids:body.rows.map(()=>nextId-1)};}const row={...body,id:nextId++};sampleRows.push(row);return row;},patch:async(url,body)=>{const id=url.split('/').pop(),row=sampleRows.find(row=>String(row.id)===id);Object.assign(row,body);return row;},del:async(url)=>{sampleRows=sampleRows.filter(row=>String(row.id)!==url.split('/').pop());return{ok:true};}};
`;
const html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>出差管理</title><style>'+String.raw`
:root{font-family:"Microsoft YaHei",sans-serif;color:#1f2937;background:#f5f7fa;--card:#fff;--card-2:#f9fafb;--line:#e5e7eb;--text:#1f2937;--text-2:#6b7280}*{box-sizing:border-box}body{margin:0;padding:24px}#app{max-width:1440px;margin:auto}.sheet-mask{position:fixed;inset:0;background:#0006;z-index:300;display:flex;align-items:center;justify-content:center;padding:16px}.sheet{display:flex;flex-direction:column;background:white;border-radius:8px;overflow:hidden;box-shadow:0 18px 60px #0003}.sheet-head{display:flex;align-items:center;justify-content:space-between}.sheet-title{font-size:18px}.sheet-close{border:0!important;font-size:22px!important;padding:0 5px!important}.sheet-foot{border-top:1px solid #e5e7eb}.sheet-body{overflow:auto}#preview-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:90%;background:#1f2937;color:white;border-radius:6px;padding:10px 16px;z-index:600;font-size:13px}#preview-toast:empty{display:none}@media(max-width:700px){body{padding:16px}}
`+css+'</style></head><body><main id="app"></main><div id="preview-toast" role="status"></div><script type="module">'+adapter+'\n'+domain.replace(/^export /gm,'')+'\n'+ui.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'')+'\nrenderTripManagement(document.getElementById("app"));</script></body></html>';
await mkdir(path.join(root,'previews'),{recursive:true});
await writeFile(path.join(root,'previews','出差管理.html'),html);
console.log(path.join(root,'previews','出差管理.html'));
