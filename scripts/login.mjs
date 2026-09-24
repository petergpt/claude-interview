import { spawn } from 'node:child_process';
import { subscriptionEnvironment } from '../src/core.mjs';
import { authStatus, claudeBin } from '../src/claude.mjs';
console.log('Sign into your subscribed Claude account. Use your intended existing browser profile.');
console.log('This runs Claude Code’s normal subscription login and does not change shell/provider settings.');
console.log('If the wrong browser account opens, copy the displayed authorization URL into the right existing profile.');
const child=spawn(claudeBin,['--setting-sources','','auth','login','--claudeai'],{env:subscriptionEnvironment(),stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',async code=>{if(code!==0){process.exitCode=code||1;return;}const auth=await authStatus();console.log(JSON.stringify(auth,null,2));if(!auth.ready)process.exitCode=1;});
