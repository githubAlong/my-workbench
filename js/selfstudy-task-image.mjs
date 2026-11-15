/* 自习任务图：按需求文档 5.4 节生成两种版式。
     · 学生端保存  1080 × 1440（3:4）
     · 班班通大屏  1920 × 1080（16:9）
   超长内容不压字号，改为分页；最多 3 张，第三张末尾以省略号收尾。
   教师端「生成PNG预览」和学生端「保存任务图」都走这里，保证两边版式一致。 */

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const MAX_PAGES = 3;

const SIZES = {
  save: { width: 1080, height: 1440, pad: 80, title: 44, meta: 26, body: 34, line: 1.8, footer: 26 },
  screen: { width: 1920, height: 1080, pad: 154, title: 56, meta: 30, body: 32, line: 1.8, footer: 26 },
};

/* 逐字断行：中文按字宽算，连续英文/数字尽量不拆开 */
function wrapLines(ctx, text, maxWidth) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    let cur = '';
    for (const ch of line) {
      const next = cur + ch;
      if (ctx.measureText(next).width > maxWidth && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

function paint({ width, height, pad, titleSize, metaSize, bodySize, line, footerSize }, task, lines, page, pageCount) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  /* 标题带「（续）」，一眼能看出是同一任务的下一页 */
  const title = String(task.title || '自习任务') + (page > 0 ? '（续）' : '');
  ctx.textAlign = 'center';
  ctx.fillStyle = '#1677ff';
  ctx.font = `700 ${titleSize}px ${FONT}`;
  ctx.fillText(title, width / 2, pad + titleSize, width - pad * 2);

  const meta = [task.class_label || '全部', task.date || '', task.period || ''].filter(Boolean).join(' · ');
  ctx.fillStyle = '#9ca3af';
  ctx.font = `400 ${metaSize}px ${FONT}`;
  ctx.fillText(meta, width / 2, pad + titleSize + metaSize + 24);

  const top = pad + titleSize + metaSize + 24 + metaSize + 56;
  const footerH = footerSize + 36;
  const capacity = Math.max(1, Math.floor((height - top - pad - footerH) / (bodySize * line)));
  const slice = lines.slice(page * capacity, page * capacity + capacity);
  const isLast = page === pageCount - 1;
  const isCapped = pageCount === MAX_PAGES && isLast && lines.length > capacity * pageCount;

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1f2937';
  ctx.font = `400 ${bodySize}px ${FONT}`;
  slice.forEach((text, i) => {
    if (isCapped && i === slice.length - 1) text = text.replace(/[，。；、]?$/, '') + '…';
    ctx.fillText(text, pad, top + i * bodySize * line);
  });

  const footer = [task.school || '', task.date || ''].filter(Boolean).join('  ·  ');
  if (footer) {
    ctx.fillStyle = '#9ca3af';
    ctx.font = `400 ${footerSize}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(footer, width / 2, height - pad);
  }
  return canvas;
}

/** 生成某个尺寸的全部分页 canvas。size: 'save' | 'screen' */
export function taskImagePages(task = {}, size = 'save') {
  const conf = SIZES[size] || SIZES.save;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `400 ${conf.body}px ${FONT}`;
  const lines = wrapLines(measure, task.content || '', conf.width - conf.pad * 2);
  const capacity = Math.max(1, Math.floor(
    (conf.height - (conf.pad + conf.title + conf.meta + 24 + conf.meta + 56) - conf.pad - (conf.footer + 36))
    / (conf.body * conf.line)
  ));
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(lines.length / capacity)));
  return Array.from({ length: pageCount }, (_, i) => paint(conf, task, lines, i, pageCount));
}

/** 把画布转成 dataURL（默认 PNG） */
export function canvasToDataUrl(canvas, mime = 'image/png') {
  return canvas.toDataURL(mime);
}

/** 下载画布；文件名默认带任务标题 */
export function downloadCanvas(canvas, filename = '自习任务.png') {
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
