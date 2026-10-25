import { db, all, one, run, nextSeq, nowISO, j } from './db.mjs';
import { hashPassword } from './auth.mjs';
import { shortCode, token } from './auth.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './env.mjs';

const pad = (n) => String(n).padStart(2, '0');
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const QUOTES = [
  ['Education is not the filling of a pail, but the lighting of a fire.', '教育不是灌满一桶水，而是点燃一把火。', 'W. B. Yeats'],
  ['Tell me and I forget. Teach me and I remember. Involve me and I learn.', '告诉我，我会忘记；教我，我会记住；让我参与，我才能真正学会。', 'Benjamin Franklin'],
  ['The mediocre teacher tells. The good teacher explains. The superior teacher demonstrates. The great teacher inspires.', '平庸的老师讲述，好的老师解释，优秀的老师示范，伟大的老师启发。', 'William Arthur Ward'],
  ['It is the supreme art of the teacher to awaken joy in creative expression and knowledge.', '教师的最高艺术，是唤起学生在创造与知识中的喜悦。', 'Albert Einstein'],
  ['The beautiful thing about learning is that no one can take it away from you.', '学习最美的地方在于，没有人能把它从你手中拿走。', 'B.B. King'],
  ['A teacher affects eternity; he can never tell where his influence stops.', '教师的影响是永恒的，他永远不知道自己的影响止于何处。', 'Henry Adams'],
  ['The roots of education are bitter, but the fruit is sweet.', '教育的根是苦的，但果实是甜的。', 'Aristotle'],
  ['Live as if you were to die tomorrow. Learn as if you were to live forever.', '像明天就要死去一样生活，像永远活着一样学习。', 'Mahatma Gandhi'],
  ['The mind is not a vessel to be filled, but a fire to be kindled.', '头脑不是需要填满的容器，而是需要点燃的火焰。', 'Plutarch'],
  ['Success is the sum of small efforts, repeated day in and day out.', '成功是日复一日微小努力的总和。', 'Robert Collier'],
  ['Knowing is not enough; we must apply. Willing is not enough; we must do.', '知道还不够，我们必须应用；愿意还不够，我们必须行动。', 'Johann Wolfgang von Goethe'],
  ['The best way to predict the future is to create it.', '预测未来最好的方式，就是去创造它。', 'Peter Drucker'],
  ['Education is the most powerful weapon which you can use to change the world.', '教育是你用来改变世界最强大的武器。', 'Nelson Mandela'],
  ['Discipline is the bridge between goals and accomplishment.', '自律是目标与成就之间的桥梁。', 'Jim Rohn'],
  ['What we learn with pleasure we never forget.', '带着愉悦学到的，我们永远不会忘记。', 'Alfred Mercier'],
  ['Genius is one percent inspiration and ninety-nine percent perspiration.', '天才是百分之一的灵感加百分之九十九的汗水。', 'Thomas Edison'],
  ['The only way to do great work is to love what you do.', '做出伟大工作的唯一方法，就是热爱你所做的事。', 'Steve Jobs'],
  ['Patience is bitter, but its fruit is sweet.', '忍耐是苦的，但它的果实是甜的。', 'Jean-Jacques Rousseau'],
  ['Teaching is the one profession that creates all other professions.', '教师是创造出所有其他职业的那一个职业。', 'Unknown'],
  ['Small steps every day, lead to big changes every year.', '每天一小步，一年一大步。', 'Unknown'],
  ['The journey of a thousand miles begins with a single step.', '千里之行，始于足下。', 'Lao Tzu'],
  ['Curiosity is the wick in the candle of learning.', '好奇心是学习之烛的灯芯。', 'William Arthur Ward'],
  ['To teach is to learn twice.', '教，就是学两遍。', 'Joseph Joubert'],
  ['Every child is a different kind of flower, and all together make this world a beautiful garden.', '每个孩子都是不同的花，他们一起成就了这世界美丽的花园。', 'Unknown'],
  ['Do not wait for the perfect moment; take the moment and make it perfect.', '不要等待完美的时刻，抓住此刻并让它变得完美。', 'Unknown'],
  ['Great things are done by a series of small things brought together.', '伟大的事，是由一连串小事汇聚而成的。', 'Vincent van Gogh'],
  ['Learning never exhausts the mind.', '学习永远不会令头脑疲惫。', 'Leonardo da Vinci'],
  ['Courage is not the absence of fear, but the triumph over it.', '勇气不是没有恐惧，而是战胜恐惧。', 'Nelson Mandela'],
  ['The future belongs to those who believe in the beauty of their dreams.', '未来属于那些相信梦想之美的人。', 'Eleanor Roosevelt'],
  ['A calm sea never made a skilled sailor.', '平静的海面练不出熟练的水手。', 'Unknown'],
  ['You are never too old to set another goal or to dream a new dream.', '设立新目标、拥有新梦想，永远不嫌晚。', 'C. S. Lewis'],
  ['Excellence is not an act, but a habit.', '卓越不是一种行为，而是一种习惯。', 'Aristotle'],
  ['The more that you read, the more things you will know.', '你读得越多，知道的就越多。', 'Dr. Seuss'],
  ['Energy and persistence conquer all things.', '精力与坚持能征服一切。', 'Benjamin Franklin'],
  ['Where there is a will, there is a way.', '有志者，事竟成。', 'Proverb'],
  ['Slow and steady wins the race.', '稳扎稳打，方能取胜。', 'Aesop'],
];

