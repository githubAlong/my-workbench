const SUBJECTS = [
  '信息技术', '通用技术', '劳动技术', '心理健康', '综合实践', '语文', '数学', '英语',
  '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '科学', '信息', '心理', '日语', '俄语'
];
const STOP_WORDS = new Set(['姓名','名字','学科','序号','编号','教师','老师','教师名单','教师名册','花名册','合计','小计','总计','备注','说明','年级','班级','星期','日期','签到','上课','坐班','听课','教研','请假','高一','高二','高三']);
const COMMON_SURNAMES = new Set(Array.from('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程嵇邢滑裴陆荣翁荀羊惠甄曲家封芮储靳汲松井段富焦巴牧山谷车侯全班仰秋仲伊宫宁仇甘厉戎祖武符刘景詹束龙叶幸向古易慎戈廖庾终居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙养鞠须丰巢关蒯相查后荆红游竺权逯盖益桓公万俟司马上官欧阳太史端木呼延西门南宫诸葛东方独孤慕容司徒司空皇甫尉迟公孙仲孙轩辕令狐钟离宇文长孙鲜于闾丘司寇子车颛孙公良拓跋夹谷宰父谷梁晋楚闫法汝鄢羊舌微生岳帅缑亢况梁丘左丘东门商牟佘佴伯赏墨哈谯笪年爱阳佟第五言福'));
const COMPOUND_SURNAMES = ['欧阳','司马','上官','诸葛','夏侯','皇甫','尉迟','公羊','公孙','慕容','令狐','钟离','宇文','长孙','司徒','司空','东方','赫连','濮阳','淳于','单于','太叔','申屠','轩辕','百里','南宫','第五'];
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
function boundsOf(word) {
  const box = word?.bbox || {};
  const x0 = Number(box.x0), y0 = Number(box.y0), x1 = Number(box.x1), y1 = Number(box.y1);
  if (![x0,y0,x1,y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1, cx: (x0+x1)/2, cy: (y0+y1)/2, width: x1-x0, height: y1-y0 };
}
function normalizeText(value) {
  return String(value || '').replace(/[０-９]/g, ch => String(ch.charCodeAt(0)-0xff10)).trim();
}
function cleanName(value, subject = '') {
  let text = normalizeText(value);
  if (subject) text = text.replaceAll(subject, '');
  for (const word of STOP_WORDS) text = text.replaceAll(word, '');
  const name = text.replace(/[0-9\s\p{P}\p{S}]/gu, '').replace(/[^\u3400-\u9fff]/g, '');
  if (name.length < 2) return '';
  for (let length = Math.min(4,name.length); length >= 2; length -= 1) {
    const candidate=name.slice(-length);
    if (STOP_WORDS.has(candidate)) continue;
    if (length === 4 && COMPOUND_SURNAMES.some(surname=>candidate.startsWith(surname))) return candidate;
    if (COMMON_SURNAMES.has(candidate[0])) return candidate;
    if (length >= 3 && COMMON_SURNAMES.has(candidate[1])) return candidate.slice(1);
  }
  return '';
}
function findSubject(value) {
  const text = normalizeText(value).replace(/\s+/g, '');
  return [...SUBJECTS].sort((a,b)=>b.length-a.length).find(subject=>text.includes(subject)) || '';
}
function parseExactSerial(value, max = 999) {
  const text = normalizeText(value).replace(/^[^0-9]+|[^0-9]+$/g, '');
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= max ? n : null;
}
function clusterByRow(items, imageHeight) {
  if (!items.length) return [];
  const heights = items.map(x=>x.box.height).filter(x=>x>0);
  const tolerance = Math.max(10, median(heights)*0.9, imageHeight*0.004);
  const clusters=[];
  for (const item of [...items].sort((a,b)=>a.box.cy-b.box.cy)) {
    let target=clusters[clusters.length-1];
    if (!target || Math.abs(item.box.cy-target.cy)>tolerance) {
      target={cy:item.box.cy,items:[]}; clusters.push(target);
    }
    target.items.push(item);
    target.cy=target.items.reduce((sum,x)=>sum+x.box.cy,0)/target.items.length;
  }
  return clusters;
}
function parseCluster(cluster, side, rowIndex) {
  const items=[...cluster.items].sort((a,b)=>a.box.cx-b.box.cx);
  let anchor=null;
  // Tesseract sometimes splits a two-character subject (e.g. 语文) into
  // separate word boxes. Join short adjacent runs before looking it up.
  for(let end=items.length-1;end>=0&&!anchor;end--) {
    for(let start=end;start>=Math.max(0,end-3);start--) {
      const text=items.slice(start,end+1).map(x=>x.text).join('');
      const subject=findSubject(text);
      if(subject){anchor={start,end,subject};break;}
    }
  }
  if(!anchor) return null;
  const before=items.slice(0,anchor.start);
  const subjectText=items.slice(anchor.start,anchor.end+1).map(x=>x.text).join('');
  let name=cleanName(before.map(x=>x.text).join(''),anchor.subject);
  if(!name) name=cleanName(subjectText,anchor.subject);
  if(!name) {
    const after=items.slice(anchor.end+1);
    name=cleanName(after.map(x=>x.text).join(''),anchor.subject);
  }
  if(!name) return null;
  const serialItem=before.filter(x=>parseExactSerial(x.text)!==null).sort((a,b)=>a.box.cx-b.box.cx)[0];
  const detectedSerial=serialItem ? parseExactSerial(serialItem.text) : null;
  const scores=items.map(x=>x.confidence).filter(x=>Number.isFinite(x));
  const confidence=scores.length?Math.max(0,Math.min(1,median(scores)/100)):0;
  return { name, subject:anchor.subject, side, rowIndex, detectedSerial, confidence, serialSource:detectedSerial===null?'position':'ocr', needsReview: confidence<0.65 };
}
function hasReliableSerialSequence(rows, minimumStart = 1) {
  const detected=rows.map(row=>row.detectedSerial).filter(value=>value!==null);
  if(detected.length < Math.max(2,Math.ceil(rows.length*0.6))) return false;
  if(new Set(detected).size/detected.length < 0.9) return false;
  if(detected[0] < minimumStart) return false;
  return detected.every((value,index)=>index===0||value>detected[index-1]);
}
function assignSideSerials(rows, base, trustDetected) {
  const used=new Set(trustDetected?rows.map(row=>row.detectedSerial).filter(value=>value!==null):[]);
  let next=base;
  return rows.map(row=>{
    let serial=trustDetected&&row.detectedSerial!==null?row.detectedSerial:null;
    if(serial===null){
      while(used.has(next)) next+=1;
      serial=next;
      used.add(serial);
      next+=1;
    } else {
      next=Math.max(next,serial+1);
    }
    return {...row,serial,serialSource:row.detectedSerial===serial?'ocr':'position',needsReview:row.needsReview||row.detectedSerial!==serial};
  });
}

export function extractRosterRowsFromTesseract(words, imageWidth, imageHeight, config={}) {
  const items=(Array.isArray(words)?words:[]).map(word=>({text:String(word?.text||'').trim(),confidence:Number(word?.confidence)||0,box:boundsOf(word)}))
    .filter(item=>item.text&&item.box);
  if (!items.length || !(imageWidth>0) || !(imageHeight>0)) return [];
  const halves={left:[],right:[]};
  for(const item of items) {
    // Ignore page-spanning title/notes; the name/subject cells are much narrower.
    if(item.box.width>=imageWidth*0.58) continue;
    halves[item.box.cx<imageWidth/2?'left':'right'].push(item);
  }
  const parsed={left:[],right:[]};
  for(const side of ['left','right']) {
    const clusters=clusterByRow(halves[side],imageHeight);
    for(const cluster of clusters) {
      const row=parseCluster(cluster,side,parsed[side].length);
      if(row) parsed[side].push(row);
    }
  }
  const leftCount=parsed.left.length;
  const rightFallback=leftCount+1;
  const leftReliable=hasReliableSerialSequence(parsed.left,1);
  const rightReliable=hasReliableSerialSequence(parsed.right,rightFallback);
  const rows=[
    ...assignSideSerials(parsed.left,1,leftReliable).map(row=>({...row,side:'left'})),
    ...assignSideSerials(parsed.right,rightFallback,rightReliable).map(row=>({...row,side:'right'})),
  ];
  // The paper is read left column top-to-bottom, then right column top-to-bottom.
  rows.sort((a,b)=>a.serial-b.serial || (a.side==='left'?-1:1));
  return rows;
}

export function buildRosterReviewRows(rows, expectedCount = null, leftGroupCount = null) {
  const source=Array.isArray(rows)?rows.map(row=>({...row})): [];
  const count=Math.max(0,Number(expectedCount)||source.reduce((m,row)=>Math.max(m,Number(row.serial)||0),source.length));
  const leftCount=Math.max(0,Number(leftGroupCount)||Math.ceil(count/2));
  const bySerial=new Map();
  for(const row of source) {
    const serial=Number(row.serial);
    if(Number.isInteger(serial)&&serial>=1&&serial<=count) {
      if(!bySerial.has(serial)) bySerial.set(serial,[]);
      bySerial.get(serial).push(row);
    }
  }
  const output=[];
  for(let serial=1;serial<=count;serial++) {
    const matches=bySerial.get(serial);
    if(matches?.length) output.push(...matches);
    else output.push({serial,name:'',subject:'',side:serial<=leftCount?'left':'right',serialSource:'template',confidence:0,needsReview:true});
  }
  return output;
}

export function validateRosterRows(rows, expectedCount) {
  const list=Array.isArray(rows)?rows: [];
  const count=Math.max(0,Number(expectedCount)||list.length);
  const serials=list.map(row=>Number(row.serial));
  const duplicateSerials=[...new Set(serials.filter((serial,index)=>serials.indexOf(serial)!==index))].sort((a,b)=>a-b);
  const present=new Set(serials);
  const missingSerials=Array.from({length:count},(_,i)=>i+1).filter(serial=>!present.has(serial));
  const incompleteSerials=list.filter(row=>!String(row.name||'').trim()||!String(row.subject||'').trim()).map(row=>Number(row.serial));
  const completeCount=list.filter(row=>/^[\u3400-\u9fff]{2,4}$/.test(String(row.name||'').trim())&&String(row.subject||'').trim()).length;
  return {expectedCount:count,totalRows:list.length,completeCount,duplicateSerials,missingSerials,incompleteSerials,valid:list.length===count&&completeCount===count&&duplicateSerials.length===0&&missingSerials.length===0&&incompleteSerials.length===0};
}

export function inferExpectedCount(rows, knownCount = 0) {
  if (Number(knownCount)>0) return Number(knownCount);
  const list=Array.isArray(rows)?rows: [];
  return list.reduce((max,row)=>Math.max(max,Number(row.serial)||0),list.length);
}

export function inferKnownRosterCount(gradeHint, text) {
  const grade=String(gradeHint||'');
  const source=String(text||'');
  // 这所学校提供的模板人数：高一46；高二坐班54；高二教研签到52条原始记录。
  // 教研表的序号按学科分组重置，识别结果会重新编号，但仍按原表总行数核对。
  if (grade.includes('高一') || /高一.*(坐班|教研|签到)/.test(source)) return 46;
  if (grade.includes('高二') && /教研|签到/.test(source)) return 52;
  if (grade.includes('高二') || /高二.*坐班/.test(source)) return 54;
  return 0;
}
