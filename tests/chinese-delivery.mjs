import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import test from "node:test";
import { z } from "zod";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
function loadWorker(text) {
  const requests = [];
  class MockMcpServer {
    tools = [];
    server = { registerCapabilities() {} };
    resource() {}
    registerTool(name, definition) { this.tools.push({name, ...definition}); }
  }
  const runtime = {
    exports: {}, crypto: webcrypto, TextEncoder, URL, Response, atob, btoa,
    console: { log() {}, error() {} },
    require(id) {
      if (id === "cloudflare:workers") return { DurableObject: class {} };
      if (id === "@modelcontextprotocol/sdk/server/mcp.js") return { McpServer: MockMcpServer };
      if (id === "zod") return { z };
      return {};
    },
    async fetch(url, options) {
      requests.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({ audio_base64: "SUQz" });
    }
  };
  const js = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  runInNewContext(js + "\nexports.helpers = { normalizeSpeakInput, generateElevenLabsAudio, getVoiceAudioCacheKey, getTtsStatus, createVoiceServer, getPlayerHTML };", runtime);
  const h = runtime.exports.helpers;
  return {
    requests,
    async synth(env, input) { return h.generateElevenLabsAudio(env, h.normalizeSpeakInput(input)); },
    key(env, input) { return h.getVoiceAudioCacheKey(env, h.normalizeSpeakInput(input)); },
    status: h.getTtsStatus,
    tool(env) { return h.createVoiceServer(env, "https://voice.test").tools.find(tool => tool.name === "speak"); },
    player() { return h.getPlayerHTML("Test", "https://voice.test"); }
  };
}
const w = loadWorker(source);
const base = {
  TTS_PROVIDER: "elevenlabs", ELEVENLABS_MODEL_ID: "eleven_v4",
  ELEVENLABS_VOICE_ID: "same-voice", ELEVENLABS_API_KEY: "mock-key",
  ELEVENLABS_STABILITY: "0.35"
};
const tuned = {
  ...base, ELEVENLABS_STABILITY_ZH: "0.25",
  ELEVENLABS_DELIVERY_ZH: "relaxed, conversational, unhurried"
};

test("shared tool guidance retains the original expressive-tag contract; Chinese presets stay language-scoped", () => {
  const tool = w.tool(base);
  assert.equal(tool.description, "Make AI speak with a custom cloned voice. The audio will play in an inline player.");
  const schema = tool.inputSchema.shape;
  assert.equal(schema.text.description, "Text to speak");
  assert.equal(schema.raw_tags.description, "Allow raw ElevenLabs v3/v4 audio tags when supported");
  assert.match(schema.style.description, /^Optional speaking style\. Chinese only:/);
  assert.match(schema.style.description, /natural_close_zh.*intimate_zh/);
  assert.match(schema.style.description, /120 characters/);
  assert.match(schema.style.description, /do not apply to English or Japanese/);
});

test("oversized Chinese style fails before the provider request, without a paid retry", async () => {
  const beforeCount = w.requests.length;
  for (const raw_tags of [undefined, true, false]) {
    const result = await w.synth(tuned, {
      text: "今天累不累？先坐下歇一会儿。",
      style: "Speak naturally and keep the conversation easy. ".repeat(14), raw_tags
    });
    assert.equal(result.success, false);
    assert.match(result.error, /style exceeds 120 characters/);
  }
  assert.equal(w.requests.length, beforeCount);
});

test("tag budget checks the combined prefix and positional cues without truncating dialogue", async () => {
  const text = "今天累不累？先坐下歇一会儿。";
  assert.equal((await w.synth(tuned, { text, style: "x".repeat(120), raw_tags: false })).success, true);
  const beforeCount = w.requests.length;
  for (const input of [
    { text, style: "x".repeat(121), raw_tags: false },
    { text, style: "x".repeat(140) },
    { text: "[" + "x".repeat(161) + "] " + text, raw_tags: true }
  ]) assert.equal((await w.synth(tuned, input)).success, false);
  assert.equal(w.requests.length, beforeCount);
  await w.synth(tuned, { text, style: "relaxed, conversational, warm", raw_tags: false });
  assert.equal(w.requests.at(-1).body.text, "[relaxed, conversational, warm] " + text);
});

test("deployed Chinese defaults are bounded and retain the configured identity", async () => {
  const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const env = { ...config.vars, ELEVENLABS_API_KEY: "mock-key" };
  for (const style of [undefined, "relaxed, conversational, warm", "x".repeat(120)]) {
    assert.equal((await w.synth(env, { text: "今天累不累？先坐下歇一会儿。", style })).success, true);
    const request = w.requests.at(-1);
    assert.match(request.url, /7Pd7lr5kXhWerGi0OVF0/);
    assert.equal(request.body.model_id, "eleven_v4");
    assert.equal(request.body.voice_settings.stability, 0.40);
    assert.ok([...request.body.text.matchAll(/\[([^\]]*)\]/g)].every(tag => tag[1].length <= 160));
  }
});

