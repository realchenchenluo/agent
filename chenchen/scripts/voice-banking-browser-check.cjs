// Run with Playwright available via NODE_PATH. All ASR signals here are test doubles.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.VOICE_TEST_URL || 'http://127.0.0.1:4198';

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.VOICE_BROWSER_CHANNEL ? { channel: process.env.VOICE_BROWSER_CHANNEL } : { executablePath: chromium.executablePath() }) });
  const results = [];
  try {
    for (const width of [375, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(() => {
        window.asrStarts = 0;
        window.spoken = [];
        window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
        Object.defineProperty(window, 'speechSynthesis', { value: { speak: u => window.spoken.push(u.text), cancel() {} } });
        window.SpeechRecognition = class {
          constructor() { window.testAsr = this; }
          start() { window.asrStarts++; this.onstart?.(); }
          stop() { this.stopped = true; }
          abort() { this.aborted = true; }
        };
      });
      await page.goto(base + '/risk-workbench');
      const input = page.locator('#workflow-text');
      await page.locator('[data-voice-start]').waitFor();
      assert.equal(await page.evaluate(() => window.asrStarts), 0);
      assert.deepEqual(await page.evaluate(() => window.spoken), []);
      await page.locator('[data-voice-start]').click();
      assert.equal(await page.evaluate(() => window.asrStarts), 0);
      await page.locator('[data-voice-consent]').check();
      await input.fill('原有文字');
      await page.locator('[data-voice-start]').click();
      assert.equal(await page.locator('.voice-banking').getAttribute('data-state'), 'recording');
      await page.evaluate(() => window.testAsr.onresult({ results: [[{ transcript: '分析虚构组合' }]] }));
      await page.locator('[data-voice-stop]').click();
      await page.evaluate(() => window.testAsr.onend());
      assert.equal(await input.inputValue(), '原有文字 分析虚构组合');
      assert.equal(await page.locator('#workflow-status').innerText(), '尚未发起');
      await input.fill('我确认编辑后的文本');
      await page.waitForTimeout(1600);
      await page.locator('[data-voice-start]').click();
      await page.locator('[data-voice-cancel]').click();
      assert.equal(await input.inputValue(), '我确认编辑后的文本');
      assert.equal(await page.evaluate(() => window.testAsr.aborted), true);
      assert.equal(await page.locator('[data-voice-read]').isVisible(), false);
      assert.deepEqual(await page.evaluate(() => window.spoken), []);
      await page.evaluate(() => {
        document.querySelector('#workflow-result').hidden = false;
        document.querySelector('.workflow-proposal').open = true;
        document.querySelector('#workflow-proposal-reason').textContent = '已展示的虚构回复';
      });
      await page.locator('[data-voice-read]').click();
      assert.deepEqual(await page.evaluate(() => window.spoken), ['已展示的虚构回复']);
      await page.locator('[data-voice-silence]').click();
      await input.fill('转账 100 元');
      await page.locator('#run-workflow').click();
      assert.match(await page.locator('#workflow-message').innerText(), /先确认/);
      await page.locator('#funding-confirm').check();
      await page.locator('#save-funding').click();
      await page.waitForFunction(() => document.querySelector('#funding-status').textContent.includes('已确认'));
      const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/review') && r.request().method() === 'POST');
      await page.locator('#run-workflow').click();
      const failedResponse = await responsePromise;
      assert.equal(failedResponse.status(), 503);
      assert.equal(JSON.parse(failedResponse.request().postData()).text, '转账 100 元');
      await page.waitForFunction(() => document.querySelector('#workflow-status').textContent === '模型失败');
      await page.waitForTimeout(1600);
      await page.locator('[data-voice-start]').click();
      await page.evaluate(() => window.testAsr.onerror({ error: 'not-allowed' }));
      assert.match(await page.locator('[data-voice-status]').innerText(), /授权被拒绝/);
      assert.equal(await page.locator('#workflow-status').innerText(), '模型失败');
      await page.waitForTimeout(1600);
      await page.locator('[data-voice-start]').click();
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
      assert.equal(await page.evaluate(() => window.testAsr.aborted), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      results.push({ width, passed: true, asr: 'test-double', tts: 'test-double', checks: ['consent', 'transcript-edit', 'no-auto-submit', 'stop', 'cancel', 'denied', 'funding-gate', 'pagehide', 'tts-visible-only', 'real-local-api-503', 'same-text-api', 'no-overflow', 'no-page-errors'] });
      await page.close();
    }
    const page = await browser.newPage();
    await page.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
    await page.goto(base + '/risk-workbench');
    await page.locator('[data-voice-start]').waitFor();
    assert.equal(await page.locator('[data-voice-start]').isDisabled(), true);
    assert.equal(await page.locator('#workflow-text').isEditable(), true);
    results.push({ unsupportedFallback: true });
    console.log(JSON.stringify({ browser: await browser.version(), results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
