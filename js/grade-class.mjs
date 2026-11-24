/* ==================== 年级 / 班级：全站统一口径 ====================
   约定（2026-11-23 与用户确认）：
     - 年级字段的值就是「高一」「高二」「高三」，不带「年级」二字
     - 班级字段的值就是「5班」，不带年级前缀
     - 展示时行内只显示班号，年级靠筛选器或分组头体现
   历史数据里混着「高二5班」「高二(5)班」「高二 5 班」「5」「05」这些写法，
   统一走这里归一。读写两侧都过一遍，就不会再长出新的脏值。

   这是个零依赖的纯模块：core.js（展示）、localapi.js（学生端数据）、
   localdb.js（写入兜底）都从这里取，避免三份实现走偏。
   localdb.js 直接 import 会成环（localdb ← localapi ← core），所以它是
   单向被依赖的最低层，谁都可以引。 */

const GRADE_HEAD = /^(高[一二三]|初[一二三])/;

/* 年级归一：「高二年级」→「高二」，「高二 」→「高二」。
   「七年级」这种原样保留，认不出来的也不硬改（别把老师的自定义年级抹掉）。 */
export const normGrade = (raw) => {
  const s = String(raw ?? '').replace(/[\s()（）]/g, '');
  if (!s) return '';
  const m = s.match(GRADE_HEAD);
  if (m) return m[1];
  return s;
};

/* 从混杂值里抠出年级：「高二5班」→「高二」。抠不出返回空串。 */
export const inferGrade = (raw) => {
  const m = String(raw ?? '').match(/(高[一二三]|初[一二三])/);
  return m ? m[1] : '';
};

/* 班号归一：「高二(5)班」「高二 5 班」「5」「05班」→「5班」。
   非数字班名（「实验班」）原样保留，只剥掉年级前后缀。
   注意剥的是**任何**年级前缀，不只是 grade 形参那个 —— 老师把 grade 填成「高三」、
   班级却写着「高二5班」时，也得归到「5班」，不能原样吐回去。 */
export const normClass = (raw, grade = '') => {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/(高[一二三]|初[一二三])/g, '');
  const g = normGrade(grade);
  if (g) s = s.split(g).join('');
  s = s.replace(/[\s()（）]/g, '');
  const m = s.match(/^(\d{1,2})班?$/);
  if (m) return String(Number(m[1])) + '班';
  return s;
};

/* 展示用：班级短名，只有班号。年级和班级都空时返回空串。 */
export const clsShort = (grade, cls) => normClass(cls, grade) || normGrade(grade);

/* 展示用：确实需要年级上下文的地方（回收站、跨年级汇总）用「高二 · 5班」。 */
export const clsPair = (grade, cls) => {
  const g = normGrade(grade) || inferGrade(cls);
  const c = normClass(cls, g);
  if (!g) return c;
  if (!c) return g;
  return g + ' · ' + c;
};

/* 存储用：没有 grade 列的表（exceptions / punish_records / homework_records / preps）
   只能靠 class_name 保存完整信息，写成「高二5班」不分家，展示时再 clsShort 剥开。
   这样以后补 grade 列也能无歧义地拆回来。 */
export const clsStore = (grade, cls) => {
  const g = normGrade(grade) || inferGrade(cls);
  const c = normClass(cls, g);
  if (!c) return g;
  if (!g) return c;
  return g + c;
};

/* 年级固定顺序：分组、下拉、排序都用它，避免「高三」排到「高一」前面 */
export const GRADE_ORDER = ['高一', '高二', '高三', '初一', '初二', '初三'];
export const gradeRank = (g) => {
  const i = GRADE_ORDER.indexOf(normGrade(g));
  return i < 0 ? 99 : i;
};

/* 给一批班级生成展示标签：
   班号不重名就只给「5班」（用户要的口径），
   出现「高二3班 / 高三3班」这种**同班号跨年级**时，才退回「高二 · 3班」。
   注意按「有多少个不同年级用了这个班号」判断，不是数出现次数 ——
   同一个班在名单和违纪记录里各出现一次，那还是同一个班，不该带年级。
   rows 传该列表当前能看到的全部班级，labeler 再对单条求值。 */
export const makeClsLabeler = (rows) => {
  const gradesByClass = new Map();
  for (const r of rows || []) {
    const g = normGrade(r?.grade) || inferGrade(r?.class_name);
    const c = normClass(r?.class_name, r?.grade);
    if (!c) continue;
    if (!gradesByClass.has(c)) gradesByClass.set(c, new Set());
    gradesByClass.get(c).add(g || '');
  }
  return (grade, cls) => {
    const g = normGrade(grade) || inferGrade(cls);
    const c = normClass(cls, grade);
    if (!c) return g;
    const set = gradesByClass.get(c);
    return set && set.size > 1 && g ? `${g} · ${c}` : c;
  };
};