test("named Chinese preset compiles detailed bounded cues, preserves dialogue and uses the same voice", async () => {
  const text = "今天累不累？先坐下歇一会儿。";
  for (const style of ["natural_close_zh", "intimate_zh", " INTIMATE_ZH "]) {
    for (const raw_tags of [undefined, false, true]) {
      const beforeCount = w.requests.length;
      const result = await w.synth(tuned, { text, style, raw_tags });
      assert.equal(result.success, true);
      assert.equal(w.requests.length, beforeCount + 1);
      const req = w.requests.at(-1);
      assert.match(req.url, /\/same-voice\/with-timestamps\?output_format=mp3_44100_128$/);
      assert.equal(req.body.model_id, "eleven_v4");
      assert.deepEqual(req.body.voice_settings, {stability: 0.25});
      assert.deepEqual(Object.keys(req.body).sort(), ["model_id", "text", "voice_settings"]);
      assert.equal(req.body.text.replace(/\[[^\]]*\]\s*/g, ""), text);
      const cues = [...req.body.text.matchAll(/\[([^\]]*)\]/g)].map(match => match[1]);
      assert.equal(cues.length, 4);
      assert.ok(cues.every(cue => cue.length <= 60));
      assert.ok(cues.join(" ").length <= 160);
      for (const term of ["close-mic", "breathy", "articulation", "pauses", "smile", "vocal fry"])
        assert.ok(cues.join(" ").includes(term));
      assert.ok(!req.body.text.includes(tuned.ELEVENLABS_DELIVERY_ZH));
      assert.doesNotMatch(req.body.text, /intimate_zh|natural_close_zh/);
    }
  }
});

test("preset aliases share cache entries and cue revisions cannot reuse older delivery", async () => {
  const input = {text: "今天累不累？先坐下歇一会儿。", style: "natural_close_zh", raw_tags:false};
  const key = await w.key(tuned, input);
  assert.equal(key, await w.key(tuned, {...input, style:"intimate_zh"}));
  assert.equal(key, await w.key(tuned, {...input, style:" INTIMATE_ZH "}));
  assert.equal(key, await w.key({...tuned, ELEVENLABS_DELIVERY_ZH:"different generic default"}, input));
  const revised = loadWorker(source.replace("revision: 1,", "revision: 2,"));
  assert.notEqual(key, await revised.key(tuned, input));
  const changed = loadWorker(source.replace('"close-mic, soft-spoken"', '"soft-spoken, close-mic"'));
  assert.notEqual(key, await changed.key(tuned, input));
});

test("explicit raw cues retain precedence; raw_tags=false strips caller tags but enables named presets", async () => {
  const input = {text:"[curious] 今天累不累？", style:"intimate_zh"};
  await w.synth(tuned, {...input, raw_tags:true});
  assert.equal(w.requests.at(-1).body.text, input.text);
  await w.synth(tuned, {...input, raw_tags:false});
  const generated = w.requests.at(-1).body.text;
  assert.match(generated, /close-mic/);
  assert.doesNotMatch(generated, /\[curious\]/);
  assert.equal(generated.replace(/\[[^\]]*\]\s*/g, ""), "今天累不累？");
  await w.synth({...tuned,ELEVENLABS_DELIVERY_ZH:undefined}, {...input,text:"今天累不累？",raw_tags:false});
  assert.equal(w.requests.at(-1).body.text, generated);
});

test("misspelled preset fails before synthesis and non-tag models retain plain speech", async () => {
  const beforeCount = w.requests.length;
  const result = await w.synth(tuned, {text:"今天累不累？",style:"intimte_zh",raw_tags:false});
  assert.equal(result.success, false);
  assert.match(result.error, /Unknown Chinese style preset/);
  assert.equal(w.requests.length, beforeCount);
  await w.synth({...tuned,ELEVENLABS_MODEL_ID:"eleven_multilingual_v2"}, {text:"今天累不累？",style:"intimate_zh"});
  assert.equal(w.requests.at(-1).body.text, "今天累不累？");
});

test("Chinese uses the same voice/model with its own stability and one fallback direction", async () => {
  const result = await w.synth(tuned, { text: "嗯……再陪我一会儿，好不好？" });
  assert.equal(result.success, true);
  const req = w.requests.at(-1);
  assert.match(req.url, /\/same-voice\/with-timestamps/);
  assert.equal(req.body.model_id, "eleven_v4");
  assert.deepEqual(req.body.voice_settings, { stability: 0.25 });
  assert.equal(req.body.text, "[relaxed, conversational, unhurried] 嗯……再陪我一会儿，好不好？");
  assert.equal(req.body.language_code, undefined);
});

