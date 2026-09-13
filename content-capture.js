// chrome.scripting.executeScript({ files: ['content-capture.js'] })로 페이지 컨텍스트에
// 주입되어 실행된다. 결과는 반환값이 아니라 window.__autoScrollSaveResult에 담아두고,
// 별도의 func 주입으로 그 값을 읽어간다 (files 주입은 반환값 전달이 불안정하기 때문).
(function () {
  const resourceMap = new Map(); // 절대 URL -> 로컬 파일명
  const usedNames = new Set();

  function toAbsoluteUrl(url) {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch (e) {
      return null;
    }
  }

  function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_');
  }

  function makeLocalFilename(absUrl) {
    let base = 'file';
    try {
      const u = new URL(absUrl);
      const segments = u.pathname.split('/').filter(Boolean);
      if (segments.length) base = decodeURIComponent(segments[segments.length - 1]);
    } catch (e) {
      // URL 파싱 실패 시 기본값 사용
    }
    base = sanitizeFilename(base) || 'file';

    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const dotIdx = base.lastIndexOf('.');
    const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
    const ext = dotIdx > 0 ? base.slice(dotIdx) : '';
    let i = 1;
    let candidate = `${stem}_${i}${ext}`;
    while (usedNames.has(candidate)) {
      i += 1;
      candidate = `${stem}_${i}${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
  }

  function registerResource(url) {
    const abs = toAbsoluteUrl(url);
    if (!abs || abs.startsWith('data:')) return null;
    if (resourceMap.has(abs)) return resourceMap.get(abs);
    const localName = makeLocalFilename(abs);
    resourceMap.set(abs, localName);
    return localName;
  }

  const CSS_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

  function collectUrlsFromCssText(cssText) {
    const urls = [];
    let match;
    CSS_URL_RE.lastIndex = 0;
    while ((match = CSS_URL_RE.exec(cssText)) !== null) {
      urls.push(match[2]);
    }
    return urls;
  }

  function rewriteCssText(cssText) {
    return cssText.replace(CSS_URL_RE, (full, quote, url) => {
      const abs = toAbsoluteUrl(url);
      if (abs && resourceMap.has(abs)) {
        return `url(${resourceMap.get(abs)})`;
      }
      return full;
    });
  }

  // 지연 로딩 라이브러리들이 실제 URL을 담아두는 흔한 속성 이름들.
  // 이 값이 있으면 src는 보통 가짜 placeholder(예: sprite.png, 1x1 gif)이므로
  // 스크롤로 스왑되길 기다리지 않고 이 속성에서 바로 진짜 URL을 읽는다.
  const LAZY_SRC_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy'];
  const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];

  function pickFirstSrcsetUrl(srcset) {
    if (!srcset) return null;
    const first = srcset.split(',')[0].trim().split(/\s+/)[0];
    return first || null;
  }

  // 1. img (+ 지연 로딩 속성 + srcset 대표 1개)
  document.querySelectorAll('img').forEach((img) => {
    const lazyAttr = LAZY_SRC_ATTRS.find((attr) => img.hasAttribute(attr));
    const realSrc = lazyAttr ? img.getAttribute(lazyAttr) : img.getAttribute('src');
    if (realSrc) registerResource(realSrc);

    const lazySrcsetAttr = LAZY_SRCSET_ATTRS.find((attr) => img.hasAttribute(attr));
    const srcset = lazySrcsetAttr ? img.getAttribute(lazySrcsetAttr) : img.getAttribute('srcset');
    const firstFromSrcset = pickFirstSrcsetUrl(srcset);
    if (firstFromSrcset) registerResource(firstFromSrcset);
  });

  // 1-1. <picture> 안의 <source srcset> 대표 1개 (반응형/최신 포맷 이미지에서
  // 실제로는 <source>가 선택되고 <img>는 폴백으로만 쓰이는 경우가 흔함)
  document.querySelectorAll('picture source[srcset]').forEach((source) => {
    const srcset = source.getAttribute('srcset');
    if (srcset) {
      const first = srcset.split(',')[0].trim().split(/\s+/)[0];
      if (first) registerResource(first);
    }
  });

  // 1-2. <video poster>
  document.querySelectorAll('video[poster]').forEach((video) => {
    registerResource(video.getAttribute('poster'));
  });

  // 2. 인라인 style 속성 (background-image 등)
  document.querySelectorAll('[style]').forEach((el) => {
    collectUrlsFromCssText(el.getAttribute('style') || '').forEach(registerResource);
  });

  // 3. <style> 태그
  document.querySelectorAll('style').forEach((styleEl) => {
    collectUrlsFromCssText(styleEl.textContent || '').forEach(registerResource);
  });

  // 4. <link rel="stylesheet">
  document.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    registerResource(link.getAttribute('href'));
  });

  // 5. 각 스타일시트 내부 url(...) (동일 출처만; cross-origin은 SecurityError로 건너뜀)
  Array.from(document.styleSheets).forEach((sheet) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      return;
    }
    if (!rules) return;
    Array.from(rules).forEach((rule) => {
      const cssText = (rule.style && rule.style.cssText) || rule.cssText;
      if (cssText) collectUrlsFromCssText(cssText).forEach(registerResource);
    });
  });

  // 6. favicon (선택 사항)
  document.querySelectorAll('link[rel~="icon"]').forEach((link) => {
    registerResource(link.getAttribute('href'));
  });

  // --- HTML 재작성: 실제 DOM은 건드리지 않고 복제본 위에서만 치환 ---
  const clone = document.documentElement.cloneNode(true);

  clone.querySelectorAll('img').forEach((img) => {
    const lazyAttr = LAZY_SRC_ATTRS.find((attr) => img.hasAttribute(attr));
    const realSrc = lazyAttr ? img.getAttribute(lazyAttr) : img.getAttribute('src');
    const abs = toAbsoluteUrl(realSrc);
    if (abs && resourceMap.has(abs)) {
      img.setAttribute('src', resourceMap.get(abs));
    }
    LAZY_SRC_ATTRS.forEach((attr) => img.removeAttribute(attr));
    LAZY_SRCSET_ATTRS.forEach((attr) => img.removeAttribute(attr));
    if (img.hasAttribute('srcset')) {
      img.removeAttribute('srcset');
    }
  });

  // <picture><source>는 포맷/해상도별 후보라 완전히 재현하기 어려우므로 제거하고,
  // 항상 함께 있는 <img> 폴백(바로 위에서 로컬 경로로 치환됨)만 쓰게 한다.
  clone.querySelectorAll('picture source').forEach((source) => {
    source.remove();
  });

  clone.querySelectorAll('video[poster]').forEach((video) => {
    const abs = toAbsoluteUrl(video.getAttribute('poster'));
    if (abs && resourceMap.has(abs)) {
      video.setAttribute('poster', resourceMap.get(abs));
    }
  });

  clone.querySelectorAll('[style]').forEach((el) => {
    el.setAttribute('style', rewriteCssText(el.getAttribute('style') || ''));
  });

  clone.querySelectorAll('style').forEach((styleEl) => {
    styleEl.textContent = rewriteCssText(styleEl.textContent || '');
  });

  clone.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    const abs = toAbsoluteUrl(link.getAttribute('href'));
    if (abs && resourceMap.has(abs)) {
      link.setAttribute('href', resourceMap.get(abs));
    }
  });

  clone.querySelectorAll('link[rel~="icon"]').forEach((link) => {
    const abs = toAbsoluteUrl(link.getAttribute('href'));
    if (abs && resourceMap.has(abs)) {
      link.setAttribute('href', resourceMap.get(abs));
    }
  });

  const html = '<!DOCTYPE html>\n' + clone.outerHTML;
  const resources = Array.from(resourceMap.entries()).map(([url, localFilename]) => ({
    url,
    localFilename,
  }));

  window.__autoScrollSaveResult = { html, resources };
})();
