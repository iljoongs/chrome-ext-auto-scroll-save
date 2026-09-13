const SCROLL_STEP_PX = 500;
const SCROLL_INTERVAL_MS = 350;
const IMAGE_WAIT_INTERVAL_MS = 300;
const IMAGE_WAIT_MAX_MS = 8000;
// 무한 스크롤 페이지에서 스크롤이 끝없이 이어지는 것을 막기 위한 안전장치
const MAX_SCROLL_ITERATIONS = 400;
// "다음화"를 계속 따라가다 무한 루프(예: 다음화 링크가 순환하는 경우)에
// 빠지지 않도록 하는 안전장치 — 한 번 클릭으로 저장할 최대 챕터 수
const MAX_CHAPTERS = 500;
// 평소엔 끄고, 나중에 문제가 생기면 true로 바꿔서 저장 폴더에
// `<제목>.debug.txt`/`<제목>.debug-result.txt`(버전, 수집된 리소스 목록,
// 리소스별 성공/실패 사유)를 남기도록 켤 수 있다.
const DEBUG_FILES_ENABLED = false;

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

// chrome.scripting.executeScript(func: ...)로 페이지 컨텍스트에 주입되는 함수.
// "이전화/다음화" 버튼(class="vnav-btn")은 각각 num이 작은/큰 페이지로 가는
// <a href>인데, 마지막 화에서는 다음화가 <button disabled>로 바뀌어 <a>
// 자체가 사라진다. 그래서 현재 num보다 큰 num으로 가는 vnav-btn 링크 중
// 가장 작은 값을 "다음화"로 판단하고, 없으면(=비활성화됨) null을 반환한다.
function findNextEpisodeUrl() {
  try {
    const currentNum = Number(new URL(location.href).searchParams.get('num'));
    if (Number.isNaN(currentNum)) return null;
    let best = null;
    let bestNum = Infinity;
    document.querySelectorAll('a.vnav-btn[href]').forEach((a) => {
      try {
        const u = new URL(a.getAttribute('href'), location.href);
        const num = Number(u.searchParams.get('num'));
        if (!Number.isNaN(num) && num > currentNum && num < bestNum) {
          bestNum = num;
          best = u.href;
        }
      } catch (e) {
        // 무시하고 다음 후보 확인
      }
    });
    return best;
  } catch (e) {
    return null;
  }
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

// chrome.downloads.download의 콜백은 다운로드가 "시작(큐잉)"됐다는 뜻일 뿐, 실제로
// 파일이 완성됐는지는 알려주지 않는다 (크롬이 자동 다운로드를 조용히 막는 경우
// 콜백은 정상 downloadId를 반환하고 이후 상태만 'interrupted'가 됨). 그래서
// onChanged로 최종 상태('complete'/'interrupted')까지 직접 확인한다.
function waitForDownloadFinish(downloadId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state, reason) => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(listener);
      clearTimeout(timer);
      resolve({ state, reason });
    };
    const listener = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
        finish(delta.state.current, delta.error ? delta.error.current : undefined);
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    chrome.downloads.search({ id: downloadId }, (results) => {
      const item = results && results[0];
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        finish(item.state, item.error);
      }
    });
  });
}

// fetch()로 받아서 base64로 재변환하지 않고 원본 URL을 그대로 chrome.downloads.download에
// 넘긴다. fetch()는 CORS 정책의 적용을 받아 <img> 태그로는 멀쩡히 보이는 이미지도
// 다운로드에 실패하는 경우가 많은데, chrome.downloads.download는 일반 브라우저
// 다운로드와 동일하게 동작해 CORS 제약을 받지 않는다.
//
// (다운로드가 안 되는 경우는 아래 fetchResourceViaDebugger 참고)
// downloadUrl은 실제로 다운로드에 쓸 URL(원본 URL 또는 디버거로 미리 받아온
// 데이터의 data: URL)이고, sourceUrl은 로그/결과 표시에 쓸 원본 URL이다.
function downloadResource(sourceUrl, downloadUrl, filename) {
  const options = { url: downloadUrl, filename, saveAs: false };
  return new Promise((resolve) => {
    chrome.downloads.download(options, async (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        const message = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'downloadId 없음';
        console.warn(`[자동 스크롤 후 페이지 저장] 리소스 다운로드 실패: ${sourceUrl}`, message);
        resolve({ url: sourceUrl, filename, ok: false, detail: message });
        return;
      }
      const { state, reason } = await waitForDownloadFinish(downloadId);
      if (state !== 'complete') {
        console.warn(`[자동 스크롤 후 페이지 저장] 리소스 다운로드 실패: ${sourceUrl}`, state, reason);
      }
      resolve({ url: sourceUrl, filename, ok: state === 'complete', detail: reason || state });
    });
  });
}

function sendDebuggerCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

