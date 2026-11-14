export const JOURNAL_PREFIX = 'wb_sync_journal_v1:';
export function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (a,b) => stableJson(a) === stableJson(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyed = value => Array.isArray(value) && value.every(row=>object(row)&&row.id!=null) && new Set(value.map(row=>String(row.id))).size===value.length;

// Merge business fields against a common acknowledged base, never by timestamps.
export function mergeSnapshots(base, local, remote) {
  const conflicts=[];
  const visit=(before,mine,theirs,path)=>{
    if(equal(mine,theirs))return copy(mine);
    if(equal(mine,before))return copy(theirs);
    if(equal(theirs,before))return copy(mine);
    if(path[0]==='seqs'&&Number.isFinite(mine)&&Number.isFinite(theirs))return Math.max(mine,theirs);
    if(path.at(-1)==='updated_at'&&typeof mine==='string'&&typeof theirs==='string')return mine>theirs?mine:theirs;
    if(keyed(before)&&keyed(mine)&&keyed(theirs)){
      const maps=[before,mine,theirs].map(rows=>new Map(rows.map(row=>[String(row.id),row])));
      const ids=[...new Set([...theirs,...mine,...before].map(row=>String(row.id)))];
      return ids.map(id=>visit(maps[0].get(id),maps[1].get(id),maps[2].get(id),[...path,'@id:'+id])).filter(row=>row!==undefined);
    }
    const deletedVersusEdited=object(before)&&object(mine)&&object(theirs)
      && ((!!mine.deleted_at!==!!before.deleted_at && !equal(theirs,before)) || (!!theirs.deleted_at!==!!before.deleted_at && !equal(mine,before)));
    if(object(before)&&object(mine)&&object(theirs)&&!deletedVersusEdited){
      const entries=[];
      for(const key of new Set([...Object.keys(before),...Object.keys(mine),...Object.keys(theirs)])){
        const value=visit(before[key],mine[key],theirs[key],[...path,key]);if(value!==undefined)entries.push([key,value]);
      }
      return Object.fromEntries(entries);
    }
    conflicts.push({path,base:copy(before),local:copy(mine),remote:copy(theirs)});
    return copy(mine);
  };
  return {payload:visit(base,local,remote,[]),conflicts};
}
export function applyConflictChoices(payload, conflicts, choices) {
  let result=copy(payload);
  for(const conflict of conflicts){
    const choice=choices[JSON.stringify(conflict.path)];
    if(!['local','remote'].includes(choice))throw Error('请为每一处冲突选择保留的内容');
    const value=copy(conflict[choice]);
    if(!conflict.path.length){result=value;continue;}
    let target=result;
    const find=(node,key)=>key.startsWith('@id:')&&Array.isArray(node)?node.find(row=>String(row.id)===key.slice(4)):node[key];
    for(const key of conflict.path.slice(0,-1))target=find(target,key);
    const key=conflict.path.at(-1);
    if(Array.isArray(target)&&key.startsWith('@id:')){
      const index=target.findIndex(row=>String(row.id)===key.slice(4));
      if(value===undefined){if(index>=0)target.splice(index,1);}else if(index>=0)target[index]=value;else target.push(value);
    }else if(value===undefined)delete target[key];else Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});
  }
  return result;
}
export function readJournal(storage, uid) {
  const raw=storage.getItem(JOURNAL_PREFIX+uid);if(!raw)return null;
  const journal=JSON.parse(raw);
  if(journal.version!==1||journal.uid!==uid||!object(journal.base))throw Error('本机待同步记录无法读取，已停止同步以保护数据');
  return journal;
}
export function writeJournal(storage, uid, {base,draft=null,revision=0,conflicts=[],sent=null}) {
  const journal={version:1,uid,base,draft,revision,conflicts,sent,updated_at:new Date().toISOString()};
  storage.setItem(JOURNAL_PREFIX+uid,JSON.stringify(journal));
  return journal;
}
export const LOCAL_DRAFT_PREFIX='wb_sync_local_draft:';
export function localDrafts(storage,uid) {
  const drafts=[];
  for(let index=0;index<storage.length;index++){
    const key=storage.key(index);if(!key?.startsWith(LOCAL_DRAFT_PREFIX+uid+':'))continue;
    try{const record=JSON.parse(storage.getItem(key));if(record.uid===uid)drafts.push({...record,key});}catch{}
  }
  return drafts.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
}
