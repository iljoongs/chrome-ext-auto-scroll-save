const SCROLL_STEP_PX = 500;
const SCROLL_INTERVAL_MS = 350;
const IMAGE_WAIT_INTERVAL_MS = 300;
const IMAGE_WAIT_MAX_MS = 8000;
// 무한 스크롤 페이지에서 스크롤이 끝없이 이어지는 것을 막기 위한 안전장치
const MAX_SCROLL_ITERATIONS = 400;

// chrome.scripting.executeScript(func: ...)로 페이지 컨텍스트에 주입되는 함수.
// 이 함수 안에서는 background.js의 다른 변수/함수를 참조할 수 없다.
async function scrollAndWaitForImages(
  scrollStepPx,
  scrollIntervalMs,
  imageWaitIntervalMs,
  imageWaitMaxMs,
  maxIterations
) {
  let lastHeight = -1;
  for (let i = 0; i < maxIterations; i++) {
    window.scrollBy(0, scrollStepPx);
    await new Promise((resolve) => setTimeout(resolve, scrollIntervalMs));
    const scrollHeight = document.body.scrollHeight;
    const reachedBottom = window.scrollY + window.innerHeight >= scrollHeight;
    if (reachedBottom || scrollHeight === lastHeight) break;
    lastHeight = scrollHeight;
  }

  const start = Date.now();
  while (Date.now() - start < imageWaitMaxMs) {
    const images = Array.from(document.images);
    if (images.every((img) => img.complete)) break;
    await new Promise((resolve) => setTimeout(resolve, imageWaitIntervalMs));
  }

  window.scrollTo(0, 0);
}

function sanitizeTitle(title) {
  const cleaned = (title || 'page').replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'page';
}

// 서비스 워커에는 FileReader가 없어 arrayBuffer를 청크 단위로 직접 base64 인코딩한다.
async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function downloadResource(url, filename) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const base64 = await arrayBufferToBase64(buffer);
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const dataUrl = `data:${contentType};base64,${base64}`;
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  } catch (err) {
    console.warn(`[자동 스크롤 후 페이지 저장] 리소스 다운로드 실패: ${url}`, err);
  }
}

async function handleCapture(tab) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;

  try {
    await chrome.action.setBadgeText({ tabId, text: '...' });

    await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollAndWaitForImages,
      args: [SCROLL_STEP_PX, SCROLL_INTERVAL_MS, IMAGE_WAIT_INTERVAL_MS, IMAGE_WAIT_MAX_MS, MAX_SCROLL_ITERATIONS],
    });

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-capture.js'],
    });

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__autoScrollSaveResult,
    });

    if (!result) throw new Error('페이지 캡처 결과가 비어 있습니다.');

    const { html, resources } = result;
    const safeTitle = sanitizeTitle(tab.title);

    for (const { url, localFilename } of resources) {
      await downloadResource(url, `${safeTitle}_files/${localFilename}`);
    }

    const htmlBytes = new TextEncoder().encode(html);
    const htmlBase64 = await arrayBufferToBase64(htmlBytes.buffer);
    const htmlDataUrl = `data:text/html;charset=utf-8;base64,${htmlBase64}`;
    await chrome.downloads.download({ url: htmlDataUrl, filename: `${safeTitle}.html`, saveAs: false });

    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (err) {
    console.error('[자동 스크롤 후 페이지 저장] 실패:', err);
    await chrome.action.setBadgeText({ tabId, text: 'X' });
  }
}

chrome.action.onClicked.addListener((tab) => {
  handleCapture(tab);
});
