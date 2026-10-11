import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import {loadWorker,silentMp3} from './offline-worker.mjs';
const script=loadWorker().getPlayerHTML('Test','https://voice.test').split('<script>')[1].split('</script>')[0];
function setup(initial){
 const listeners={},sent=[],elements=new Map(),blobs=[],revoked=[];
 const element=id=>{
  if(!elements.has(id)){const events={};elements.set(id,{innerHTML:'',textContent:'',style:{},paused:true,duration:NaN,currentTime:0,src:'',
   classList:{add(){},remove(){},toggle(){}},setAttribute(){},querySelectorAll(){return [];},
   addEventListener(n,f){(events[n]??=[]).push(f);},emit(n){for(const f of events[n]??[])f();},
   pause(){this.paused=true;},play(){return this.rejection?Promise.reject(this.rejection):Promise.resolve();},load(){}});
  }return elements.get(id);
 };
 const parent={postMessage(m){sent.push(m);}},window={parent,openai:{toolOutput:initial},addEventListener(n,f){(listeners[n]??=[]).push(f);}};
 class FakeURL extends URL{static createObjectURL(b){blobs.push(b);return 'blob:test/'+blobs.length;}static revokeObjectURL(u){revoked.push(u);}}
 runInNewContext(script,{window,URL:FakeURL,Uint8Array,Blob,atob,document:{getElementById:element,createElement:()=>element('escape'),documentElement:{scrollHeight:140},body:{}},
 setTimeout(){throw Error('Handshake timer');},setInterval(){},clearInterval(){}});
 return {sent,window,element,blobs,revoked,emit(n,e){for(const f of listeners[n]??[])f(e);},message(data,source=parent){for(const f of listeners.message??[])f({data,source});}};
}
const bytes=silentMp3(),result={text:'宝宝过来',audio_base64:bytes.toString('base64'),audio_byte_length:bytes.length,audio_mime_type:'audio/mpeg',audio_url:'https://voice.test/audio/'+'a'.repeat(64)};
test('init awaits host; duplicate messages do not reset playing audio',()=>{
 const h=setup();assert.equal(h.sent.length,1);h.message({jsonrpc:'2.0',id:1,result:{}});h.message({jsonrpc:'2.0',id:1,result:{}});
 assert.equal(h.sent.filter(x=>x.method==='ui/notifications/initialized').length,1);
 h.message({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:result}});
 assert.equal(h.element('audio').src,'blob:test/1');h.element('content').innerHTML='playing';
 h.message({jsonrpc:'2.0',method:'ui/notifications/tool-input'});h.message({structuredContent:result});
 assert.equal(h.element('content').innerHTML,'playing');assert.equal(h.blobs.length,1);
});
test('mount/globals/pageshow restore results; foreign and partial messages ignored',()=>{
 assert.equal(setup(result).element('audio').src,'blob:test/1');
 const h=setup();h.message({structuredContent:result},{});h.message({structuredContent:{text:'missing'}});assert.equal(h.blobs.length,0);
 h.emit('openai:set_globals',{detail:{globals:{toolOutput:result}}});assert.equal(h.element('audio').src,'blob:test/1');
 const p=setup();p.window.openai.toolOutput=result;p.emit('pageshow',{});assert.equal(p.element('audio').src,'blob:test/1');
});
test('late input cannot hide a generation error',()=>{
 const h=setup();h.message({structuredContent:{error:'failed'}});const before=h.element('content').innerHTML;
 h.message({jsonrpc:'2.0',method:'ui/notifications/tool-input'});assert.equal(h.element('content').innerHTML,before);
});
test('unknown duration stays readable and later finite duration replaces it',()=>{
 const h=setup(result),a=h.element('audio');
 for(const d of [Infinity,NaN,-1]){a.duration=d;a.emit('loadedmetadata');assert.doesNotMatch(h.element('duration').textContent,/Infinity|NaN/);}
 a.duration=3.6;a.emit('durationchange');assert.equal(h.element('duration').textContent,'0:03');
});
test('Blob has complete original bytes and correct MIME',async()=>{
 const h=setup(result);assert.equal(h.blobs[0].type,'audio/mpeg');
 assert.deepEqual(Buffer.from(await h.blobs[0].arrayBuffer()),bytes);
});
test('truncated base64 uses cached URL rather than broken data URL',()=>{
 const h=setup({...result,audio_base64:result.audio_base64.slice(0,-100)});
 assert.equal(h.element('audio').src,result.audio_url);assert.equal(h.blobs.length,0);
});
test('decode failure switches to cached HTTPS once and then reports a clear error',()=>{
 const h=setup(result),a=h.element('audio');a.error={code:3};a.emit('error');assert.equal(a.src,result.audio_url);
 a.emit('error');assert.match(h.element('playbackError').textContent,/错误 3/);
});
test('play Promise rejection is handled',async()=>{
 const h=setup(result);h.element('audio').rejection={name:'NotAllowedError'};h.element('playBtn').emit('click');
 await Promise.resolve();assert.match(h.element('playbackError').textContent,/请点播放/);
});
test('replacement releases Blob; untrusted URL cannot load',()=>{
 const h=setup(result);h.message({structuredContent:{...result,audio_url:'https://voice.test/audio/'+'b'.repeat(64)}});assert.deepEqual(h.revoked,['blob:test/1']);
 const bad=setup({...result,audio_base64:'bad!',audio_url:'https://other.test/audio/'+'a'.repeat(64)});assert.equal(bad.element('audio').src,'');
});
