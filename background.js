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
  let lastScrollY = -1;
  for (let i = 0; i < maxIterations; i++) {
    window.scrollBy(0, scrollStepPx);
    await new Promise((resolve) => setTimeout(resolve, scrollIntervalMs));

    const scrollHeight = document.body.scrollHeight;
    const reachedBottom = window.scrollY + window.innerHeight >= scrollHeight;
    if (reachedBottom) break;

    // scrollHeight는 대부분의 페이지에서 스크롤해도 거의 그대로이므로(스크롤 위치만
    // 바뀜), 진행 여부는 scrollY 변화로 판단해야 한다. scrollY도 안 움직이면
    // 더 스크롤할 수 없는 상태(막힘)로 보고 중단한다.
    if (window.scrollY === lastScrollY) break;
    lastScrollY = window.scrollY;
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

// fetch()로 받아서 base64로 재변환하지 않고 원본 URL을 그대로 chrome.downloads.download에
// 넘긴다. fetch()는 CORS 정책의 적용을 받아 <img> 태그로는 멀쩡히 보이는 이미지도
// 다운로드에 실패하는 경우가 많은데, chrome.downloads.download는 일반 브라우저
// 다운로드와 동일하게 동작해 CORS 제약을 받지 않는다.
function downloadResource(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      if (chrome.runtime.lastError) {
        console.warn(
          `[자동 스크롤 후 페이지 저장] 리소스 다운로드 실패: ${url}`,
          chrome.runtime.lastError.message
        );
      }
      resolve();
    });
  });
}

// MV3 서비스 워커는 ~30초간 활동이 없으면 크롬이 중간에 강제 종료시킨다.
// 스크롤+대기+리소스 순차 다운로드를 합치면 이 시간을 쉽게 넘기므로, 작업이
// 끝날 때까지 주기적으로 가벼운 크롬 API를 호출해 서비스 워커를 깨어있게 한다.
function startKeepAlive() {
  const id = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => {});
  }, 20000);
  return () => clearInterval(id);
}

async function handleCapture(tab) {
  if (!tab || !tab.id) return;
  const tabId = tab.id;
  const stopKeepAlive = startKeepAlive();

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

    // 어떤 버전이 실제로 실행됐는지, 리소스가 몇 개/어떤 URL로 잡혔는지를
    // 파일로 남긴다 (사용자가 크롬 UI를 안 봐도 저장 폴더만으로 확인 가능).
    // 이후 단계가 실패해도 진단할 수 있도록 리소스/HTML 다운로드보다 먼저 만든다.
    const debugText = [
      `extension_version: ${chrome.runtime.getManifest().version}`,
      `saved_at: ${new Date().toISOString()}`,
      `tab_url: ${tab.url || ''}`,
      `tab_title: ${tab.title || ''}`,
      `resource_count: ${resources.length}`,
      'resources:',
      ...resources.map(({ url, localFilename }) => `  ${localFilename}  <-  ${url}`),
    ].join('\n');
    const debugBase64 = await arrayBufferToBase64(new TextEncoder().encode(debugText).buffer);
    await chrome.downloads.download({
      url: `data:text/plain;charset=utf-8;base64,${debugBase64}`,
      filename: `${safeTitle}.debug.txt`,
      saveAs: false,
    });

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
  } finally {
    stopKeepAlive();
  }
}

chrome.action.onClicked.addListener((tab) => {
  handleCapture(tab);
});