// chrome.downloads.download는 Referer를 직접 설정할 수 없고(안전하지 않은
// 헤더로 취급됨), declarativeNetRequest도 chrome.downloads.download가 만드는
// 요청에는 개입하지 못한다(실측 확인됨). 그래서 Referer/쿠키 검사가 있는
// 핫링크 방지 리소스는 CDP(Network.loadNetworkResource)로 "그 프레임이 직접
// 요청한 것"처럼 가져온다 — 이러면 실제 페이지 요청과 동일하게 Referer/쿠키가
// 붙고, CORS도 적용되지 않는다(디버깅 프로토콜은 페이지 스크립트가 아니라
// 브라우저 쪽 권한으로 응답을 읽기 때문).
async function fetchResourceViaDebugger(tabId, frameId, url) {
  const { resource } = await sendDebuggerCommand(tabId, 'Network.loadNetworkResource', {
    frameId,
    url,
    options: { disableCache: false, includeCredentials: true },
  });

  if (!resource || !resource.success) {
    return { ok: false, detail: `CDP_LOAD_FAILED(${resource ? resource.httpStatusCode : 'n/a'})` };
  }
  if (!resource.stream) {
    return { ok: false, detail: 'CDP_NO_STREAM' };
  }

  const chunks = [];
  let totalLength = 0;
  for (;;) {
    const { data, base64Encoded, eof } = await sendDebuggerCommand(tabId, 'IO.read', {
      handle: resource.stream,
    });
    if (data) {
      const bytes = base64Encoded
        ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(data);
      chunks.push(bytes);
      totalLength += bytes.length;
    }
    if (eof) break;
  }
  await sendDebuggerCommand(tabId, 'IO.close', { handle: resource.stream }).catch(() => {});

  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return { ok: true, bytes: combined };
}

// 캡처 대상 탭에 디버거를 붙여 CDP로 리소스를 가져올 수 있게 준비한다.
// 실패(예: 이미 다른 DevTools가 그 탭에 붙어 있음)해도 전체를 중단하지 않고,
// null을 반환해 호출부가 원래의 직접 다운로드 방식으로 대체하도록 한다.
async function attachDebuggerForResourceFetch(tabId) {
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    await sendDebuggerCommand(tabId, 'Network.enable');
    await sendDebuggerCommand(tabId, 'Page.enable');
    const frameTree = await sendDebuggerCommand(tabId, 'Page.getFrameTree');
    return frameTree.frameTree.frame.id;
  } catch (err) {
    console.warn('[자동 스크롤 후 페이지 저장] 디버거 연결 실패 (직접 다운로드로 대체):', err.message);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      // 애초에 안 붙었으면 detach도 실패하는데 무시해도 됨
    }
    return null;
  }
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

// 현재 tab에서 스크롤 → 캡처 → 리소스/HTML 다운로드까지 한 챕터 분량을
// 처리한다. 실패하면 예외를 던진다 (호출부의 handleCaptureAllChapters가
// 배지를 "X"로 바꾸고 멈춘다).
async function captureCurrentPage(tab) {
  const tabId = tab.id;

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
  // 평소엔 DEBUG_FILES_ENABLED로 꺼 두고, 문제가 생기면 켜서 쓴다.
  if (DEBUG_FILES_ENABLED) {
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
  }

  // 디버거를 붙이면 브라우저 상단에 "디버깅 중" 배너가 뜨지만, Referer/쿠키
  // 검사가 있는 핫링크 방지 리소스까지 받아오려면 이 방법뿐이다. 연결에
  // 실패하면(예: 이미 다른 DevTools가 붙어 있음) frameId가 null이 되고,
  // 아래에서 리소스별로 원래의 직접 다운로드 방식으로 대체된다.
  const frameId = await attachDebuggerForResourceFetch(tabId);

  const downloadResults = [];
  try {
    for (const { url, localFilename } of resources) {
      const filename = `${safeTitle}_files/${localFilename}`;
      let res;
      if (frameId) {
        const fetched = await fetchResourceViaDebugger(tabId, frameId, url).catch((err) => ({
          ok: false,
          detail: err.message,
        }));
        if (fetched.ok) {
          const base64 = await arrayBufferToBase64(fetched.bytes.buffer);
          res = await downloadResource(url, `data:application/octet-stream;base64,${base64}`, filename);
        } else {
          console.warn(`[자동 스크롤 후 페이지 저장] 리소스 CDP 조회 실패: ${url}`, fetched.detail);
          res = { url, filename, ok: false, detail: fetched.detail };
        }
      } else {
        res = await downloadResource(url, url, filename);
      }
      downloadResults.push(res);
    }
  } finally {
    if (frameId) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }

  // 리소스별 실제 다운로드 결과(성공/실패 사유)를 별도 파일로 남긴다 —
  // chrome.downloads.download 콜백만으로는 "큐잉 성공"과 "실제 파일 완성"을
  // 구분할 수 없어서, 크롬이 조용히 막는 경우를 눈으로 확인하기 위함.
  // 평소엔 DEBUG_FILES_ENABLED로 꺼 두고, 문제가 생기면 켜서 쓴다.
  if (DEBUG_FILES_ENABLED) {
    const resultText = [
      `extension_version: ${chrome.runtime.getManifest().version}`,
      `checked_at: ${new Date().toISOString()}`,
      `ok_count: ${downloadResults.filter((r) => r.ok).length} / ${downloadResults.length}`,
      'results:',
      ...downloadResults.map((r) => `  [${r.ok ? 'OK' : 'FAIL'}] ${r.filename}  (${r.detail})  <-  ${r.url}`),
    ].join('\n');
    const resultBase64 = await arrayBufferToBase64(new TextEncoder().encode(resultText).buffer);
    await chrome.downloads.download({
      url: `data:text/plain;charset=utf-8;base64,${resultBase64}`,
      filename: `${safeTitle}.debug-result.txt`,
      saveAs: false,
    });
  }

  const htmlBytes = new TextEncoder().encode(html);
  const htmlBase64 = await arrayBufferToBase64(htmlBytes.buffer);
  const htmlDataUrl = `data:text/html;charset=utf-8;base64,${htmlBase64}`;
  await chrome.downloads.download({ url: htmlDataUrl, filename: `${safeTitle}.html`, saveAs: false });
}

