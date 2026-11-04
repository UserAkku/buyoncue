/** Bearer-authenticated Bedrock Converse adapter; never forwards provider error bodies. */
export function bedrockConfig(env:Record<string,string|undefined>,kind:'CHAT'|'REVIEW') {
  if(env.LLM_PROVIDER!=='bedrock')return null;
  const region=env.AWS_REGION,token=env.AWS_BEARER_TOKEN_BEDROCK,model=env[`BEDROCK_${kind}_MODEL_ID`];
  if(!region||!/^[a-z0-9-]+$/.test(region)||!token||!model)throw new Error('Bedrock requires region, bearer token and configured model ID');
  const maxTokens=Number(env.BEDROCK_MAX_OUTPUT_TOKENS??2048);
  if(!Number.isInteger(maxTokens)||maxTokens<1||maxTokens>8192)throw new Error('Invalid Bedrock output token limit');
  const fetchImpl:typeof fetch=async(_input,init)=>{
    const raw=String(init?.body);
    if(raw.length>Number(env.BEDROCK_MAX_INPUT_CHARS??120000))throw new Error("Bedrock input exceeds configured limit");
    const body=JSON.parse(raw);
    const response=await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},redirect:'error',signal:init?.signal??AbortSignal.timeout(60000),
      body:JSON.stringify({system:body.messages.filter((m:{role:string})=>m.role==='system').map((m:{content:string})=>({text:m.content})),messages:body.messages.filter((m:{role:string})=>m.role!=='system').map((m:{role:string;content:string})=>({role:m.role,content:[{text:m.content}]})),inferenceConfig:{maxTokens,temperature:0}})
    });
    if(!response.ok)return new Response('{}',{status:response.status});
    const data=await response.json() as {output?:{message?:{content?:{text?:string}[]}};usage?:unknown};
    const text=data.output?.message?.content?.map(c=>c.text??'').join('');
    if(!text)return new Response('{}',{status:502});
    return new Response(JSON.stringify({choices:[{message:{content:text}}],usage:data.usage}),{status:200});
  };
  return {apiKey:'bedrock-managed-bearer',baseUrl:'https://bedrock.invalid/v1',model,fetchImpl};
}
