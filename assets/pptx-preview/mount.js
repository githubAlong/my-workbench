export function mountPptxPreview(container, file, name) {
  const frame = document.createElement('iframe');
  frame.title = name || '幻灯片浏览';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = new URL('./index.html', import.meta.url).href;
  const timeout = setTimeout(() => {
    window.removeEventListener('message', onReady);
    if (frame.isConnected) container.textContent = '幻灯片浏览组件加载超时，请返回重试或下载原文件。';
  }, 20000);
  function onReady(event) {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || event.data !== 'wb:pptx:ready') return;
    clearTimeout(timeout);
    window.removeEventListener('message', onReady);
    frame.contentWindow.postMessage({ type: 'wb:pptx:file', file }, '*');
  }
  window.addEventListener('message', onReady);
  container.replaceChildren(frame);
}
