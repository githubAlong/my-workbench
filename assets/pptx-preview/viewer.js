const controls = document.getElementById('controls');
const previous = document.getElementById('previous');
const next = document.getElementById('next');
const pageNumber = document.getElementById('page-number');
const status = document.getElementById('status');
const slide = document.getElementById('slide');
let viewer;

function updateControls() {
  const index = viewer.currentSlideIndex;
  pageNumber.textContent = `${index + 1} / ${viewer.slideCount}`;
  previous.disabled = index <= 0;
  next.disabled = index >= viewer.slideCount - 1;
}

async function turnPage(offset) {
  previous.disabled = true;
  next.disabled = true;
  const target = viewer.currentSlideIndex + offset;
  try {
    await viewer.goToSlide(target);
    status.hidden = true;
    window.scrollTo(0, 0);
  } catch {
    status.textContent = '这一页暂时无法浏览，可以尝试翻页或下载原文件。';
    status.hidden = false;
  } finally {
    updateControls();
  }
}

previous.onclick = () => turnPage(-1);
next.onclick = () => turnPage(1);

async function openFile(event) {
  if (event.source !== window.parent || !(event.data?.file instanceof Blob) || event.data.type !== 'wb:pptx:file') return;
  window.removeEventListener('message', openFile);
  try {
    const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = globalThis.WbPptxRenderer;
    viewer = new PptxViewer(slide, {
      externalMedia: 'block',
      // 教材的内嵌视频可能超过默认的 32 MiB，整份文件仍受解压总量限制。
      zipLimits: { ...RECOMMENDED_ZIP_LIMITS, maxEntryUncompressedBytes: 64 * 1024 * 1024 },
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
    });
    await viewer.open(event.data.file, { renderMode: 'slide' });
    if (!viewer.slideCount) throw new Error('Empty presentation');
    status.hidden = true;
    controls.hidden = false;
    updateControls();
  } catch {
    status.textContent = '这份幻灯片暂时无法浏览，请点击「下载原文件」。';
  }
}

window.addEventListener('message', openFile);
window.addEventListener('pagehide', () => viewer?.destroy());
window.parent.postMessage('wb:pptx:ready', '*');
