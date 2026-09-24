import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
// Secrets live only in the backend: an environment variable (any platform, e.g. from .env) or macOS Keychain.
// They are never sent to the page, written to recordings or logs, or accepted as command arguments.
const ACCOUNT='claude-interview';
export const SECRETS={
  elevenlabs:{env:'ELEVENLABS_API_KEY',service:'claude-interview.elevenlabs',label:'ElevenLabs API key',pattern:/^sk_[A-Za-z0-9_-]{20,500}$/},
  xstream:{env:'X_STREAM_KEY',service:'claude-interview.x-stream-key',label:'X stream key',pattern:/^[A-Za-z0-9_?=&.-]{8,512}$/},
};
export const KEYCHAIN_SERVICE=SECRETS.elevenlabs.service;
export async function readSecret(name,{ignoreEnvironment=false}={}){
  const s=SECRETS[name];
  if(!ignoreEnvironment&&process.env[s.env])return process.env[s.env].trim();
  if(process.platform!=='darwin')return '';
  try{const {stdout}=await exec('/usr/bin/security',['find-generic-password','-s',s.service,'-a',ACCOUNT,'-w'],{timeout:15000,maxBuffer:4096});return stdout.trim();}
  catch(error){if(error.code===44)return '';throw new Error(`Could not read the ${s.label} from macOS Keychain. Unlock the login keychain and retry.`);}
}
export async function saveSecret(name,value){
  const s=SECRETS[name];
  if(!s.pattern.test(value))throw new Error(`Invalid ${s.label} format.`);
  if(process.platform!=='darwin')throw new Error(`Set ${s.env} in the backend environment (.env) on this platform.`);
  // Interactive stdin keeps the secret out of command arguments and process listings.
  await new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/security',['-i'],{stdio:['pipe','ignore','ignore']});
    const timer=setTimeout(()=>{child.kill();reject(new Error('Keychain did not respond.'));},20000);
    child.on('error',()=>{clearTimeout(timer);reject(new Error('Could not start macOS Keychain storage.'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Could not save the ${s.label} in macOS Keychain.`));});
    child.stdin.on('error',()=>{});
    child.stdin.end(`add-generic-password -U -a "${ACCOUNT}" -s "${s.service}" -w "${value}"\n`);
  });
  // security -i can exit zero after an individual command failed: verify privately.
  if(await readSecret(name,{ignoreEnvironment:true})!==value)throw new Error(`The ${s.label} could not be verified in macOS Keychain.`);
}
export const readKey=options=>readSecret('elevenlabs',options);
export const saveKey=key=>saveSecret('elevenlabs',key);