test("English, Japanese and mixed Japanese passages keep their previous payloads and cache keys", async () => {
  for (const text of ["Stay with me a little longer.", "今日はもう少し一緒にいて。", "[softly] ねえ、まだ帰らないで。", "中文，でも今日はゆっくり。", "조금 더 함께 있어요."]) {
    await w.synth(base, { text });
    const before = w.requests.at(-1);
    await w.synth(tuned, { text });
    assert.deepEqual(w.requests.at(-1), before, text);
    assert.equal(await w.key(base, { text }), await w.key(tuned, { text }), text);
  }
});

test("explicit positional tags are preserved; Chinese style is combined with the profile once", async () => {
  await w.synth(tuned, { text: "再陪我一会儿。", raw_tags: true });
  assert.equal(w.requests.at(-1).body.text, "[relaxed, conversational, unhurried] 再陪我一会儿。");
  for (const text of ["[softly] 再陪我一会儿。", "[low and close, unhurried] 再陪我一会儿。"]) {
    await w.synth(tuned, { text, raw_tags: true });
    assert.equal(w.requests.at(-1).body.text, text);
  }
  await w.synth(tuned, { text: "再陪我一会儿。", style: "curious" });
  assert.equal(w.requests.at(-1).body.text, "[relaxed, conversational, unhurried; gently curious] 再陪我一会儿。");
  await w.synth(tuned, { text: "[low and close, unhurried] 再陪我一会儿。" });
  assert.equal(w.requests.at(-1).body.text, "[low and close, unhurried] 再陪我一会儿。");
});

test("free-form Chinese style reaches the request even with raw_tags=true and never repeats the first word", async () => {
  const text = "千枝，过来一点……今天累不累？";
  for (const raw_tags of [undefined, true, false]) {
    const beforeCount = w.requests.length;
    await w.synth(tuned, { text, style: "[gentle and affectionate] [gentle and affectionate]", raw_tags });
    const req = w.requests.at(-1).body;
    const prefix = raw_tags === false ? "" : tuned.ELEVENLABS_DELIVERY_ZH + "; ";
    assert.equal(req.text, "[" + prefix + "gentle and affectionate] " + text);
    assert.equal(req.text.match(/千枝/g).length, 1);
    assert.equal(req.text.match(/gentle and affectionate/g).length, 1);
    assert.equal(w.requests.length, beforeCount + 1);
    assert.equal(req.voice_settings.stability, 0.25);
  }
});

test("Chinese aliases do not force whispering or a separate sigh/laugh; explicit raw cues are not stacked", async () => {
  for (const style of ["soft", "teasing", "tired", "laughing"]) {
    await w.synth(tuned, { text: "千枝，今天就早点休息吧。", style });
    assert.doesNotMatch(w.requests.at(-1).body.text, /\[whispers\]|\[sighs\]|\[laughs\]|\[mischievously\]/);
    assert.equal(w.requests.at(-1).body.text.match(/千枝/g).length, 1);
  }
  const text = "[warm, unhurried] 千枝，今天就早点休息吧。";
  await w.synth(tuned, { text, style: "soft" });
  assert.equal(w.requests.at(-1).body.text, text);
  await w.synth(tuned, { text, raw_tags: false });
  assert.equal(w.requests.at(-1).body.text, "千枝，今天就早点休息吧。");
});

test("changed style requests never reuse an old ignored-style recording", async () => {
  const input = { text: "千枝，再陪我一会儿。", style: "gentle and affectionate" };
  const noProfile = { ...tuned, ELEVENLABS_DELIVERY_ZH: undefined };
  assert.notEqual(await w.key(tuned, input), await w.key(noProfile, input));
  assert.notEqual(await w.key(tuned, input), await w.key(tuned, { ...input, style: "lightly playful" }));
});

test("raw_tags=false and non-tag models never receive the fallback", async () => {
  await w.synth(tuned, { text: "[softly] 再陪我一会儿。", raw_tags: false });
  assert.equal(w.requests.at(-1).body.text, "再陪我一会儿。");
  await w.synth({ ...tuned, ELEVENLABS_MODEL_ID: "eleven_multilingual_v2" }, { text: "再陪我一会儿。" });
  assert.equal(w.requests.at(-1).body.text, "再陪我一会儿。");
});