const PUNISH = [
  ['表演才艺', '唱歌、朗诵或讲个笑话，30 秒', 'light'],
  ['背诵一句名言', '说出今天黑板上的每日名言英文', 'light'],
  ['领读课文', '带全班朗读今天的课文段落', 'average'],
  ['当小老师', '为大家讲解一道题', 'average'],
  ['总结知识点', '用一句话总结本节课重点', 'average'],
  ['回答加分题', '回答老师提出的拓展问题', 'average'],
  ['帮同学解答', '给同桌讲一遍刚才的题目', 'average'],
  ['下节课开头复盘', '下次课用 1 分钟回顾今天内容', 'heavy'],
  ['整理板书', '值日整理今天的板书与讲台', 'light'],
  ['英语自我介绍', '30 秒英文自我介绍', 'heavy'],
];

export function seedQuotes() {
  const cnt = one('SELECT COUNT(*) c FROM daily_quotes')?.c || 0;
  if (cnt > 0) return;
  const st = db.prepare('INSERT INTO daily_quotes(en,zh,author) VALUES(?,?,?)');
  for (const q of QUOTES) st.run(q[0], q[1], q[2]);
}

export function seedUserData(userId) {
  /* 防重复：原来只看 periods 表里有没有这个 userId 的节次。
     隐患是这个函数在**每次启动**时都会对已登录用户跑一遍，只要 periods 里
     恰好没有该 userId 的行（比如历史上灌数据用的 userId 已被清掉、或表被单独清过），
     就会天天重新灌一份，整份数据翻倍——2026-10-25 就是这么翻了一倍。
     现在改成多表连查：只要这个用户名下有任何一份种子数据，就认定灌过了。
     查不到表（旧库/精简库）直接跳过，不能因为一张表不存在就中断启动。 */
  const probes = [
    'SELECT COUNT(*) c FROM periods WHERE user_id=?',
    'SELECT COUNT(*) c FROM courses WHERE user_id=?',
    'SELECT COUNT(*) c FROM students WHERE user_id=?',
    'SELECT COUNT(*) c FROM categories WHERE user_id=?',
  ];
  for (const sql of probes) {
    try {
      if ((one(sql, userId)?.c || 0) > 0) return;
    } catch { /* 表不存在就当这条不适用 */ }
  }

  // 节次
  const periods = [
    [1, '第一节', '07:40', '08:25'],
    [2, '第二节', '08:35', '09:20'],
    [3, '第三节', '09:35', '10:20'],
    [4, '第四节', '10:30', '11:15'],
    [5, '第五节', '11:25', '12:10'],
    [6, '第六节', '14:20', '15:05'],
    [7, '第七节', '15:15', '16:00'],
    [8, '第八节', '16:10', '16:55'],
    [9, '晚自习一', '19:00', '19:45'],
    [10, '晚自习二', '19:55', '20:40'],
  ];
  const st = db.prepare('INSERT INTO periods(user_id,period_no,name,start_time,end_time,created_at) VALUES(?,?,?,?,?,?)');
  for (const p of periods) st.run(userId, p[0], p[1], p[2], p[3], nowISO());

  // 课表：周一~周五（高二年级 语文）
  const plan = {
    1: [[1, '高二(3)班'], [2, '高二(3)班'], [3, '高二(5)班'], [6, '高二(5)班']],
    2: [[1, '高二(5)班'], [4, '高二(3)班'], [7, '高二(3)班']],
    3: [[2, '高二(3)班'], [3, '高二(5)班'], [6, '高二(3)班'], [9, '高二(5)班']],
    4: [[1, '高二(5)班'], [5, '高二(3)班'], [7, '高二(5)班']],
    5: [[2, '高二(3)班'], [4, '高二(5)班'], [8, '高二(3)班']],
  };
  const cs = db.prepare(
    'INSERT INTO courses(user_id,weekday,period_no,start_time,end_time,grade,class_name,subject,room,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  );
  const colors = ['#3C7BF6', '#8B5CF6', '#0EA5A4', '#F59E0B', '#EC4899'];
  for (const [wd, rows] of Object.entries(plan)) {
    for (const [pn, cls] of rows) {
      const p = periods.find((x) => x[0] === pn);
      cs.run(userId, Number(wd), pn, p[2], p[3], '高二', cls, '语文', `教学楼${wd}0${pn % 5 + 1}`, nowISO());
    }
  }
  // 颜色在查询时按班级取色，不落库

  // 今日事项 / 提醒
  const today = new Date();
  const t = dstr(today);
  const nextDay = new Date(today); nextDay.setDate(today.getDate() + 1);
  const itemSt = db.prepare(
    `INSERT INTO items(user_id,seq,kind,title,detail,start_at,end_at,status,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
  );
  itemSt.run(userId, nextSeq('item:' + userId), '事项', '高二语文备课组会', '讨论下周《劝学》教学进度', `${t}T16:10`, `${t}T17:00`, 'todo', 'high', nowISO());
  itemSt.run(userId, nextSeq('item:' + userId), '任务', '提交十月课时统计表', '月底与财务核对课时', `${dstr(nextDay)}T09:00`, '', 'todo', 'urgent', nowISO());
  itemSt.run(userId, nextSeq('item:' + userId), '倒计时', '期中考试命题截止', '完成试卷与答题卡', `${dstr(new Date(today.getTime() + 5 * 864e5))}T18:00`, '', 'todo', 'high', nowISO());

  // 便签
  const todoSt = db.prepare('INSERT INTO todos(user_id,seq,title,status,created_at) VALUES(?,?,?,?,?)');
  todoSt.run(userId, nextSeq('todo:' + userId), '把月考答题卡交到教务处', 'todo', nowISO());
  todoSt.run(userId, nextSeq('todo:' + userId), '给(3)班准备《劝学》课件', 'doing', nowISO());
  todoSt.run(userId, nextSeq('todo:' + userId), '联系家长沟通作业情况', 'done', nowISO());

  // 学生名单（示例）
  const names = ['张一诺','李晨阳','王思远','赵梦琪','陈嘉禾','刘子涵','杨博文','黄雨桐','周轩宇','吴可欣',
    '徐若彤','孙浩然','马睿哲','朱怡然','胡佳隽','郭欣怡','何俊熙','高子昂','林书瑶','罗嘉颖',
    '郑亦航','梁泽宇','谢可儿','唐语晨','许亦辰','邓沐阳','冯婧仪','曹梓萱','彭一鸣','苏念安',
    '蒋若冰','韩子墨','沈知远','程嘉懿','陆星野','任以宁','袁清和','于书言','董晨曦','余乐彤'];
  const stuSt = db.prepare('INSERT INTO students(user_id,grade,class_name,name,no,created_at) VALUES(?,?,?,?,?,?)');
  let n = 0;
  for (const name of names) { n++; stuSt.run(userId, '高二', '高二(3)班', name, n, nowISO()); }

  let k = 0;
  for (const name of names.slice(0, 38)) {
    k++;
    stuSt.run(userId, '高二', '高二(5)班', name, k, nowISO());
  }

  // 分类
  const catSt = db.prepare('INSERT INTO categories(user_id,scope,name,sort,created_at) VALUES(?,?,?,?,?)');
  for (const [i, nm] of ['必修上册', '必修下册', '选择性必修', '作文素材', '试卷'].entries()) catSt.run(userId, 'material', nm, i, nowISO());
  for (const [i, nm] of ['教学资料', '课文解读', '教研记录', '学生问题'].entries()) catSt.run(userId, 'note', nm, i, nowISO());
  for (const [i, nm] of ['专业阅读', '通识', '英语提升', '教研培训'].entries()) catSt.run(userId, 'study', nm, i, nowISO());

  // 笔记
  const noteSt = db.prepare('INSERT INTO notes(user_id,seq,category_id,title,content,pinned,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const notes = [
    ['《劝学》教学设计', '## 教学目标\n1. 掌握"劝、学、青、中、疾、致、假、绝、兴、功、强、用"等重点实词\n2. 理解比喻论证、对比论证的方法\n3. 体会荀子"学不可以已"的思想\n\n## 教学重点\n比喻论证的内在逻辑：青出于蓝、冰寒于水……\n\n## 板书设计\n学不可以已 → 为什么学 → 怎么学 → 态度'],
    ['学生常见病句类型汇总', '1. 语序不当\n2. 搭配不当\n3. 成分残缺或赘余\n4. 结构混乱\n5. 表意不明\n6. 不合逻辑'],
    ['十月教研会记录', '时间：10 月 15 日\n地点：高二语文组办公室\n议题：期中考试范围与命题分工'],
  ];
  let ni = 0;
  for (const [title, content] of notes) {
    ni++;
    noteSt.run(userId, nextSeq('note:' + userId), one("SELECT id FROM categories WHERE user_id=? AND scope='note' LIMIT 1 OFFSET ?", userId, ni - 1)?.id || null, title, content, ni === 1 ? 1 : 0, nowISO(), nowISO());
  }

  // 学习记录
  const studySt = db.prepare('INSERT INTO studies(user_id,seq,date,category_id,title,content,minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 10; i++) {
    const d = new Date(today.getTime() - ((i * 2 + 1) % 20) * 864e5);
    studySt.run(userId, nextSeq('study:' + userId), dstr(d), null, i % 2 ? '读《语文学习任务设计》' : '《红楼梦》整本书阅读指导', '记录要点若干', 30 + (i % 4) * 15, nowISO(), nowISO());
  }

  // 惩罚库
  const puSt = db.prepare('INSERT INTO punishments(user_id,text,level,active,created_at) VALUES(?,?,?,1,?)');
  for (const p of PUNISH) puSt.run(userId, p[0] + '：' + p[1], p[2], nowISO());

  // 学生短链
  run('INSERT INTO student_links(user_id,code,title,grades,enabled,created_at) VALUES(?,?,?,?,1,?)',
    userId, shortCode(6), '高二语文资料站', JSON.stringify(['高二']), nowISO());

  // 点名用的班级人数（学生端「课堂点名」依赖它）
  const rosSt = db.prepare('INSERT INTO rosters(user_id,grade,class_name,count,names,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  rosSt.run(userId, '高二', '高二(3)班', 45, JSON.stringify(names), nowISO(), nowISO());
  rosSt.run(userId, '高二', '高二(5)班', 38, JSON.stringify(names.slice(0, 38)), nowISO(), nowISO());

  // 课件（带真实可下载的示例文件，学生端打开就能看）
  seedMaterials(userId);

  // 考勤表（教研签到 & 坐班）
  seedAttendance(userId);

  // 出差 & 监考示例
  run(`INSERT INTO invigilations(user_id,seq,date,type,person,subject,grade,start_at,end_at,minutes,amount,paid,place,need_paper,paper_place,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, nextSeq('invig:' + userId), dstr(today), '学校分配', '本人', '语文', '高二', `${t}T09:00`, `${t}T11:30`, 150, 0, 1, '实验楼 301', 1, '教务处资料室', nowISO());
  run(`INSERT INTO invigilations(user_id,seq,date,type,person,subject,grade,start_at,end_at,minutes,amount,paid,place,need_paper,paper_place,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, nextSeq('invig:' + userId), dstr(new Date(today.getTime() - 3 * 864e5)), '我代他人', '王老师', '数学', '高二', `${dstr(new Date(today.getTime() - 3 * 864e5))}T14:30`, `${dstr(new Date(today.getTime() - 3 * 864e5))}T16:00`, 90, 100, 0, '教学楼 205', 0, '', nowISO());

  run(`INSERT INTO trips(user_id,seq,start_date,end_date,from_place,to_place,reason,companions,km,toll,parking,other,status,remark,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    userId, nextSeq('trip:' + userId), dstr(new Date(today.getTime() - 10 * 864e5)), dstr(new Date(today.getTime() - 9 * 864e5)), '学校', '市教研室（江城区）', '高二语文命题培训', '李老师、陈老师', 86, 40, 15, 0, 'approved', '已完成报销', nowISO());
}

function seedAttendance(userId) {
  const t = new Date();
  const month = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
  const name3 = ['张老师','李老师','王老师','赵老师','陈老师','刘老师','杨老师','黄老师'];
  const tSt = db.prepare('INSERT INTO attendance_tables(user_id,kind,name,month,columns,meta,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  const colsResearch = [
    { key: 'date', label: '日期', type: 'text', w: 92 },
    { key: 'weekday', label: '星期', type: 'text', w: 56 },
    { key: 'sign_in', label: '签到时间', type: 'text', w: 88 },
    { key: 'sign_out', label: '签退时间', type: 'text', w: 88 },
    { key: 'place', label: '教研地点', type: 'text', w: 110 },
    { key: 'topic', label: '教研主题', type: 'text', w: 150 },
    { key: 'status', label: '状态', type: 'select', options: ['已参加','请假','缺席','公出'], w: 76 },
    { key: 'remark', label: '备注', type: 'text', w: 130 },
  ];
  const metaR = { title: '高二语文教研签到表', org: '高二年级组', owner: '语文备课组', signer: '年级主任' };
  const r = tSt.run(userId, 'research', '高二语文教研签到表', month, JSON.stringify(colsResearch), JSON.stringify(metaR), nowISO(), nowISO());
  const tid = Number(r.lastInsertRowid);
  const rowSt = db.prepare('INSERT INTO attendance_rows(table_id,teacher,data,sort,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  let sort = 0;
  for (const teacher of name3) {
    for (let i = 0; i < 4; i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), 2 + i * 7);
      if (d.getMonth() !== t.getMonth()) continue;
      const data = {
        date: dstr(d), weekday: '周' + ['日','一','二','三','四','五','六'][d.getDay()],
        sign_in: i === 2 && teacher === '赵老师' ? '' : '09:0' + (i % 6),
        sign_out: i === 2 && teacher === '赵老师' ? '' : '11:3' + (i % 6),
        place: '高二语文组办公室', topic: ['集体备课《劝学》','月考质量分析','作文批改标准','期中复习计划'][i],
        status: i === 2 && teacher === '赵老师' ? '缺席' : (i === 1 && teacher === '黄老师' ? '公出' : '已参加'),
        remark: i === 2 && teacher === '赵老师' ? '外出参加区里培训' : '',
      };
      rowSt.run(tid, teacher, JSON.stringify(data), sort++, nowISO(), nowISO());
    }
  }

  const colsSeat = [
    { key: 'date', label: '日期', type: 'text', w: 92 },
    { key: 'weekday', label: '星期', type: 'text', w: 56 },
    { key: 'morning', label: '上午坐班', type: 'select', options: ['是','否','请假','公出'], w: 82 },
    { key: 'afternoon', label: '下午坐班', type: 'select', options: ['是','否','请假','公出'], w: 82 },
    { key: 'evening', label: '晚自习', type: 'select', options: ['是','否','无'], w: 76 },
    { key: 'hours', label: '时长(h)', type: 'number', w: 70 },
    { key: 'remark', label: '缺勤原因', type: 'text', w: 150 },
  ];
  const metaS = { title: '高二教师坐班表', org: '高二年级组', owner: '年级组', signer: '年级主任' };
  const r2 = tSt.run(userId, 'seat', '高二教师坐班表', month, JSON.stringify(colsSeat), JSON.stringify(metaS), nowISO(), nowISO());
  const tid2 = Number(r2.lastInsertRowid);
  sort = 0;
  for (const teacher of name3) {
    for (let i = 0; i < 3; i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), 3 + i * 9);
      if (d.getMonth() !== t.getMonth()) continue;
      const data = {
        date: dstr(d), weekday: '周' + ['日','一','二','三','四','五','六'][d.getDay()],
        morning: i === 1 && teacher === '刘老师' ? '请假' : '是',
        afternoon: i === 1 && teacher === '刘老师' ? '否' : '是',
        evening: i === 2 ? '无' : '是', hours: i === 2 ? 6 : 8,
        remark: i === 1 && teacher === '刘老师' ? '病假（已报备）' : '',
      };
      rowSt.run(tid2, teacher, JSON.stringify(data), sort++, nowISO(), nowISO());
    }
  }
}

