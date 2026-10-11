import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
import ts from 'typescript';
export function loadWorker(){
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8');
 const runtime={exports:{},URL,Request,Response,Headers,TextEncoder,Uint8Array,Blob,atob,btoa,crypto:webcrypto,console:{log(){},error(){}},
 fetch(){throw Error('Paid synthesis forbidden in tests');},
 require(id){return id==='cloudflare:workers'?{DurableObject:class{constructor(ctx,env){this.ctx=ctx;this.env=env;}}}:{};}};
 const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 runInNewContext(js+'\nexports.helpers={getPlayerHTML,inspectEncodedAudio,cachedAudioResponse,getVoiceAudioCacheKey,normalizeSpeakInput};',runtime);
 return {...runtime.exports.helpers,Cache:runtime.exports.VoiceAudioCache,worker:runtime.exports.default};
}
export function silentMp3(){
 const bytes=Buffer.alloc(417*40);
 for(let i=0;i<bytes.length;i+=417)bytes.set([0xff,0xfb,0x90,0],i);
 return bytes;
}
