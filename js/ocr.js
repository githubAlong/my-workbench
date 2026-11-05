/*
 * 中文花名册 OCR
 * - Tesseract.js 在浏览器 WebWorker / WASM 中运行，照片本身不上传服务器。
 * - 首次使用需要联网加载识别引擎和 chi_sim 中文模型；模型由 Tesseract 缓存。
 * - 纸质名单经常横拍竖传，先尝试 0/90/180/270 度，再对最佳方向做表格线清理。
 */

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
const SKIP_WORDS = new Set([
  '姓名', '名字', '学科', '序号', '编号', '教师', '老师',
  '教师名单', '教师名册', '花名册', '合计', '小计', '总计',
  '备注', '说明', '年级', '班级', '日期', '签到',
]);

let libraryPromise = null;
let workerPromise = null;
let worker = null;
let activeCdn = null;
let progressHandler = () => {};

function report(message) {
  try {
    progressHandler(String(message || '正在识别…'));
  } catch (_) {
    // UI 已关闭时不影响 OCR 任务本身
  }
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
      if (error) {
        script.remove();
        reject(error);
      } else {
        resolve();
      }
    }

    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.wbOcrEngine = 'tesseract';
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
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error('OCR 识别组件加载失败，请检查网络后重新识别。' +
        (lastError && lastError.message ? '（' + lastError.message + '）' : ''));
    })();
  }
  try {
    return await libraryPromise;
  } catch (error) {
    libraryPromise = null;
    throw error;
  }
}

function onEngineLog(message) {
  if (!message) return;
  const status = String(message.status || '');
  const progress = Number.isFinite(message.progress)
    ? Math.round(message.progress * 100)
    : 0;
  if (status.includes('loading tesseract core')) {
    report('正在加载 OCR 核心…');
  } else if (status.includes('loading language traineddata')) {
    report('正在下载中文识别模型…' + (progress ? ' ' + progress + '%' : ''));
  } else if (status.includes('initializing api')) {
    report('正在初始化中文识别…');
  } else if (status.includes('recognizing text')) {
    report('正在识别照片文字…' + (progress ? ' ' + progress + '%' : ''));
  }
}

async function getWorker() {
  if (worker) return worker;
  if (!workerPromise) {
    workerPromise = (async () => {
      const loaded = await loadLibrary();
      report('正在准备中文识别模型，首次使用需要下载模型…');
      worker = await loaded.api.createWorker('chi_sim+eng', 1, {
        workerPath: loaded.cdn.worker,
        corePath: loaded.cdn.core,
        langPath: LANG_PATH,
        gzip: true,
        cacheMethod: 'write',
        logger: onEngineLog,
      });
      return worker;
    })();
  }
  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = null;
    worker = null;
    throw error;
  }
}

function imageDimensions(image) {
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  };
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      // Safari 某些图片格式回退到 HTMLImageElement
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('照片无法读取，请换一张 JPG 或 PNG 图片'));
    };
    image.src = url;
  });
}

