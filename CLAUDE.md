# 작업 지시서: "자동 스크롤 후 페이지 저장" 크롬 확장 프로그램

## 배경 / 목적
일부 웹사이트는 이미지가 지연 로딩(lazy loading) 방식으로 구현되어 있어,
사용자가 스크롤을 내려야만 이미지가 실제로 로드된다. 이 상태에서 크롬의
"저장" 기능(Ctrl+S)을 사용하면 아직 로드되지 않은 이미지는 저장되지 않는
문제가 있다.

이 문제를 해결하기 위해, 확장 프로그램 아이콘을 한 번 클릭하면 다음을
자동으로 수행하는 크롬 확장 프로그램(Manifest V3)을 만든다.

1. 현재 탭의 페이지를 끝까지 자동으로 스크롤하여 지연 로딩 이미지를 모두 트리거
2. 화면에 있는 모든 `<img>` 요소가 로드 완료(`complete === true`)될 때까지 대기
3. 크롬의 기본 저장 방식인 **"웹페이지, 전체"(HTML 파일 + 리소스 폴더)** 형식으로 저장
   - `<페이지제목>.html` — 리소스 경로가 로컬 폴더를 가리키도록 수정된 HTML
   - `<페이지제목>_files/` — 이미지, CSS 등 리소스 파일들이 저장되는 폴더

> 중요: 크롬 확장 API에는 "웹페이지, 전체" 저장을 그대로 재현해주는 API가
> 없다 (`chrome.pageCapture`는 MHTML 단일 파일만 지원). 따라서 이 기능은
> 아래 명세대로 **직접 구현**해야 한다: DOM을 직렬화하고, 리소스를 각각
> 다운로드하고, HTML 안의 참조 경로를 로컬 경로로 바꿔치기하는 방식이다.

## 결과물 (파일 구조)
```
auto-scroll-save/
├── manifest.json
├── background.js
├── content-capture.js   (DOM 캡처 + 리소스 목록 수집 + HTML 재작성)
└── README.md (또는 사용법.txt) - 설치/사용법 안내
```

## 기술 요구사항

### manifest.json
- `manifest_version: 3`
- 이름/설명: 한국어로 작성 (예: "자동 스크롤 후 페이지 저장")
- `permissions`: `["activeTab", "scripting", "downloads"]`
  (MHTML 방식을 쓰지 않으므로 `pageCapture` 권한은 더 이상 필요 없음)
- `host_permissions`: `["<all_urls>"]`
  (리소스 파일을 `fetch`로 받아오려면 대상 사이트에 대한 호스트 권한 필요)
- `action`: 기본 아이콘 클릭 시 동작 (별도 popup 없이 `chrome.action.onClicked` 사용)
- `background.service_worker`: `background.js`

### 처리 흐름 (background.js가 오케스트레이션)

**A. 트리거**
- `chrome.action.onClicked` 리스너에서 시작. 클릭된 탭(`tab`)을 대상으로 동작.
- 진행 표시: `chrome.action.setBadgeText({tabId, text: "..."})`.

**B. 자동 스크롤 + 이미지 로딩 대기** (기존과 동일, 변경 없음)
- `chrome.scripting.executeScript`로 페이지 컨텍스트에 스크롤 함수 주입
  - `window.scrollBy`로 일정 간격(기본 500px, 350ms 간격) 반복 스크롤,
    `document.body.scrollHeight`에 도달하면 종료
  - 이후 `document.images`의 모든 `img.complete`가 `true`가 될 때까지
    최대 8초 폴링 대기 (300ms 간격)
  - 완료 후 `window.scrollTo(0, 0)`으로 상단 복귀
  - async function + Promise 반환, `intervalMs`/`maxWaitMs` 상수로 분리

**C. 리소스 수집 및 HTML 재작성 (content-capture.js, 페이지 컨텍스트에서 실행)**

이 단계는 `chrome.scripting.executeScript`로 주입되는 별도 함수/파일로 구현한다.

1. **리소스 URL 수집** — 아래 항목들을 순회하며 절대 URL 목록을 만든다.
   - `img[src]` (및 `srcset`이 있다면 그 중 대표 1개 URL도 포함)
   - 인라인 `style` 속성 또는 `<style>` 태그 내 `background-image: url(...)`
   - `<link rel="stylesheet">`의 `href`
   - 각 스타일시트 내부의 `url(...)` 참조 (`document.styleSheets`의 `cssRules`를
     순회하며 추출; **동일 출처(same-origin)가 아니어서 `cssRules` 접근 시
     보안 오류(SecurityError)가 나는 경우는 try/catch로 건너뛰고, 해당
     스타일시트 파일 자체는 리소스로만 받아온다** — 즉 재귀적으로 내부까지
     처리하지 않는 것을 1차 버전의 범위로 한다)
   - `<link rel="icon">` (favicon, 선택 사항)
