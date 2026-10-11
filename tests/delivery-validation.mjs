import assert from 'node:assert/strict';
import test from 'node:test';
import {loadWorker} from './offline-worker.mjs';

const {worker, Cache} = loadWorker();
const env = {
  TTS_PROVIDER: 'elevenlabs', ELEVENLABS_MODEL_ID: 'eleven_v4',
  ELEVENLABS_VOICE_ID: 'same-voice', ELEVENLABS_DELIVERY_ZH: 'relaxed, conversational, warm',
  VOICE_AUDIO_CACHE: {idFromName() {throw Error('Cache must not be accessed');}}
};
const input = {
  text: '今天累不累？先坐下歇一会儿。',
  style: 'Speak naturally and keep the conversation easy. '.repeat(14), raw_tags: false
};

test('public speak routes reject oversized delivery before edge cache or synthesis', async () => {
  const params = new URLSearchParams({text: input.text, style: input.style, raw_tags: 'false'});
  for (const request of [
    new Request('https://voice.test/speak', {method:'POST', body:JSON.stringify(input)}),
    new Request('https://voice.test/speak?' + params),
    new Request('https://voice.test/speak-cached?' + params)
  ]) {
    const response = await worker.fetch(request, env, {});
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /No audio was generated/);
  }
});

test('durable cache rejects oversized delivery even when called directly', async () => {
  const cache = new Cache({storage:{get(){throw Error('Bad recording must not be reused');}}}, env);
  const response = await cache.fetch(new Request('https://voice-cache/synthesize', {
    method:'POST', body:JSON.stringify(input)
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
});
