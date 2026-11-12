const errors = {
  'not-allowed': '麦克风授权被拒绝，请检查浏览器设置或继续打字。',
  'service-not-allowed': '浏览器未开放识别服务，请继续打字。',
  'audio-capture': '找不到可用麦克风，请检查设备。',
  'network': '识别服务网络异常，请重试或打字。',
  'no-speech': '没有识别到语音，请重新录音。',
  'language-not-supported': '当前环境不支持此语言，请继续打字。'
};

export function validateTranscript(value) {
  const text = String(value).trim();
  if (!text || text.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new Error('请输入 1 至 20000 字的有效文本。');
  }
  return text;
}

// Adapter contract: start({language, onState, onResult, onError}), stop(), cancel().
export class BrowserAsrAdapter {
  constructor(env = globalThis, limits = {}) {
    this.env = env;
    this.limits = { permission: 15000, recording: 60000, recognition: 10000, cooldown: 1500, ...limits };
    this.lastStart = -Infinity;
    this.session = null;
  }
  get supported() { return !!(this.env.isSecureContext && (this.env.SpeechRecognition || this.env.webkitSpeechRecognition)); }
  start(callbacks) {
    if (this.session) return false;
    if (!this.supported) { callbacks.onError('当前环境不支持语音识别，请在 HTTPS 或 localhost 使用支持的浏览器，文字输入仍可用。'); return false; }
    if (Date.now() - this.lastStart < this.limits.cooldown) { callbacks.onError('操作过快，请稍后重新录音。'); return false; }
    this.lastStart = Date.now();
    const Recognition = this.env.SpeechRecognition || this.env.webkitSpeechRecognition;
    const session = { recognition: new Recognition(), callbacks, text: '', timer: null };
    this.session = session;
    const recognition = session.recognition;
    recognition.lang = callbacks.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    const active = () => this.session === session;
    const fail = message => { if (active()) { this.cancel(); callbacks.onError(message); } };
    recognition.onstart = () => {
      if (!active() || session.stopping) return;
      callbacks.onState('recording');
      this.arm(session, this.limits.recording, () => this.stop());
    };
    recognition.onresult = event => {
      if (!active()) return;
      session.text = Array.from(event.results, result => result[0].transcript).join('');
    };
    recognition.onspeechend = () => { if (active()) this.stop(); };
    recognition.onerror = event => fail(errors[event.error] || '语音识别失败，请重新录音或继续打字。');
    recognition.onend = () => {
      if (!active()) return;
      const text = session.text;
      this.release(session);
      try { callbacks.onResult(validateTranscript(text)); }
      catch (error) { callbacks.onError(text ? error.message : errors['no-speech']); }
    };
    callbacks.onState('requesting');
    this.arm(session, this.limits.permission, () => fail('授权或启动超时，请重试；文字输入仍可用。'));
    try { recognition.start(); } catch { fail('无法启动麦克风，请重试或继续打字。'); }
    return active();
  }
  arm(session, duration, action) {
    this.env.clearTimeout(session.timer);
    session.timer = this.env.setTimeout(action, duration);
  }
  stop() {
    const session = this.session;
    if (!session || session.stopping) return;
    session.stopping = true;
    session.callbacks.onState('recognizing');
    this.arm(session, this.limits.recognition, () => {
      if (this.session !== session) return;
      this.cancel();
      session.callbacks.onError('识别超时，请重新录音或继续打字。');
    });
    try { session.recognition.stop(); } catch { this.cancel(); session.callbacks.onError('停止录音失败，请重试。'); }
  }
  release(session) {
    this.env.clearTimeout(session.timer);
    for (const name of ['onstart', 'onresult', 'onspeechend', 'onerror', 'onend']) session.recognition[name] = null;
    if (this.session === session) this.session = null;
  }
  cancel() {
    const session = this.session;
    if (!session) return;
    this.release(session);
    try { session.recognition.abort(); } catch { /* Already stopped. */ }
  }
}

// TTS reads only the visible, current response after an explicit click.
export class BrowserTtsAdapter {
  constructor(env = globalThis) { this.env = env; }
  get supported() { return !!(this.env.speechSynthesis && this.env.SpeechSynthesisUtterance); }
  speak(text, language, onEnd, onError) {
    this.stop();
    const utterance = new this.env.SpeechSynthesisUtterance(text.slice(0, 20000));
    utterance.lang = language;
    utterance.onend = onEnd;
    utterance.onerror = onError;
    this.env.speechSynthesis.speak(utterance);
  }
  stop() { this.env.speechSynthesis?.cancel(); }
}