2. **중복 제거**: 동일 URL은 한 번만 다운로드하도록 Map으로 관리 (URL → 로컬 파일명)
3. **로컬 파일명 생성 규칙**:
   - URL의 pathname에서 마지막 세그먼트를 기본 파일명으로 사용
   - 쿼리 스트링 제거, 확장자가 없으면 추정하기 어려우므로 원본 URL을
     그대로 유지한 채 확장자만 비워두고 다운로드 (브라우저가 Content-Type
     기반으로 처리하도록 둠) — 단순화를 위해 확장자 추정 로직은 필수는 아님
   - 파일명 충돌 시 `_1`, `_2` 등 숫자 접미사로 구분
   - 폴더명은 `${safeTitle}_files`로 통일 (아래 D 참고)
4. **HTML 재작성**:
   - **실제 DOM을 건드리지 않고**, `document.documentElement.cloneNode(true)`로
     복제본을 만들어 그 위에서 속성을 치환한다 (라이브 페이지에 영향 없어야 함)
   - 수집된 각 리소스 URL을 위 로컬 파일명으로 교체
     (예: `src="https://site.com/img/a.jpg"` → `src="제목_files/a.jpg"`)
   - 최종적으로 `'<!DOCTYPE html>\n' + clonedElement.outerHTML`을 완성된
     HTML 문자열로 만든다
5. 이 단계의 결과로 아래 두 가지를 background.js로 반환한다:
   - 완성된 HTML 문자열
   - 리소스 목록: `[{ url, localFilename }, ...]`

**D. 다운로드 처리 (background.js)**

1. 탭 제목(`tab.title`) 기반으로 `safeTitle` 생성
   (파일명에 쓸 수 없는 특수문자 `\ / : * ? " < > |` 제거)
2. **리소스 파일들 먼저 다운로드**:
   - **원본 URL을 그대로 `chrome.downloads.download`에 전달**한다 —
     `fetch(url)`로 받아 base64 data URL로 변환하는 방식은 쓰지 않는다.
     (결정 배경: `fetch()`는 CORS 정책의 적용을 받아, `<img>` 태그로는
     문제없이 보이는 이미지도 다운로드 단계에서 실패하는 경우가 많았다.
     `chrome.downloads.download`는 일반 브라우저 다운로드와 동일하게
     동작해 CORS 제약을 받지 않으므로, 실제 리소스 URL을 그대로 넘긴다.)
   - `chrome.downloads.download({ url, filename: "${safeTitle}_files/${localFilename}", saveAs: false }, callback)`
     — `filename`에 `/`를 포함하면 다운로드 폴더 하위에 해당 경로로 폴더가
     자동 생성됨. 콜백에서 `chrome.runtime.lastError`를 확인해 실패한
     리소스는 콘솔에 경고 로그만 남기고 건너뛴다 (전체 프로세스를
     중단시키지 않음)
   - (참고) `fetch` → base64 data URL 변환 방식은 **동적으로 생성한
     HTML 문자열**처럼 실제 네트워크 URL이 없는 콘텐츠를 다운로드할
     때만 사용한다 (아래 3번 참고)
3. **HTML 파일 다운로드**:
   - 재작성된 HTML 문자열을 data URL(`data:text/html;charset=utf-8;base64,...`)로 변환
   - `chrome.downloads.download({ url: dataUrl, filename: "${safeTitle}.html", saveAs: false })`
     — 대화상자 없이 바로 저장 (아래 "저장 위치" 참고)

> **저장 위치: 결정됨 — 로컬 `E:\Temp` 고정**. `chrome.downloads.download`의
> `filename`은 항상 크롬의 **현재 기본 다운로드 폴더 기준 상대 경로**만
> 허용하며(절대 경로를 넣으면 `chrome.runtime.lastError`로 에러가 나고
> 다운로드가 시작되지 않음), 확장 프로그램이 API로 그 기본 폴더 자체를
> 바꿀 수는 없다. 따라서 이 확장은:
> - HTML/리소스 파일 모두 `saveAs: false` + 상대 경로(`${safeTitle}.html`,
>   `${safeTitle}_files/...`)로만 다운로드한다 (대화상자 없음).
> - 대신 **크롬의 기본 다운로드 위치 자체를 `E:\Temp`로 설정**해 둘 것을
>   전제로 한다 — `chrome://settings/downloads`에서 "저장 위치"를
>   `E:\Temp`로 1회 변경. 이렇게 하면 HTML과 `_files` 폴더가 항상 같은
>   위치(`E:\Temp`)에 함께 저장된다.
> - README에 위 사전 설정 방법을 안내 문구로 반드시 포함할 것.

4. 완료/실패 시 배지 텍스트 초기화 또는 실패 표시("X")

**E. 에러 처리**
- 각 단계(스크립트 주입 실패, 개별 리소스 fetch 실패, 다운로드 실패)를
  구분해서 콘솔에 로그 남길 것
