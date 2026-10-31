import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAsrAdapter, BrowserTtsAdapter, validateTranscript } from '../versions/voice-banking.mjs';

function fixture(limits = {}) {
  let recognition;
  const timers = new Map();
  let id = 0;
  class Recognition {
    constructor() { recognition = this; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; }
  }
  const env = { isSecureContext: true, SpeechRecognition: Recognition,
    setTimeout: callback => { timers.set(++id, callback); return id; }, clearTimeout: key => timers.delete(key) };
  const events = [];
  const adapter = new BrowserAsrAdapter(env, { cooldown: 0, ...limits });
  const callbacks = { onState: s => events.push(s), onResult: t => events.push(t), onError: e => events.push(e) };
  return { adapter, callbacks, events, timers, env, get recognition() { return recognition; }, expire() { [...timers.values()][0](); } };
}

test('input validation accepts Chinese and rejects empty, oversized and control text', () => {
  assert.equal(validateTranscript(' 分析我的组合 '), '分析我的组合');
  for (const input of ['', 'a'.repeat(20001), 'a\u0000']) assert.throws(() => validateTranscript(input));
});
test('permission is requested only on start; repeated start is ignored', () => {
  const f = fixture();
  assert.equal(f.recognition, undefined);
  f.adapter.start(f.callbacks);
  assert.equal(f.recognition.started, true);
  assert.equal(f.adapter.start(f.callbacks), false);
  assert.deepEqual(f.events, ['requesting']);
});
test('success returns editable text once after end and releases timers and handlers', () => {
  const f = fixture(); f.adapter.start(f.callbacks);
  f.recognition.onstart();
  f.recognition.onresult({ results: [[{ transcript: '分析组合' }]] });
  f.adapter.stop(); f.recognition.onend();
  assert.deepEqual(f.events, ['requesting', 'recording', 'recognizing', '分析组合']);
  assert.equal(f.adapter.session, null); assert.equal(f.timers.size, 0);
});
for (const code of ['not-allowed', 'audio-capture', 'network', 'no-speech', 'service-not-allowed', 'unknown']) {
  test(`recognition error ${code} releases microphone and permits recovery`, () => {
    const f = fixture(); f.adapter.start(f.callbacks);
    f.recognition.onerror({ error: code });
    assert.equal(f.recognition.aborted, true); assert.equal(f.adapter.session, null);
    assert.equal(f.timers.size, 0); assert.ok(f.events[1].length > 5);
    assert.equal(f.adapter.start(f.callbacks), true); f.adapter.cancel();
  });
}
test('cancel ignores late result callbacks', () => {
  const f = fixture(); f.adapter.start(f.callbacks);
  const late = f.recognition.onresult, end = f.recognition.onend, speechEnd = f.recognition.onspeechend;
  f.adapter.cancel(); late({ results: [[{ transcript: '转账' }]] }); end();
  assert.deepEqual(f.events, ['requesting']); assert.equal(f.timers.size, 0);
  f.adapter.start(f.callbacks); speechEnd();
  assert.equal(f.recognition.stopped, undefined); f.adapter.cancel();
});
test('permission and recognition deadlines abort; duration limit stops recording', () => {
  const f = fixture(); f.adapter.start(f.callbacks); f.expire();
  assert.equal(f.adapter.session, null);
  f.adapter.start(f.callbacks); f.recognition.onstart(); f.expire();
  assert.equal(f.recognition.stopped, true); assert.equal(f.events.at(-1), 'recognizing');
  f.expire(); assert.equal(f.adapter.session, null); assert.equal(f.timers.size, 0);
});
test('empty recognition is an explicit failure', () => {
  const f = fixture(); f.adapter.start(f.callbacks); f.recognition.onend();
  assert.match(f.events.at(-1), /没有识别/);
});
test('insecure and unsupported environments do not start; cooldown is enforced', () => {
  const f = fixture({ cooldown: 60000 }); f.env.isSecureContext = false;
  assert.equal(f.adapter.start(f.callbacks), false);
  f.env.isSecureContext = true; f.adapter.start(f.callbacks); f.adapter.cancel();
  assert.equal(f.adapter.start(f.callbacks), false);
});
test('TTS never auto-starts and uses explicit text and language', () => {
  let spoken, cancelled = 0;
  const adapter = new BrowserTtsAdapter({ speechSynthesis: { speak: u => spoken = u, cancel: () => cancelled++ },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  assert.equal(spoken, undefined); adapter.speak('已显示回复', 'zh-CN', () => {}, () => {});
  assert.equal(spoken.text, '已显示回复'); assert.equal(spoken.lang, 'zh-CN');
  adapter.stop(); assert.equal(cancelled, 2);
});