test("Chinese cache recipes track effective stability and fallback without duplicating caller-directed audio", async () => {
  const input = { text: "再陪我一会儿。" };
  const key = await w.key(tuned, input);
  assert.notEqual(key, await w.key(base, input));
  assert.notEqual(key, await w.key({ ...tuned, ELEVENLABS_DELIVERY_ZH: "conversational" }, input));
  assert.notEqual(key, await w.key({ ...tuned, ELEVENLABS_STABILITY_ZH: "0.3" }, input));
  const directed = { text: "[warmly] 再陪我一会儿。", raw_tags: true };
  assert.equal(await w.key(tuned, directed), await w.key({ ...tuned, ELEVENLABS_DELIVERY_ZH: "something else" }, directed));
  const plain = { ...input, raw_tags: false };
  assert.equal(await w.key(tuned, plain), await w.key({ ...tuned, ELEVENLABS_DELIVERY_ZH: "something else" }, plain));
});

test("invalid Chinese stability safely falls back and status reports both profiles", async () => {
  for (const value of ["bad", "-1", "2"]) {
    await w.synth({ ...tuned, ELEVENLABS_STABILITY_ZH: value }, { text: "你好。" });
    assert.equal(w.requests.at(-1).body.voice_settings.stability, 0.35);
  }
  const status = w.status(tuned);
  assert.equal(status.voice_id, base.ELEVENLABS_VOICE_ID);
  assert.equal(status.voice_settings.stability, 0.35);
  assert.equal(status.voice_settings_zh.stability, 0.25);
});

if (process.env.VOICE_BASELINE_SOURCE) {
  test("regression: original deployed source produces identical non-Chinese payloads and cache keys", async () => {
    const old = loadWorker(readFileSync(process.env.VOICE_BASELINE_SOURCE, "utf8"));
    const deployed = {...JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).vars, ELEVENLABS_API_KEY:"mock-key"};
    const oldEnv = {...deployed, ELEVENLABS_STABILITY_ZH:undefined, ELEVENLABS_DELIVERY_ZH:undefined};
    const beforeTool = old.tool(oldEnv), afterTool = w.tool(deployed);
    assert.equal(afterTool.description, beforeTool.description);
    assert.equal(afterTool.inputSchema.shape.text.description, beforeTool.inputSchema.shape.text.description);
    assert.equal(afterTool.inputSchema.shape.raw_tags.description, beforeTool.inputSchema.shape.raw_tags.description);
    for (const input of [
      { text: "Stay with me a little longer." },
      { text: "今日はもう少し一緒にいて。" },
      { text: "[softly] Stay with me.", raw_tags: true },
      { text: "Stay with me.", style: "soft" },
      { text: "Stay with me.", raw_tags: false },
      { text: "Stay with me.", style: "gentle and affectionate", raw_tags: true },
      { text: "今日はもう少し一緒にいて。", style: "tired" },
      { text: "[softly] 今日はもう少し一緒にいて。", raw_tags: true }
      ,{ text: "Stay with me.", style: "intimate_zh", raw_tags:false }
      ,{ text: "今日はもう少し一緒にいて。", style: "natural_close_zh", raw_tags:false }
      ,{ text: "[soft, a little teasing] Stay a little longer. [quiet laugh] There is no hurry.", raw_tags:true }
      ,{ text: "[low and close, unhurried] ねえ、もう少しここにいて。 [small laugh]", raw_tags:true }
      ,{ text: "Come sit here.", style:"laughing" }
      ,{ text: "ねえ、今日はどうだった？", style:"teasing" }
    ]) {
      await old.synth(oldEnv, input);
      await w.synth(deployed, input);
      assert.deepEqual(w.requests.at(-1), old.requests.at(-1));
      assert.equal(await w.key(deployed, input), await old.key(oldEnv, input));
    }
  });
}

if (process.env.VOICE_PREVIOUS_SOURCE) {
  test("language-guidance rollback preserves Chinese requests, cache keys, settings and the repaired player", async () => {
    const previous = loadWorker(readFileSync(process.env.VOICE_PREVIOUS_SOURCE, "utf8"));
    const env = {...JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).vars, ELEVENLABS_API_KEY:"mock-key"};
    assert.equal(w.player(), previous.player());
    assert.deepEqual(JSON.parse(JSON.stringify(w.status(env))), JSON.parse(JSON.stringify(previous.status(env))));
    for (const style of [undefined, "soft", "teasing", "natural_close_zh", "intimate_zh", "gentle and affectionate"]) {
      for (const raw_tags of [undefined, true, false]) {
        const input = {text:"今天累不累？先坐下歇一会儿。", style, raw_tags};
        await previous.synth(env, input);
        await w.synth(env, input);
        assert.deepEqual(w.requests.at(-1), previous.requests.at(-1));
        assert.equal(await w.key(env, input), await previous.key(env, input));
      }
    }
  });
}
