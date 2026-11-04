import {it,expect,vi,afterEach} from 'vitest';
import {bedrockConfig} from '../src/bedrock.js';
afterEach(()=>vi.unstubAllGlobals());
const env={LLM_PROVIDER:'bedrock',AWS_REGION:'us-east-1',AWS_BEARER_TOKEN_BEDROCK:'TEST-SECRET',BEDROCK_REVIEW_MODEL_ID:'TEST-model',BEDROCK_MAX_OUTPUT_TOKENS:'512'};
it('translates isolated system/data messages into Converse and parses actual text shape',async()=>{
 const remote=vi.fn(async(_url,init)=>{const b=JSON.parse(init.body);expect(b.system).toEqual([{text:'instructions'}]);expect(b.messages[0].content).toEqual([{text:'untrusted data'}]);expect(b.inferenceConfig.maxTokens).toBe(512);return new Response(JSON.stringify({output:{message:{content:[{text:'{"score":60}'}]}}}));});
 vi.stubGlobal('fetch',remote);const c=bedrockConfig(env,'REVIEW')!;const r=await c.fetchImpl(c.baseUrl,{body:JSON.stringify({messages:[{role:'system',content:'instructions'},{role:'user',content:'untrusted data'}]})});expect((await r.json()).choices[0].message.content).toBe('{"score":60}');expect(remote).toHaveBeenCalledOnce();
});
it('does not forward provider error bodies or retry rejected calls',async()=>{const f=vi.fn(async()=>new Response('TEST-SECRET',{status:403}));vi.stubGlobal('fetch',f);const c=bedrockConfig(env,'REVIEW')!;const r=await c.fetchImpl('',{body:'{"messages":[]}'});expect(r.status).toBe(403);expect(await r.text()).not.toContain('TEST-SECRET');expect(f).toHaveBeenCalledOnce();});
it('fails closed for missing credentials and enforces input cap',async()=>{expect(()=>bedrockConfig({...env,AWS_BEARER_TOKEN_BEDROCK:''},'REVIEW')).toThrow();const f=vi.fn();vi.stubGlobal('fetch',f);const c=bedrockConfig({...env,BEDROCK_MAX_INPUT_CHARS:'2'},'REVIEW')!;await expect(c.fetchImpl('',{body:'{"messages":[]}'})).rejects.toThrow();expect(f).not.toHaveBeenCalled();});
