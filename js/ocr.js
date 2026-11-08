/*
 * 教师花名册 OCR
 * 使用浏览器端 Tesseract.js 中文模型。照片仅在本机浏览器处理。
 *
 * 重要：花名册识别不能以“识别到多少汉字”作为成功标准。
 * 只有提取到可信的“中文姓名 + 已知学科”组合才会返回名单；
 * 表头、星期、考勤项目、备注等文字一律不作为教师姓名。
 */

import { extractRosterRowsFromTesseract, buildRosterReviewRows, validateRosterRows, inferKnownRosterCount } from './roster-photo-parser.mjs';

const CDN_OPTIONS = [
  {
    script: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
    worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.0.0',
  },
  {
    script: 'https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js',
    worker: 'https://unpkg.com/tesseract.js@5.1.1/dist/worker.min.js',
    core: 'https://unpkg.com/tesseract.js-core@5.0.0',
  },
];

const LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
const SUBJECTS = [
  '信息技术', '通用技术', '劳动技术', '心理健康', '综合实践',
  '语文', '数学', '英语', '物理', '化学', '生物',
  '政治', '历史', '地理', '体育', '音乐', '美术', '科学',
];
const STOP_WORDS = new Set([
  '姓名', '名字', '学科', '序号', '编号', '教师', '老师',
  '教师名单', '教师名册', '花名册', '合计', '小计', '总计',
  '备注', '说明', '年级', '班级', '星期', '日期', '签到',
  '上课', '坐班', '听课', '教研', '请假', '高一', '高二', '高三',
]);
const COMMON_SURNAMES = new Set(Array.from(
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯管卢莫经房裘干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程嵇邢滑裴陆荣翁荀羊惠甄曲家封芮储靳汲松井段富焦巴牧山谷车侯全班仰秋仲伊宫宁仇甘厉戎祖武符刘景詹束龙叶幸向古易慎戈廖庾终居衡步都耿满弘匡国文寇广东欧司马欧阳上官诸葛夏侯皇甫尉迟公羊公孙慕容令狐钟离宇文长孙司徒司空东方闻人赫连濮阳淳于单于太叔申屠轩辕百里南宫第五',
));

let libraryPromise = null;
let workerPromise = null;
let worker = null;
let activeCdn = null;
let progressHandler = () => {};

function report(message) {
  try { progressHandler(String(message || '正在识别…')); } catch (_) {}
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const timer = setTimeout(() => finish(new Error('加载识别组件超时')), 25000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (error) { script.remove(); reject(error); } else resolve();
    }
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => finish();
    script.onerror = () => finish(new Error('识别组件下载失败'));
    document.head.appendChild(script);
  });
}

async function loadLibrary() {
  if (window.Tesseract && typeof window.Tesseract.createWorker === 'function') {
    return { api: window.Tesseract, cdn: activeCdn || CDN_OPTIONS[0] };
  }
  if (!libraryPromise) {
    libraryPromise = (async () => {
      let lastError = null;
      for (const cdn of CDN_OPTIONS) {
        try {
          report('正在加载中文识别组件…');
          await loadScript(cdn.script);
          if (window.Tesseract && typeof window.Tesseract.createWorker === 'function') {
            activeCdn = cdn;
            return { api: window.Tesseract, cdn };
          }
          throw new Error('识别组件加载后没有初始化');
        } catch (error) { lastError = error; }
      }
      throw new Error('OCR 识别组件加载失败，请检查网络后重试。' + (lastError?.message ? '（' + lastError.message + '）' : ''));
    })();
  }
  try { return await libraryPromise; }
  catch (error) { libraryPromise = null; throw error; }
}

function engineLogger(message) {
  if (!message) return;
  const status = String(message.status || '');
  const progress = Number.isFinite(message.progress) ? Math.round(message.progress * 100) : 0;
  if (status.includes('loading tesseract core')) report('正在加载 OCR 核心…');
  else if (status.includes('loading language traineddata')) report('正在下载中文模型…' + (progress ? ' ' + progress + '%' : ''));
  else if (status.includes('initializing api')) report('正在初始化中文识别…');
  else if (status.includes('recognizing text')) report('正在识别姓名和学科…' + (progress ? ' ' + progress + '%' : ''));
}

async function getWorker() {
  if (worker) return worker;
  if (!workerPromise) {
    workerPromise = (async () => {
      const loaded = await loadLibrary();
      report('首次使用需要准备中文识别模型…');
      worker = await loaded.api.createWorker('chi_sim+eng', 1, {
        workerPath: loaded.cdn.worker,
        corePath: loaded.cdn.core,
        langPath: LANG_PATH,
        gzip: true,
        cacheMethod: 'write',
        logger: engineLogger,
      });
      return worker;
    })();
  }
  try { return await workerPromise; }
  catch (error) { workerPromise = null; worker = null; throw error; }
}