/* 课件示例：生成 3 个可直接下载的文件，学生端短链立刻有内容 */
export function seedMaterials(userId) {
  const cats = all("SELECT id,name FROM categories WHERE user_id=? AND scope='material' ORDER BY sort", userId);
  const catId = (nm) => cats.find((c) => c.name === nm)?.id || cats[0]?.id || null;
  const mats = [
    ['必修上册', '《劝学》第一课时课件', '高二', '高二(3)班', '导学案 + 课堂任务单，共 3 个附件', '劝学-导学案.md', '# 《劝学》导学案\n\n## 一、通假字\n- 輮以为轮（輮，通“煣”）\n- 虽有槁暴（有，通“又”；暴，通“曝”）\n\n## 二、词类活用\n- 木直中绳，輮以为轮（輮：动词的使动用法）\n\n## 三、思考题\n1. 作者为什么用“青出于蓝”开头？\n2. 与《师说》的说理方式有什么不同？\n'],
    ['选择性必修', '《红楼梦》整本书阅读任务单', '高二', '高二(5)班', '四周阅读计划与章节任务', '红楼梦任务单.md', '# 《红楼梦》整本书阅读任务单\n\n| 周次 | 回目 | 任务 |\n| --- | --- | --- |\n| 第 1 周 | 1-5 回 | 梳理贾府人物关系图 |\n| 第 2 周 | 6-20 回 | 摘抄 3 处细节描写并批注 |\n| 第 3 周 | 21-50 回 | 分析“黛玉进府”的叙事视角 |\n| 第 4 周 | 51-80 回 | 完成一篇 800 字读书笔记 |\n'],
    ['作文素材', '议论文素材积累（十月）', '高二', '', '分“家国”“坚持”“创新”三类，可直接背诵', '作文素材-十月.md', '# 议论文素材（十月）\n\n## 家国\n- 樊锦诗：半个世纪守护敦煌\n\n## 坚持\n- 苏炳添：32 岁跑出 9 秒 83\n\n## 创新\n- 屠呦呦：190 次失败后提取青蒿素\n'],
  ];
  const matSt = db.prepare('INSERT INTO materials(user_id,seq,category_id,title,grade,class_name,descr,public,created_at,updated_at) VALUES(?,?,?,?,?,?,?,1,?,?)');
  const attSt = db.prepare('INSERT INTO attachments(user_id,owner_type,owner_id,name,mime,size,path,created_at) VALUES(?,?,?,?,?,?,?,?)');
  const dir = path.join(CONFIG.uploadDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  for (const [cat, title, grade, cls, descr, fname, content] of mats) {
    const r = matSt.run(userId, nextSeq('material:' + userId), catId(cat), title, grade, cls, descr, nowISO(), nowISO());
    const id = Number(r.lastInsertRowid);
    const fpath = path.join(dir, `seed-${id}-${fname}`);
    fs.writeFileSync(fpath, content, 'utf8');
    attSt.run(userId, 'material', id, fname, 'text/markdown; charset=utf-8', Buffer.byteLength(content), fpath, nowISO());
  }
}