export function mountVoice({ input, reply, host, asr = new BrowserAsrAdapter(), tts = new BrowserTtsAdapter() }) {
  const box = document.createElement('section');
  box.className = 'voice-banking';
  box.innerHTML = `<p class="small muted">语音输入原型：浏览器服务可能将音频发送到其服务商处理；本应用不保存原始音频。请只使用虚构演示信息。</p>
    <label class="voice-consent"><input type="checkbox" data-voice-consent>我同意本次由浏览器语音服务处理音频</label>
    <div class="voice-controls"><label>语言 <select data-voice-language><option value="zh-CN">普通话</option><option value="en-US">English</option></select></label>
    <button type="button" data-voice-start aria-label="开始语音输入"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3" fill="none" stroke="currentColor"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" fill="none" stroke="currentColor"/></svg>开始录音</button>
    <button type="button" data-voice-stop disabled>停止录音</button><button type="button" data-voice-cancel disabled>取消</button></div>
    <p data-voice-status role="status" aria-live="polite">空闲：转写后请编辑核对，再手动发送。语音不会执行资金操作。</p>
    <div class="voice-controls"><button type="button" data-voice-read>朗读当前回复</button><button type="button" data-voice-silence>停止朗读</button><span>自动朗读已关闭</span></div>`;
  host.append(box);
  const find = selector => box.querySelector(selector);
  const status = find('[data-voice-status]');
  const start = find('[data-voice-start]'), stop = find('[data-voice-stop]'), cancel = find('[data-voice-cancel]');
  const consent = find('[data-voice-consent]'), language = find('[data-voice-language]');
  let busy = false, base = '', speechVersion = 0;
  const stopSpeech = () => { speechVersion++; tts.stop(); };
  const state = (name, message) => {
    busy = ['requesting', 'recording', 'recognizing'].includes(name);
    box.dataset.state = name;
    status.textContent = message || ({ requesting: '正在请求授权…', recording: '录音中，最长 60 秒。', recognizing: '识别中…', idle: '已取消，可重新录音；原有文字已保留。' }[name]);
    start.disabled = busy || !asr.supported;
    stop.disabled = name !== 'recording';
    cancel.disabled = !busy;
    language.disabled = busy;
    start.lastChild.textContent = name === 'success' || name === 'error' ? '重新录音' : '开始录音';
  };
  start.disabled = !asr.supported;
  if (!asr.supported) state('error', '此环境不支持语音识别，文字输入仍可用。');
  start.addEventListener('click', () => {
    if (busy) return;
    if (!consent.checked) { status.textContent = '请先同意本次音频处理，再点击开始录音。'; return; }
    stopSpeech();
    base = input.value;
    asr.start({ language: language.value, onState: state,
      onError: message => state('error', message),
      onResult: text => {
        input.value = [base, text].filter(Boolean).join(' ');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        state('success', '识别成功：请编辑核对文本，再手动发送。');
        input.focus();
      }
    });
  });
  stop.addEventListener('click', () => asr.stop());
  const cancelRecording = () => { asr.cancel(); if (busy) state('idle'); };
  cancel.addEventListener('click', cancelRecording);
  consent.addEventListener('change', () => { if (!consent.checked) cancelRecording(); });
  // Editing or sending during recognition wins over any late callback.
  input.addEventListener('input', () => { if (busy) cancelRecording(); });
  const read = find('[data-voice-read]');
  read.disabled = !tts.supported;
  read.addEventListener('click', () => {
    const element = reply();
    if (!element || !element.getClientRects().length || !element.innerText.trim()) { status.textContent = '暂无已展示的回复可朗读。'; return; }
    cancelRecording();
    const version = ++speechVersion;
    tts.speak(element.innerText, language.value,
      () => { if (version === speechVersion) status.textContent = '朗读结束。'; },
      () => { if (version === speechVersion) status.textContent = '朗读失败，可继续阅读文字。'; });
    status.textContent = '正在朗读已展示的回复…';
  });
  find('[data-voice-silence]').addEventListener('click', () => { stopSpeech(); status.textContent = '朗读已停止。'; });
  const cleanup = () => { cancelRecording(); stopSpeech(); };
  const hidden = () => { if (document.hidden) cleanup(); };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('hashchange', cleanup);
  const observer = new MutationObserver(() => { if (tts.supported) stopSpeech(); });
  const response = reply();
  if (response) observer.observe(response, { childList: true, subtree: true, characterData: true, attributes: true });
  const speechControls = read.parentElement;
  if (response) { speechControls.classList.add('voice-reply-controls'); response.after(speechControls); }
  return { cancel: cleanup, destroy() { cleanup(); observer.disconnect(); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', cleanup); window.removeEventListener('hashchange', cleanup); speechControls.remove(); box.remove(); } };
}
