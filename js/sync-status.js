import {el,esc,toast,sheet,saveBlob} from './core.js';
import {activeAccountId} from './localdb.js';
import {getAccountSyncStatus,getSyncConflicts,retryAccountSync,resolveAccountSyncConflicts,exportPendingSync} from './cloudsync.js';

const LABELS={notes:'笔记',todos:'便签',items:'今日事项',studies:'学习记录',materials:'课件',teachers:'教师',courses:'课程',meta:'个人信息和设置',settings:'设置',title:'标题',content:'内容',status:'状态',remark:'备注',date:'日期',name:'姓名',subject:'学科',grade:'年级'};
const preview=value=>value===undefined?'（已删除）':value===null?'（空）':typeof value==='string'?value:JSON.stringify(value,null,2);
function downloadBackup() {
  try{saveBlob(new Blob([JSON.stringify(exportPendingSync(),null,2)],{type:'application/json'}),'工作台待同步备份-'+new Date().toISOString().slice(0,10)+'.json');}
  catch(error){toast(error.message||'备份导出失败','err');}
}
function openConflicts() {
  const conflicts=getSyncConflicts();
  if(!conflicts.length){void retryAccountSync().catch(error=>toast(error.message,'err'));return;}
  const whole=conflicts.some(item=>!item.path.length);
  const body=el('<div class="sync-conflicts"><p>两边内容均已保留。请逐项选择保留内容；未冲突的修改会一起保留。</p>'+(whole?'<p class="sync-conflict-warning">此处缺少可靠的共同版本，需要选择整份副本。请先导出备份；确认时还会在本机保留两份恢复副本。</p>':'')+conflicts.map((item,index)=>'<section><h3>'+esc(item.path.length?item.path.map(part=>part.startsWith('@id:')?'记录 '+part.slice(4):LABELS[part]||part).join(' · '):'工作台副本')+'</h3><div class="sync-compare"><div><strong>本机修改</strong><pre>'+esc(preview(item.local).slice(0,5000))+'</pre></div><div><strong>云端 / 其他标签页</strong><pre>'+esc(preview(item.remote).slice(0,5000))+'</pre></div></div><label for="sync-choice-'+index+'">保留哪一份内容</label><select id="sync-choice-'+index+'" data-sync-choice="'+index+'"><option value="">请选择</option><option value="local">本机修改</option><option value="remote">云端 / 其他标签页</option></select></section>').join('')+(whole?'<label class="sync-whole-confirm"><input type="checkbox" id="sync-whole-confirm">我已核对，确认本次选择的是整份工作台副本</label>':'')+'</div>');
  const footer=el('<div class="sync-dialog-actions"><button class="btn ghost" data-sync-export>导出本机备份</button><button class="btn ghost" data-sync-cancel>稍后处理</button><button class="btn primary" data-sync-apply>确认选择并同步</button></div>');
  const dialog=sheet({title:'处理同步冲突',body,footer,wide:true,cls:'sync-conflict-sheet'});
  footer.querySelector('[data-sync-export]').onclick=downloadBackup;
  footer.querySelector('[data-sync-cancel]').onclick=dialog.close;
  footer.querySelector('[data-sync-apply]').onclick=async event=>{
    const choices={};
    for(let index=0;index<conflicts.length;index++){
      const select=body.querySelector('[data-sync-choice="'+index+'"]');
      if(!select.value){select.focus();toast('请为每一处冲突选择保留内容','warn');return;}
      choices[JSON.stringify(conflicts[index].path)]=select.value;
    }
    if(whole&&!body.querySelector('#sync-whole-confirm').checked){toast('请先核对并勾选整份副本确认','warn');return;}
    const button=event.currentTarget;button.disabled=true;
    try{await resolveAccountSyncConflicts(choices);dialog.close();toast('冲突选择已保存','ok');}
    catch(error){toast(error.message||'同步未完成，本机副本仍保留','err');dialog.close();}
    finally{button.disabled=false;}
  };
}
let autoResolvedSignature='';
/* 2026-11-14：冲突也不再弹提示。出现冲突时自动保留「本机这一份」并继续同步，
   云端旧副本会写进 wb_sync_resolution_backup 备份键，需要时可找回。 */
async function autoResolveConflicts(){
  const conflicts=getSyncConflicts();
  if(!conflicts.length)return;
  const signature=JSON.stringify(conflicts.map(item=>item.path));
  if(signature===autoResolvedSignature)return;
  autoResolvedSignature=signature;
  const choices={};
  conflicts.forEach(item=>{choices[JSON.stringify(item.path)]='local';});
  try{await resolveAccountSyncConflicts(choices);}
  catch(error){console.warn('[sync] 自动处理冲突失败，本机内容已保留',error);}
}
export function startSyncStatus() {
  let current=getAccountSyncStatus();
  const paint=()=>{
    let host=document.getElementById('wb-sync-status');
    /* 2026-11-14：右下角状态条彻底不显示，所有状态（等待/同步中/离线/失败/冲突）都后台静默处理。 */
    host?.remove();
    if(current?.uid&&current.uid===activeAccountId()&&current.status==='conflict')void autoResolveConflicts();
    return;
  };
  window.addEventListener('wb:sync-status',event=>{current=event.detail;paint();});
  window.addEventListener('wb:signout',()=>{current=null;paint();});
  paint();
}