function dimensions(image) {
  return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file); } catch (_) {}
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('照片无法读取，请换一张 JPG 或 PNG 图片')); };
    image.src = url;
  });
}

function makeCanvas(image, rotation, maxEdge) {
  const size = dimensions(image);
  const sw = size.width, sh = size.height;
  if (!sw || !sh) throw new Error('照片尺寸无效');
  const swap = rotation === 90 || rotation === 270;
  const ow = swap ? sh : sw;
  const oh = swap ? sw : sh;
  const scale = Math.min(4, maxEdge / Math.max(ow, oh));
  const width = Math.max(1, Math.round(ow * scale));
  const height = Math.max(1, Math.round(oh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器无法处理这张照片');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(width / 2, height / 2);
  ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(image, -sw * scale / 2, -sh * scale / 2, sw * scale, sh * scale);

  // 轻度灰度与对比度增强；不过度二值化，避免细小汉字笔画消失。
  const pixels = ctx.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const value = Math.max(0, Math.min(255, (gray - 128) * 1.25 + 128));
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function removeTableLines(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = image;
  const w = canvas.width, h = canvas.height;
  const dark = 155;
  const hLines = new Uint8Array(h);
  const vLines = new Uint8Array(w);

  for (let y = 0; y < h; y += 1) {
    let run = 0, longest = 0;
    for (let x = 0; x < w; x += 1) {
      if (data[(y * w + x) * 4] < dark) { run += 1; longest = Math.max(longest, run); }
      else run = 0;
    }
    if (longest > w * 0.34) hLines[y] = 1;
  }
  for (let x = 0; x < w; x += 1) {
    let run = 0, longest = 0;
    for (let y = 0; y < h; y += 1) {
      if (data[(y * w + x) * 4] < dark) { run += 1; longest = Math.max(longest, run); }
      else run = 0;
    }
    if (longest > h * 0.34) vLines[x] = 1;
  }

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!hLines[y] && !vLines[x]) continue;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function chinese(value) {
  return String(value || '').replace(/[^\u3400-\u9fff]/g, '');
}

function validName(value) {
  const name = chinese(value);
  if (name.length < 2 || name.length > 4 || STOP_WORDS.has(name)) return false;
  if (SUBJECTS.includes(name)) return false;
  if (name.length === 4) {
    return ['欧阳', '司马', '上官', '诸葛', '夏侯', '皇甫', '尉迟', '公羊', '公孙', '慕容', '令狐', '钟离', '宇文', '长孙', '司徒', '司空', '东方', '赫连', '濮阳', '淳于', '单于', '太叔', '申屠', '轩辕', '百里', '南宫', '第五'].some((s) => name.startsWith(s));
  }
  return COMMON_SURNAMES.has(name[0]);
}

function subjectAt(text) {
  const ordered = [...SUBJECTS].sort((a, b) => b.length - a.length);
  for (const subject of ordered) {
    const index = text.indexOf(subject);
    if (index >= 0) return { subject, index };
  }
  return null;
}

function candidateName(text) {
  const cleaned = String(text || '')
    .replace(/[0-9０-９一二三四五六七八九十、，,。.:：;；|｜\[\]【】()（）]/g, '')
    .replace(/(高一|高二|高三|教师|老师|姓名|名字|学科|年级|班级|序号|编号|名单|花名册)/g, '');
  const value = chinese(cleaned);
  if (validName(value)) return value;
  for (let len = 4; len >= 2; len -= 1) {
    const tail = value.slice(-len);
    if (validName(tail)) return tail;
  }
  return '';
}

function extractPairs(data) {
  const output = [];
  const seen = new Set();
  const add = (name, subject, confidence = 0) => {
    const key = name + ' ' + subject;
    if (!name || !subject || seen.has(key)) return;
    if (confidence < 18) return;
    seen.add(key);
    output.push({ name, subject, confidence });
  };

  const lines = Array.isArray(data?.lines) && data.lines.length
    ? data.lines.map((line) => ({
        text: line.text || (line.words || []).map((word) => word.text).join(' '),
        words: line.words || [],
      }))
    : String(data?.text || '').split(/\r?\n/).map((text) => ({ text, words: [] }));

  for (const line of lines) {
    const text = String(line.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const words = (line.words || []).map((word) => ({
      text: String(word.text || '').trim(),
      confidence: Number(word.confidence) || Number(data?.confidence) || 0,
    })).filter((word) => word.text && word.confidence >= 18);

    // 首选同一 OCR 行中的姓名/学科配对，避免把表头或其他列拼成姓名。
    const matches = [];
    for (const subject of [...SUBJECTS].sort((a, b) => b.length - a.length)) {
      let at = text.indexOf(subject);
      while (at >= 0) {
        const before = text.slice(0, at);
        const after = text.slice(at + subject.length);
        const beforeTokens = before.split(/[\s,，、|｜:：;；]+/).filter(Boolean);
        const afterTokens = after.split(/[\s,，、|｜:：;；]+/).filter(Boolean);
        let name = '';
        for (let i = beforeTokens.length - 1; i >= 0 && !name; i -= 1) name = candidateName(beforeTokens[i]);
        if (!name) {
          for (let i = 0; i < afterTokens.length && !name; i += 1) name = candidateName(afterTokens[i]);
        }
        if (!name) {
          const left = candidateName(before);
          const right = candidateName(after);
          name = left || right;
        }
        if (name) matches.push({ name, subject });
        at = text.indexOf(subject, at + subject.length);
      }
    }
    matches.forEach((pair) => {
      const wordConfidence = words.length
        ? Math.max(...words.map((word) => word.confidence))
        : Number(data?.confidence) || 0;
      add(pair.name, pair.subject, wordConfidence);
    });
  }

  // 备用：Tesseract 将姓名和学科分成相邻单词时，按同一行的词序配对。
  if (!output.length) {
    for (const line of lines) {
      const tokens = (line.words || []).map((word) => String(word.text || '').trim()).filter(Boolean);
      for (let i = 0; i < tokens.length; i += 1) {
        const subject = SUBJECTS.find((item) => tokens[i].includes(item));
        if (!subject) continue;
        let name = '';
        for (let j = i - 1; j >= 0 && !name; j -= 1) name = candidateName(tokens[j]);
        if (!name) {
          for (let j = i + 1; j < tokens.length && !name; j += 1) name = candidateName(tokens[j]);
        }
        const confidence = Number(data?.confidence) || 0;
        add(name, subject, confidence);
      }
    }
  }
  return output;
}

function scoreData(data, width = 0, height = 0) {
  const pairs = extractPairs(data);
  const rows = width > 0 && height > 0
    ? extractRosterRowsFromTesseract(data?.words || [], width, height)
    : [];
  const confidence = Number(data?.confidence) || 0;
  const subjectHits = SUBJECTS.reduce((count, subject) => count + (String(data?.text || '').includes(subject) ? 1 : 0), 0);
  return { pairs, rows, confidence, score: Math.max(pairs.length, rows.length) * 100 + subjectHits * 8 + confidence * 0.12 };
}

export async function recognizeRosterPhoto(file, onProgress = () => {}, forcedRotation = null, gradeHint = '') {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择 JPG、PNG 或 WebP 照片');
  if (file.size > 30 * 1024 * 1024) throw new Error('照片超过 30MB，请先压缩后再识别');

  progressHandler = typeof onProgress === 'function' ? onProgress : () => {};
  let image = null;
  const canvases = [];
  try {
    image = await decodeImage(file);
    const size = dimensions(image);
    if (Math.min(size.width, size.height) < 360) {
      throw new Error('照片分辨率太低。请上传手机相册中的原始照片，不要上传聊天软件压缩图或页面截图。');
    }
    const ocrWorker = await getWorker();
    const rotations = forcedRotation === null ? [0, 90, 180, 270] : [((Number(forcedRotation) % 360) + 360) % 360];
    const orientationResults = [];

    for (let i = 0; i < rotations.length; i += 1) {
      const rotation = rotations[i];
      report(rotations.length > 1 ? '正在检查照片方向（' + (i + 1) + '/4）…' : '正在按当前方向重新识别…');
      const canvas = makeCanvas(image, rotation, 1700);
      canvases.push(canvas);
      for (const mode of ['11', '12']) {
        await ocrWorker.setParameters({
          tessedit_pageseg_mode: mode,
          preserve_interword_spaces: '1',
        });
        const result = await ocrWorker.recognize(canvas);
        const scored = scoreData(result.data, canvas.width, canvas.height);
        orientationResults.push({ rotation, mode, data: result.data, width: canvas.width, height: canvas.height, ...scored });
      }
    }

    orientationResults.sort((a, b) => b.score - a.score);
    const best = orientationResults[0];
    if (!best || Math.max(best.pairs.length, best.rows?.length || 0) < 2) {
      throw new Error('这张照片暂时无法可靠提取出“姓名＋学科”组合。当前画面中的表头和考勤项目不能当作教师名单。请上传原始高清照片，尽量只拍姓名、学科两列；也可以手动旋转后重新识别。');
    }

    report('已找到姓名和学科线索，正在进行二次校验…');
    const rawCanvas = makeCanvas(image, best.rotation, 2800);
    canvases.push(rawCanvas);
    const cleanCanvas = removeTableLines(rawCanvas);
    canvases.push(cleanCanvas);
    const finalResults = [];

    for (const mode of ['6', '11', '12']) {
      await ocrWorker.setParameters({
        tessedit_pageseg_mode: mode,
        preserve_interword_spaces: '1',
      });
      const result = await ocrWorker.recognize(rawCanvas);
      finalResults.push({ data: result.data, width: rawCanvas.width, height: rawCanvas.height, ...scoreData(result.data) });
    }

    await ocrWorker.setParameters({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
    });
    const cleanResult = await ocrWorker.recognize(cleanCanvas);
    finalResults.push({ data: cleanResult.data, width: cleanCanvas.width, height: cleanCanvas.height, ...scoreData(cleanResult.data) });
    finalResults.push(best);
    for (const candidate of finalResults) {
      candidate.rows = extractRosterRowsFromTesseract(
        candidate.data?.words || [],
        candidate.width || rawCanvas.width,
        candidate.height || rawCanvas.height
      );
      const ocrText = String(candidate.data?.text || '');
      const knownCount = inferKnownRosterCount(gradeHint, ocrText);
      candidate.expectedCount = knownCount || candidate.rows.length;
      candidate.leftGroupCount = Math.ceil(candidate.expectedCount / 2);
      candidate.validation = validateRosterRows(candidate.rows, candidate.expectedCount);
      candidate.reviewRows = buildRosterReviewRows(candidate.rows, candidate.expectedCount, candidate.leftGroupCount);
      candidate.structureScore = candidate.rows.length * 100
        - candidate.validation.duplicateSerials.length * 80
        - candidate.validation.missingSerials.length * 12
        - candidate.validation.incompleteSerials.length * 10;
    }
    finalResults.sort((a, b) =>
      b.structureScore - a.structureScore
      || b.pairs.length - a.pairs.length
      || b.score - a.score
    );

    const selected = finalResults[0];
    const pairs = selected.rows.length
      ? selected.rows.filter((row) => row.name && row.subject).map((row) => ({ name: row.name, subject: row.subject, serial: row.serial }))
      : selected.pairs.map((pair, index) => ({ ...pair, serial: index + 1 }));
    if (pairs.length < 2) {
      throw new Error('二次校验没有找到足够可靠的教师姓名。请换用更清晰的原始照片，确保姓名和学科列完整入镜。');
    }
    const text = selected.reviewRows.map((row) => [row.serial, row.name, row.subject].filter(Boolean).join(' ')).join('\\n');
    const validation = selected.validation;
    report('结构识别完成：识别到 ' + pairs.length + ' 条，待核对 ' + (validation.expectedCount - validation.completeCount) + ' 条。');
    return {
      text,
      rotation: best.rotation,
      confidence: Math.round(selected.confidence),
      count: pairs.length,
      pairs,
      rows: selected.reviewRows,
      validation,
      expectedCount: selected.expectedCount,
      leftGroupCount: selected.leftGroupCount
    };
  } finally {
    canvases.forEach((canvas) => { canvas.width = 0; canvas.height = 0; });
    if (image && typeof image.close === 'function') image.close();
    progressHandler = () => {};
  }
}


/* 电子备课图片 OCR：复用工作台已加载的中文 Tesseract Worker，返回原始文字供教师核对。 */
export async function recognizeLessonPlanImage(file, onProgress = () => {}) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 30 * 1024 * 1024) throw new Error('图片超过 30MB，请先压缩后再识别');
  progressHandler = typeof onProgress === 'function' ? onProgress : () => {};
  let image = null;
  let canvas = null;
  try {
    report('正在读取备课照片…');
    image = await decodeImage(file);
    const size = dimensions(image);
    if (!size.width || !size.height) throw new Error('图片尺寸无效');
    const worker = await getWorker();
    canvas = makeCanvas(image, 0, 2800);
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    report('正在识别备课文字…');
    const result = await worker.recognize(canvas);
    const text = String(result?.data?.text || '').trim();
    if (!text) throw new Error('没有识别到可用文字，请换一张更清晰的照片');
    report('识别完成，请检查并修正文字后保存。');
    return { text, confidence: Math.round(Number(result?.data?.confidence) || 0) };
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (image && typeof image.close === 'function') image.close();
    progressHandler = () => {};
  }
}
