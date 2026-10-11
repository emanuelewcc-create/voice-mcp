import assert from 'node:assert/strict';
import test from 'node:test';
import {loadWorker,silentMp3} from './offline-worker.mjs';
const w=loadWorker(),bytes=silentMp3(),encoded=bytes.toString('base64');
test('MPEG container and exact base64 bytes; reject invalid data',()=>{
 const info=w.inspectEncodedAudio(encoded);assert.equal(info.mime,'audio/mpeg');assert.deepEqual(Buffer.from(info.bytes),bytes);
 assert.throws(()=>w.inspectEncodedAudio('{"error":"bad"}'));assert.throws(()=>w.inspectEncodedAudio('SUQz'));
 const wav=Buffer.alloc(44);wav.write('RIFF');wav.write('WAVE',8);assert.equal(w.inspectEncodedAudio(wav.toString('base64')).mime,'audio/wav');
});
test('finite HTTP content length, Safari ranges and HEAD',async()=>{
 const full=w.cachedAudioResponse(encoded,new Request('https://voice.test/audio/x'));
 assert.equal(full.headers.get('Content-Length'),String(bytes.length));assert.equal(full.headers.get('Content-Type'),'audio/mpeg');
 assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes);
 for(const [range,start,end]of [['bytes=0-1',0,1],['bytes=10-',10,bytes.length-1],['bytes=-10',bytes.length-10,bytes.length-1]]){
  const r=w.cachedAudioResponse(encoded,new Request('https://voice.test/audio/x',{headers:{Range:range}}));
  assert.equal(r.status,206);assert.equal(r.headers.get('Content-Range'),'bytes '+start+'-'+end+'/'+bytes.length);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(start,end+1));
 }
 for(const range of ['bytes=999999-','bytes=-0','bytes=20-10','bytes=oops'])
  assert.equal(w.cachedAudioResponse(encoded,new Request('https://voice.test/audio/x',{headers:{Range:range}})).status,416);
 const h=w.cachedAudioResponse(encoded,new Request('https://voice.test/audio/x',{method:'HEAD'}));
 assert.equal((await h.arrayBuffer()).byteLength,0);assert.equal(h.headers.get('Content-Length'),String(bytes.length));
});
function cache(values){return new w.Cache({storage:{async get(k){return values[k];}}},{});}
test('missing/incomplete recordings cannot trigger synthesis',async()=>{
 assert.equal((await cache({}).fetch(new Request('https://cache/audio'))).status,404);
 await assert.rejects(()=>cache({chunks:2,'chunk:0':'abc'}).fetch(new Request('https://cache/audio')),/incomplete/);
});
test('cached chunks reassemble to original bytes',async()=>{
 const data=JSON.stringify({success:true,audio_base64:encoded});
 const obj=cache({chunks:2,'chunk:0':data.slice(0,2000),'chunk:1':data.slice(2000)});
 const r=await obj.fetch(new Request('https://cache/audio',{headers:{Range:'bytes=0-1'}}));
 assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(0,2));
});
test('public cached route refuses POST and never generates on storage failure',async()=>{
 const key='a'.repeat(64),path='https://voice.test/audio/'+key;let forwarded=0;
 const env={VOICE_AUDIO_CACHE:{idFromName(k){assert.equal(k,key);return k;},get(){return {async fetch(r){forwarded++;assert.equal(r.method,'GET');return new Response('cached');}};}}};
 assert.equal((await w.worker.fetch(new Request(path),env,{})).status,200);
 assert.equal((await w.worker.fetch(new Request(path,{method:'POST'}),env,{})).status,405);assert.equal(forwarded,1);
 assert.equal((await w.worker.fetch(new Request(path),{},{})).status,503);
});