- 개별 리소스 실패는 전체를 중단하지 않고 "일부 리소스 누락"으로 계속 진행
- 치명적 실패(HTML 자체 다운로드 실패 등)만 배지에 "X" 표시

## 안내 문서 (README/사용법)
다음 내용을 한국어로 포함할 것:
- 개발자 모드로 "압축해제된 확장 프로그램 로드" 하는 설치 방법
- **(필수 사전 설정)** `chrome://settings/downloads`에서 크롬 기본 다운로드
  위치를 `E:\Temp`로 변경해야 한다는 안내 (이 확장은 대화상자 없이 항상
  기본 다운로드 폴더에 저장하므로, 이 설정을 해 두지 않으면 다른 폴더에
  저장됨)
- 사용 방법 (아이콘 클릭 → 자동 스크롤 → HTML+폴더 저장)
- 스크롤 간격/대기시간 조정 방법 안내
- 저장 결과물이 `E:\Temp\<제목>.html` + `E:\Temp\<제목>_files\` 폴더
  형태라는 점, 둘을 항상 같은 위치에 함께 두어야 이미지가 정상적으로
  보인다는 점
- 위 "저장 위치" 항목에서 결정한 처리 방식(항상 `E:\Temp`) 안내
- CORS 등으로 일부 외부 리소스(다른 도메인의 이미지/폰트 등)는
  다운로드에 실패할 수 있고, 이 경우 해당 리소스만 원본 URL 링크로
  남는다는 점 (재작성 단계에서 fetch 실패한 리소스는 로컬 경로로
  치환하지 않고 원본 URL을 그대로 둘 것)
- 일부 사이트는 CSP 등 보안 정책으로 스크립트 실행이 제한될 수 있다는 안내

## 테스트 체크리스트
- [ ] 지연 로딩 이미지가 있는 실제 페이지(예: 무한 스크롤 갤러리)에서 동작 확인
- [ ] 스크롤이 페이지 최하단까지 정상적으로 도달하는지 확인
- [ ] 저장된 `<제목>.html`을 더블클릭(또는 크롬으로 열기)했을 때
      `<제목>_files/` 폴더의 이미지들이 정상적으로 보이는지 확인
- [ ] 이미지가 많은 페이지에서 리소스 다운로드가 모두 완료된 후에
      HTML 다운로드가 시작되는지(순서) 확인
- [ ] 동일 파일명이 여러 개 있는 리소스가 있을 때 파일명 충돌 없이
      번호가 붙어 저장되는지 확인
- [ ] 외부 도메인 리소스(CORS로 fetch 실패하는 경우)가 있을 때
      전체 프로세스가 중단되지 않고, 해당 리소스만 원본 URL로 남는지 확인
- [ ] 동일 출처가 아닌 스타일시트의 `cssRules` 접근 시 오류 없이
      건너뛰는지 확인
- [ ] 매우 긴 페이지 / 리소스가 많은 페이지에서도 base64 변환 중
      오류가 나지 않는지 확인 (청크 처리 검증)
- [ ] 캡처/다운로드 실패 시 콘솔에 에러가 남고 배지가 실패 상태로 바뀌는지 확인

## 참고
- Manifest V3 서비스 워커 제약(예: 일부 DOM API 미지원)을 고려해 구현할 것
- `chrome.downloads`, `chrome.scripting` 공식 문서 기준으로 API 시그니처를
  확인하고 최신 방식으로 구현할 것
- 이 방식은 크롬의 실제 "웹페이지, 전체" 저장 기능과 **완전히 동일하지는
  않은 근사치**임을 인지할 것 (예: JS 파일은 기본적으로 수집 대상에서
  제외 — 필요하면 범위를 넓혀 `<script src>`도 리소스로 포함하도록 확장 가능)

## 버전 관리 (manifest.json의 version)
작업 성격에 따라 `manifest.json`의 `version`을 다음 규칙으로 올린다 (`x.y.z` = major.minor.patch):
- **일반 수정** (버그 수정, 작은 개선 등): patch를 올린다. 예) `1.0.0` → `1.0.1`
- **배포**: minor를 올리고 patch는 0으로 초기화한다. 예) `1.0.5` → `1.1.0`
- **확정** (주요 버전 확정/릴리스): major를 올리고 minor/patch는 0으로 초기화한다. 예) `1.3.2` → `2.0.0`

## 작업 원칙 (git)
- 이 문서(CLAUDE.md)를 고칠 때 별도의 백업(history 폴더 등)은 두지 않는다 —
  git 커밋 이력이 변경 기록 역할을 한다. 의미 있는 단위로 커밋한다.
- 사용자 명령으로 파일이 수정되고 작업이 성공적으로 끝나면, 별도 요청/확인
  없이 git commit(커밋 메시지는 영어로 직접 작성)과 push까지 수행한다.
