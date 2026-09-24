import { DEFAULT_PORT } from './core.mjs';
export async function connect(base = process.env.INTERVIEW_URL || `http://127.0.0.1:${process.env.INTERVIEW_PORT || DEFAULT_PORT}`) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('The interview backend must be on localhost.');
  const response = await fetch(url, {signal:AbortSignal.timeout(3000)});
  const cookie = response.headers.getSetCookie().find(x=>x.startsWith('ci_access='))?.split(';')[0];
  await response.text();
  if (!cookie) throw new Error('This port is not a Claude Interview backend.');
  const request = async (route, data) => {
    const raw = Buffer.isBuffer(data);
    const r = await fetch(new URL(route,url), { headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},
      ...(data===undefined?{}:{method:'POST',body:raw?data:JSON.stringify(data)}),signal:AbortSignal.timeout(30000) });
    const body=await r.json();if(!r.ok)throw new Error(body.error||`Request failed (${r.status})`);return body;
  };
  async function events(id,onEvent,{controller=false,signal}={}) {
    const r=await fetch(new URL(`/api/sessions/${id}/events${controller?'?controller=1':''}`,url),{headers:{Cookie:cookie},signal});
    if(!r.ok)throw new Error((await r.json()).error);
    const decoder=new TextDecoder();let text='';
    for await(const bytes of r.body){text+=decoder.decode(bytes,{stream:true});let i;while((i=text.indexOf('\n\n'))>=0){const line=text.slice(0,i);text=text.slice(i+2);if(line.startsWith('data: '))await onEvent(JSON.parse(line.slice(6)));}}
  }
  return {request,events,base:url.origin};
}