function makeCanvas(image, rotation, maxEdge) {
  const size = imageDimensions(image);
  const sourceWidth = size.width;
  const sourceHeight = size.height;
  if (!sourceWidth || !sourceHeight) throw new Error('照片尺寸无效');

  const swap = rotation === 90 || rotation === 270;
  const targetWidth = swap ? sourceHeight : sourceWidth;
  const targetHeight = swap ? sourceWidth : sourceHeight;
  const scale = Math.min(2, maxEdge / Math.max(targetWidth, targetHeight));
  const width = Math.max(1, Math.round(targetWidth * scale));
  const height = Math.max(1, Math.round(targetHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法处理这张照片');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.translate(width / 2, height / 2);
  context.rotate(rotation * Math.PI / 180);
  context.drawImage(
    image,
    -sourceWidth * scale / 2,
    -sourceHeight * scale / 2,
    sourceWidth * scale,
    sourceHeight * scale,
  );

  // 灰度 + 适度拉高对比度，尽量压低纸张阴影，同时保留细笔画。
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    let gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    gray = Math.max(0, Math.min(255, (gray - 150) * 1.45 + 150));
    data[i] = gray;
    data[i + 1] = gray;
    data[i + 2] = gray;
    data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function removeLongTableLines(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return canvas;
  const width = canvas.width;
  const height = canvas.height;
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  const horizontal = new Uint8Array(height);
  const vertical = new Uint8Array(width);
  const threshold = 160;

  // 只删除长直线，避免把普通汉字笔画误判成表格线。
  for (let y = 0; y < height; y += 1) {
    let run = 0;
    let longest = 0;
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4] < threshold) {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    if (longest >= Math.max(70, width * 0.28)) horizontal[y] = 1;
  }

  for (let x = 0; x < width; x += 1) {
    let run = 0;
    let longest = 0;
    for (let y = 0; y < height; y += 1) {
      if (data[(y * width + x) * 4] < threshold) {
        run += 1;
        if (run > longest) longest = run;
      } else {
        run = 0;
      }
    }
    if (longest >= Math.max(70, height * 0.28)) vertical[x] = 1;
  }

  const hMask = horizontal.slice();
  const vMask = vertical.slice();
  for (let y = 0; y < height; y += 1) {
    if (horizontal[y]) {
      if (y > 0) hMask[y - 1] = 1;
      if (y + 1 < height) hMask[y + 1] = 1;
    }
  }
  for (let x = 0; x < width; x += 1) {
    if (vertical[x]) {
      if (x > 0) vMask[x - 1] = 1;
      if (x + 1 < width) vMask[x + 1] = 1;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!hMask[y] && !vMask[x]) continue;
      const i = (y * width + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function scoreResult(data) {
  const text = String(data && data.text || '');
  const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const lines = text.split(/\n/).filter((line) => line.trim()).length;
  const confidence = Number(data && data.confidence) || 0;
  return confidence + Math.min(han, 120) * 0.65
    + Math.min(words, 60) * 0.12 + Math.min(lines, 40) * 0.2;
}

function isNameToken(token) {
  const value = String(token || '').replace(/[^\u3400-\u9fff]/g, '');
  if (value.length < 2 || value.length > 4) return false;
  if (SKIP_WORDS.has(value) || SUBJECTS.includes(value)) return false;
  return true;
}

function normalizeRosterText(rawText) {
  const rawLines = String(rawText || '').replace(/\r/g, '\n').split('\n');
  const output = [];
  const seen = new Set();

  const add = (value) => {
    const line = String(value || '').replace(/\s+/g, ' ').trim();
    if (!line || seen.has(line)) return;
    seen.add(line);
    output.push(line);
  };

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/[|｜¦]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const tokens = line.split(' ').map((token) => token.trim()).filter(Boolean);
    const pairs = [];

    for (let i = 0; i < tokens.length; i += 1) {
      const subject = SUBJECTS.find((item) => tokens[i].includes(item));
      if (!subject) continue;
      let name = '';
      for (let j = i - 1; j >= 0; j -= 1) {
        if (isNameToken(tokens[j])) { name = tokens[j].replace(/[^\u3400-\u9fff]/g, ''); break; }
      }
      if (!name && i + 1 < tokens.length && isNameToken(tokens[i + 1])) {
        name = tokens[i + 1].replace(/[^\u3400-\u9fff]/g, '');
      }
      if (name) pairs.push(name + ' ' + subject);
    }

    if (pairs.length) {
      pairs.forEach(add);
      continue;
    }

    // 识别结果没有明确学科列时，保留疑似姓名，一人一行，学科留空待核对。
    const names = tokens
      .map((token) => token.replace(/[^\u3400-\u9fff]/g, ''))
      .filter(isNameToken);
    if (names.length) {
      names.forEach(add);
      continue;
    }

    const hanCount = (line.match(/[\u3400-\u9fff]/g) || []).length;
    if (hanCount >= 2 && !SKIP_WORDS.has(line)) add(line);
  }

  return output.join('\n');
}

export async function recognizeRosterPhoto(file, onProgress = () => {}) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('请选择 JPG、PNG 或 WebP 照片');
  }
  if (file.size > 30 * 1024 * 1024) {
    throw new Error('照片超过 30MB，请先压缩后再识别');
  }

  progressHandler = typeof onProgress === 'function' ? onProgress : () => {};
  let image = null;
  try {
    image = await decodeImage(file);
    const ocrWorker = await getWorker();
    const rotations = [0, 90, 180, 270];
    const candidates = [];

    for (let i = 0; i < rotations.length; i += 1) {
      const rotation = rotations[i];
      report('正在自动校正照片方向（' + (i + 1) + '/4）…');
      const canvas = makeCanvas(image, rotation, 1450);
      await ocrWorker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1',
      });
      const result = await ocrWorker.recognize(canvas);
      candidates.push({
        rotation,
        data: result.data,
        score: scoreResult(result.data),
      });
      canvas.width = 0;
      canvas.height = 0;
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    report('已校正照片方向，正在精细识别姓名和学科…');

    const rawCanvas = makeCanvas(image, best.rotation, 2500);
    const cleanCanvas = document.createElement('canvas');
    cleanCanvas.width = rawCanvas.width;
    cleanCanvas.height = rawCanvas.height;
    const cleanContext = cleanCanvas.getContext('2d', { willReadFrequently: true });
    cleanContext.drawImage(rawCanvas, 0, 0);
    removeLongTableLines(cleanCanvas);

    const finalResults = [];
    await ocrWorker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
    });
    const rawResult = await ocrWorker.recognize(rawCanvas);
    finalResults.push({ data: rawResult.data, score: scoreResult(rawResult.data) });

    await ocrWorker.setParameters({
      tessedit_pageseg_mode: '11',
      preserve_interword_spaces: '1',
    });
    const cleanResult = await ocrWorker.recognize(cleanCanvas);
    finalResults.push({ data: cleanResult.data, score: scoreResult(cleanResult.data) });

    finalResults.push({ data: best.data, score: best.score });
    finalResults.sort((a, b) => b.score - a.score);

    rawCanvas.width = 0;
    rawCanvas.height = 0;
    cleanCanvas.width = 0;
    cleanCanvas.height = 0;

    const selected = finalResults[0].data;
    const text = normalizeRosterText(selected && selected.text);
    if (!text) {
      throw new Error('识别引擎已运行，但没有提取到可用中文姓名。请把纸张放平、靠近拍摄并避免反光，再试一次');
    }

    report('识别完成，请核对姓名和学科…');
    return {
      text,
      rotation: best.rotation,
      confidence: Math.round(Number(selected && selected.confidence) || 0),
      count: text.split('\n').filter(Boolean).length,
    };
  } finally {
    if (image && typeof image.close === 'function') image.close();
    progressHandler = () => {};
  }
}