// 현재 페이지의 "다음화" 링크(있으면 절대 URL, 없거나 비활성화면 null)를
// content-capture와 별개로 페이지에 주입해서 읽어온다.
async function findNextEpisodeUrlForTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: findNextEpisodeUrl,
  });
  return result || null;
}

// tabId를 url로 이동시키고, 그 이동이 완료(status: 'complete')될 때까지
// 기다린다. tabs.update 호출 전에 리스너를 먼저 달아서, 아주 빠른 이동에서
// 완료 이벤트를 놓치는 경쟁 상태를 피한다.
function navigateAndWaitForLoad(tabId, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish(new Error('페이지 로딩 대기 시간 초과')), timeoutMs);
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) finish(new Error(chrome.runtime.lastError.message));
    });
  });
}

// tabId -> { stopRequested } — 진행 중인 탭을 추적해서, 진행 중에 아이콘을
// 다시 클릭하면 새로 시작하는 대신 중단 신호를 보내도록 한다.
const runningTabs = new Map();

// 아이콘 클릭 시 진입점. 클릭된 페이지부터 시작해서, "다음화" 링크를 계속
// 따라가며 매 화마다 스크롤+캡처+저장을 반복한다. "다음화"가 비활성화된
// (링크 자체가 없어진) 마지막 화에 도달하면 멈춘다. 배지에는 지금까지 저장한
// 화 수를 표시한다. 저장 중인 화의 다운로드는 끝까지 마친 뒤, 다음 화로
// 넘어가기 전에 중단 여부를 확인한다(중간에 파일이 절반만 받아지는 것을 방지).
async function handleCaptureAllChapters(initialTab) {
  if (!initialTab || !initialTab.id) return;
  const tabId = initialTab.id;
  const state = { stopRequested: false };
  runningTabs.set(tabId, state);
  const stopKeepAlive = startKeepAlive();
  let tab = initialTab;

  try {
    for (let chapterCount = 1; chapterCount <= MAX_CHAPTERS; chapterCount++) {
      if (state.stopRequested) break;

      await chrome.action.setBadgeText({ tabId, text: String(chapterCount) });
      await captureCurrentPage(tab);

      if (state.stopRequested) break;

      const nextUrl = await findNextEpisodeUrlForTab(tabId);
      if (!nextUrl) break;

      await navigateAndWaitForLoad(tabId, nextUrl);
      // 'complete' 상태 직후에도 페이지 자체의 초기화 스크립트(광고, 뷰어 초기화 등)가
      // 아직 안 끝났을 수 있어 짧게 대기한다.
      await new Promise((resolve) => setTimeout(resolve, 500));
      tab = await chrome.tabs.get(tabId);
    }

    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch (err) {
    console.error('[자동 스크롤 후 페이지 저장] 실패:', err);
    await chrome.action.setBadgeText({ tabId, text: 'X' });
  } finally {
    stopKeepAlive();
    runningTabs.delete(tabId);
  }
}

chrome.action.onClicked.addListener((tab) => {
  const existing = runningTabs.get(tab.id);
  if (existing) {
    // 이미 이 탭에서 진행 중이면 새로 시작하지 않고 중단 신호만 보낸다.
    existing.stopRequested = true;
    return;
  }
  handleCaptureAllChapters(tab);
});
