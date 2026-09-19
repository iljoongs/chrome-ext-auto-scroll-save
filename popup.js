const TITLE_KEY = 'autoScrollSave.title';
const MODE_KEY = 'autoScrollSave.mode';

const runningEl = document.getElementById('running');
const idleEl = document.getElementById('idle');
const titleEl = document.getElementById('title');

function sendMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

function loadSaved(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    // 저장 못 해도 동작에는 지장 없음
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const status = await sendMessage({ type: 'status', tabId: tab.id });
  if (status && status.running) {
    runningEl.hidden = false;
    document.getElementById('stop').addEventListener('click', async () => {
      await sendMessage({ type: 'stop', tabId: tab.id });
      window.close();
    });
    return;
  }

  idleEl.hidden = false;
  titleEl.value = loadSaved(TITLE_KEY) || '';
  const savedMode = loadSaved(MODE_KEY);
  if (savedMode) {
    const radio = document.querySelector(`input[name="mode"][value="${savedMode}"]`);
    if (radio) radio.checked = true;
  }
  titleEl.focus();

  document.getElementById('start').addEventListener('click', async () => {
    const title = titleEl.value.trim();
    const mode = document.querySelector('input[name="mode"]:checked').value;
    save(TITLE_KEY, title);
    save(MODE_KEY, mode);
    await sendMessage({ type: 'start', tabId: tab.id, mode, title });
    window.close();
  });
}

init();
