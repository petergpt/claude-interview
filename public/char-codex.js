// Astra is a living version of the blue Codex cloud: ink, coloured pencil and soft light.
// The silhouette follows the original Codex app mark, not the OpenAI blossom.
import { express } from './expression.js';
const TAU = Math.PI * 2, INK = '#202d68';
const clamp = (v, a=0, b=1) => Math.max(a, Math.min(b, v));
const mix = (a,b,t) => a+(b-a)*t;
const joints = new Map();
function follow(key,x,y,dt) {
  if (!joints.has(key)) joints.set(key,{x,y,vx:0,vy:0});
  const s=joints.get(key), n=Math.max(1,Math.ceil(dt/.008)), h=dt/n;
  for(let i=0;i<n;i++){s.vx+=((x-s.x)*105-s.vx*18)*h;s.vy+=((y-s.y)*105-s.vy*18)*h;s.x+=s.vx*h;s.y+=s.vy*h;}
  return [s.x,s.y];
}
function gradient(g,x,y,x2,y2,colors) {const v=g.createLinearGradient(x,y,x2,y2);colors.forEach((c,i)=>v.addColorStop(i/(colors.length-1),c));return v;}
function shape(g,fn,fill,stroke=INK,width=3) {g.beginPath();fn(g);if(fill){g.fillStyle=fill;g.fill();}if(stroke){g.lineWidth=width;g.strokeStyle=stroke;g.lineCap='round';g.lineJoin='round';g.stroke();}}
function oval(g,x,y,rx,ry,fill,stroke=null,width=3) {shape(g,p=>p.ellipse(x,y,Math.max(.01,rx),Math.max(.01,ry),0,0,TAU),fill,stroke,width);}
function curve(g,points,color=INK,width=3) {shape(g,p=>{p.moveTo(...points[0]);p.bezierCurveTo(...points[1],...points[2],...points[3]);},null,color,width);}
function star(g,x,y,s,color) {shape(g,p=>{p.moveTo(x,y-s);p.quadraticCurveTo(x+s*.17,y-s*.17,x+s,y);p.quadraticCurveTo(x+s*.17,y+s*.17,x,y+s);p.quadraticCurveTo(x-s*.17,y+s*.17,x-s,y);p.quadraticCurveTo(x-s*.17,y-s*.17,x,y-s);},color,null);}
let paper, set;
function paperTexture() {
  if(paper)return paper;
  paper=document.createElement('canvas');paper.width=paper.height=180;
  const g=paper.getContext('2d');let seed=37;const rand=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  for(let i=0;i<1200;i++){const x=rand()*180,y=rand()*180;g.strokeStyle=i%3?'#22296612':'#fff8eb32';g.lineWidth=.4+rand();g.beginPath();g.moveTo(x,y);g.lineTo(x+rand()*13,y-rand()*9);g.stroke();}
  return paper;
}
function grain(g,alpha=1) {g.save();g.globalAlpha*=alpha;g.fillStyle=g.createPattern(paperTexture(),'repeat');g.fillRect(0,0,700,1030);g.restore();}
function background() {
  if(set)return set;
  set=document.createElement('canvas');set.width=700;set.height=1030;const g=set.getContext('2d');
  g.fillStyle=gradient(g,0,0,700,900,['#e1eaff','#bdcaff','#91a9e0']);g.fillRect(0,0,700,1030);
  // A rounded observatory window, a generous wash of blue, warm paper around its edge.
  shape(g,p=>{p.moveTo(70,810);p.lineTo(70,318);p.bezierCurveTo(70,62,623,40,636,318);p.lineTo(636,810);p.closePath();},'#ece9f4','#7889c5',4);
  shape(g,p=>{p.moveTo(89,797);p.lineTo(89,319);p.bezierCurveTo(89,84,605,64,617,319);p.lineTo(617,797);p.closePath();},gradient(g,0,95,650,790,['#758beb','#b7c9f8','#e8dce9']),'#a0b1e3',2);
  oval(g,500,240,51,51,'#fff5d6');oval(g,512,230,51,51,'#a3b5f2');
  shape(g,p=>{p.moveTo(89,681);p.bezierCurveTo(224,490,392,692,617,519);p.lineTo(617,799);p.lineTo(89,799);p.closePath();},'#859bcf',null);
  shape(g,p=>{p.moveTo(89,739);p.bezierCurveTo(245,634,437,781,617,648);p.lineTo(617,799);p.lineTo(89,799);p.closePath();},'#6d88b4',null);
  g.fillStyle='#e7e1eb';g.fillRect(54,797,597,22);g.fillStyle='#8190be';g.fillRect(54,817,597,4);
  // Plants stay at the edge of the frame, leaving the face an uncluttered silhouette.
  for(const side of [-1,1]) {const x=side<0?39:673;curve(g,[[x,930],[x-side*20,805],[x+side*15,727],[x-side*15,626]],'#506997',4);
    for(let i=0;i<7;i++){g.save();g.translate(x+Math.sin(i*2)*12,885-i*35);g.rotate((i%2?1:-1)*.7);oval(g,0,-17,13,31,i%2?'#94aeab':'#758f9e','#557494',1.5);g.restore();}}
  grain(g);return set;
}
function scenery(g,t) {
  g.drawImage(background(),0,0);
  for(let i=0;i<7;i++){const x=140+(i*71)%405,y=192+(i*47)%227;g.save();g.globalAlpha=.32+.12*Math.sin(t*.7+i);star(g,x,y,3+i%3,'#fff9e2');g.restore();}
  // A pair of slow paper clouds. No floating UI or labels inside the illustration.
  for(let i=0;i<2;i++){const x=185+i*258+Math.sin(t*.075+i)*24,y=300+i*91;g.save();g.globalAlpha=.25;oval(g,x,y,65,12,'#fffcf5');oval(g,x-13,y-8,29,16,'#fffcf5');g.restore();}
}
function sleeve(g,shoulder,elbow,wrist) {
  curve(g,[shoulder,shoulder,elbow,wrist],INK,47);
  curve(g,[shoulder,shoulder,elbow,wrist],gradient(g,shoulder[0],shoulder[1],wrist[0],wrist[1],['#fcf1d9','#d3d8ed']),41);
  const a=Math.atan2(wrist[1]-elbow[1],wrist[0]-elbow[0]);
  g.save();g.translate(...wrist);g.rotate(a);shape(g,p=>p.roundRect(-15,-23,24,46,9),'#b5c4ed',INK,2.5);
  for(let i=-1;i<=1;i++)curve(g,[[-10,i*12],[-5,i*12],[0,i*12],[5,i*12]],'#758bc0',1.5);g.restore();
}
function hand(g,x,y,angle,open) {
  g.save();g.translate(x,y);g.rotate(angle);
  shape(g,p=>{p.moveTo(-17,9);p.bezierCurveTo(-29,-5,-28,-12,-23,-13);p.quadraticCurveTo(-18,-14,-13,-5);p.lineTo(-14,-25-open*19);p.quadraticCurveTo(-13,-36-open*16,-6,-27-open*17);p.lineTo(-3,-9);p.lineTo(-3,-34-open*14);p.quadraticCurveTo(3,-43-open*14,9,-33-open*14);p.lineTo(11,-11);p.lineTo(14,-25-open*6);p.quadraticCurveTo(21,-30-open*7,23,-21-open*6);p.lineTo(26,6);p.bezierCurveTo(27,32,-13,34,-17,9);p.closePath();},gradient(g,-18,-40,24,31,['#f3f5ff','#b4c8fa']),INK,3);
  curve(g,[[-12,4],[-6,-2],[0,0],[3,9]],'#748fc5',1.5);g.restore();
}
function cloud(g) {
  g.moveTo(-177,-77);g.bezierCurveTo(-165,-125,-143,-146,-103,-146);
  g.bezierCurveTo(-79,-207,-12,-213,32,-181);g.bezierCurveTo(93,-199,155,-158,154,-99);
  g.bezierCurveTo(207,-62,217,28,170,69);g.bezierCurveTo(160,132,107,160,55,147);
  g.bezierCurveTo(16,191,-62,187,-102,151);g.bezierCurveTo(-169,164,-211,111,-192,56);
  g.bezierCurveTo(-229,13,-224,-52,-177,-77);g.closePath();
}
function face(g,E,t) {
  const gx=E.gazeX*15,gy=E.gazeY*9;
  for(const side of [-1,1]) {
    const x=side*66+gx,y=-7+gy;
    const blink=E.wink&&side===1?.04:E.blink;
    const opening=Math.max(.025,E.eyeOpen*blink*(1-E.squint*.7)*(1-(side===1?E.skeptic*.55:0)));
    const brow=(side===-1?E.browL:E.browR)*24;
    // Uneven brows, inner corners raised for sympathy; the expression reads at call size.
    curve(g,[[x-27,y-65-brow+side*E.worry*12],[x-8,y-78-brow],[x+10,y-78-brow],[x+27,y-65-brow-side*E.worry*12]],INK,5);
    g.save();g.translate(x,y);g.rotate(side*(-.04+E.worry*.08));g.scale(1,opening);
    oval(g,0,0,31,42,'#f5f5ff',INK,3.5);
    g.save();g.beginPath();g.ellipse(0,0,29,40,0,0,TAU);g.clip();
    oval(g,gx*.25,4+gy*.25,19,30,'#233e90');oval(g,gx*.25,8+gy*.25,11,23,'#172353');
    oval(g,-7+gx*.25,-10+gy*.25,7,10,'#fffdf5');oval(g,9+gx*.25,16+gy*.25,3,4,'#b6e2ff');
    if(E.gloss>.05){g.globalAlpha=E.gloss*.7;oval(g,0,27,26,11,'#b8e6ff');curve(g,[[-20,24],[-10,19],[9,22],[22,24]],'#f3fbff',2);}
    if(E.sparkle>.05){g.globalAlpha=E.sparkle;star(g,3,3,12,'#fffde2');}
    g.restore();g.restore();
    // A small upward flick, drawn with the same ink as Claude, not a painted-on mask.
    curve(g,[[x+side*26,y-15*opening],[x+side*34,y-19*opening],[x+side*37,y-23*opening],[x+side*38,y-26*opening]],INK,3);
    g.save();g.globalAlpha=.14+E.blush*.43+E.shy*.18;oval(g,side*102,52,30,13,'#f7b5d2');
    for(let i=0;i<3;i++)curve(g,[[side*93+i*5,48],[side*93+i*5,48],[side*89+i*5,57],[side*89+i*5,57]],'#e793c2',2);g.restore();
  }
  const round=clamp(E.mouthRound),mw=44-round*24+E.laugh*8,mh=E.mouthOpen*57,smile=E.smile*21;
  const leftY=68-E.smirk*10,rightY=68+E.smirk*10;
  if(round>.65 && mh>4) {
    oval(g,0,73,Math.max(8,mw*.75),Math.max(8,mh*.65),'#18285e',INK,3);
    oval(g,0,76+mh*.32,mw*.4,3,'#c59ada');
  } else if(mh<4) curve(g,[[-mw,leftY],[0,68+smile*1.35],[mw*.45,68+smile*1.35],[mw,rightY]],INK,4);
  else {
    shape(g,p=>{p.moveTo(-mw,leftY);p.bezierCurveTo(-mw*.45,68+smile, mw*.45,68+smile,mw,rightY);p.bezierCurveTo(mw*.9,77+mh,-mw*.9,77+mh,-mw,leftY);p.closePath();},'#18285e',INK,3);
    g.save();g.clip();oval(g,0,70,28,8,'#fffbef');oval(g,4,80+mh*.62,25,13,'#ef9abb');g.restore();
  }
  // Delighted creases and worried cheek marks move with the head.
  for(const side of [-1,1])if(E.laugh>.2)curve(g,[[side*106,22],[side*121,20],[side*130,24],[side*133,30]],'#25419a',2);
  if(E.sweat>.05){g.save();g.globalAlpha=E.sweat;shape(g,p=>{p.moveTo(149,-63);p.quadraticCurveTo(174,-23,154,-18);p.quadraticCurveTo(137,-19,149,-63);},'#b9e7ff',INK,2);g.restore();}
}
export function drawCodex(g,r,a) {
  const key=a.expressionKey||'astra-blue',E=express(key,a),t=a.t,dt=clamp(a.dt||.033,.001,.05);
  g.save();g.beginPath();g.rect(r.x,r.y,r.w,r.h);g.clip();g.translate(r.x,r.y);g.scale(r.w/700,r.h/1030);
  scenery(g,t);
  if(a.previousBackdrop)g.drawImage(a.previousBackdrop,0,0,700,1030);
  if(a.backdrop){g.save();g.globalAlpha=a.backdropMix??1;g.drawImage(a.backdrop,0,0,700,1030);g.restore();}
  // Keep the character's proportions when the call has wider, two-person tiles.
  const fit = Math.min(1, (r.h / 1030) / (r.w / 700));
  g.save(); g.translate(350 * (1 - fit), 0); g.scale(fit, 1);
  // The little chair and table belong to the drawing, and keep her grounded in a shared room.
  shape(g,p=>p.roundRect(198,653,302,282,[85,85,30,30]),'#9aaae0','#6379b6',3);
  const sway=Math.sin(t*.8)*3, bx=350+E.turn*15+E.lean*18+sway,by=687+E.breath*2-E.bounce*13+E.droop*10;
  const hw=E.handW;
  let left=[bx-165-E.armL*29,by+107-E.armL*82-E.shrug*60],right=[bx+163+E.armR*27,by+110-E.armR*78-E.shrug*60];
  if(E.hand==='wave')left=[mix(left[0],bx-237,hw),mix(left[1],by-258,hw)];
  if(E.hand==='open')left=[mix(left[0],bx-219,hw),mix(left[1],by-38,hw)];
  if(E.hand==='chin')right=[mix(right[0],bx+53,hw),mix(right[1],by-175,hw)];
  if(E.hand==='cover'||E.hand==='cheek')right=[mix(right[0],bx+(E.hand==='cheek'?125:12),hw),mix(right[1],by-223,hw)];
  left=follow(key+'-left',...left,dt);right=follow(key+'-right',...right,dt);
  // A soft periwinkle knit, cream sleeves, stitched details: no metal plates or robotic joints.
  g.save();g.translate(bx,by);g.rotate(E.tilt*.25);
  shape(g,p=>{p.moveTo(-57,-80);p.bezierCurveTo(-127,-65,-137,24,-123,113);p.quadraticCurveTo(-147,182,-109,221);p.quadraticCurveTo(0,253,111,219);p.quadraticCurveTo(142,172,124,106);p.bezierCurveTo(143,7,110,-70,52,-80);p.closePath();},gradient(g,-115,-60,126,224,['#f9e9cd','#e4e4f4','#c9d2f0']),INK,3.5);
  shape(g,p=>{p.moveTo(-63,-73);p.lineTo(-76,206);p.quadraticCurveTo(0,228,81,206);p.lineTo(64,-73);p.quadraticCurveTo(0,-41,-63,-73);p.closePath();},gradient(g,-50,-65,94,207,['#6c95ee','#4970d5','#475fc0']),INK,3);
  for(let i=-4;i<=4;i++)curve(g,[[i*14,168],[i*14,188],[i*14,198],[i*14,210]],'#b0c8fc55',2);
  shape(g,p=>{p.moveTo(-62,-75);p.quadraticCurveTo(0,-43,62,-75);p.lineTo(62,-51);p.quadraticCurveTo(0,-16,-62,-51);p.closePath();},'#eaeaf8',INK,2.5);
  for(const side of [-1,1]) {
    curve(g,[[side*96,30],[side*90,64],[side*103,85],[side*93,112]],'#9aa8c7',1.4);
    curve(g,[[side*90,130],[side*97,143],[side*104,145],[side*113,142]],'#9aa8c7',1.4);
    curve(g,[[side*34,79],[side*49,94],[side*48,116],[side*43,126]],'#adc4f480',1.4);
  }
  for(let i=0;i<4;i++)oval(g,-88,18+i*40,2,2,'#fdf7e9','#9babce',1);
  // The original >_ mark, as a small stitched emblem. Identity without another name label.
  curve(g,[[-19,12],[-14,19],[-11,24],[-7,30]],'#f4f2ff',6);curve(g,[[-7,30],[-11,36],[-15,42],[-19,47]],'#f4f2ff',6);curve(g,[[7,46],[15,46],[22,46],[28,46]],'#f4f2ff',6);
  g.restore();
  for(const [side,p]of[[-1,left],[1,right]])sleeve(g,[bx+side*106,by-29],[bx+side*158,mix(by+80,p[1]+35,.5)],p);
  // One cloud-shaped head. Its lobes spread with delight and settle with sadness.
  g.save();g.translate(bx+E.turn*11,by-278+E.nod*35+E.droop*17-E.shock*12);
  g.rotate(E.tilt*.9+E.shake*Math.sin(t*19)*.04);g.scale(1+E.flare*.045+E.squash*.06,1-E.squash*.04-E.droop*.025);
  g.shadowColor='#34477d35';g.shadowBlur=14;g.shadowOffsetY=12;
  shape(g,cloud,gradient(g,-152,-191,168,178,['#b7b9ff','#7199f8','#3e69ec','#4743cc']),INK,4);
  g.shadowColor='transparent';g.shadowOffsetY=0;
  g.save();g.clip();g.translate(-350,-409);grain(g,1.8);g.restore();
  curve(g,[[-158,-80],[-144,-110],[-122,-116],[-103,-116]],'#c8d8ff99',3);
  curve(g,[[-80,-157],[-47,-185],[-2,-175],[17,-158]],'#e9dfffaa',3);
  curve(g,[[82,127],[115,127],[134,108],[139,91]],'#223fc550',4);
  face(g,E,t);g.restore();
  for(const [side,p]of[[-1,left],[1,right]]) {
    const posed=side<0?['wave','open'].includes(E.hand):['chin','cover','cheek'].includes(E.hand);
    let angle=side*(2.7-E.speaking*.8-E.shrug*1.6);
    if(posed)angle=mix(angle,E.hand==='open'?-1.2:side*.2,hw);
    if(E.hand==='wave'&&side<0)angle+=Math.sin(t*10)*.19*hw;
    hand(g,...p,angle,clamp(E.speaking*.4+E.shrug*.6+(E.hand==='wave'?hw:0)));
  }
  // Emotion accents are brief, small ink gestures rather than permanent decorative chrome.
  if(E.sparkle>.15){g.save();g.globalAlpha=E.sparkle*.8;star(g,bx-245,by-413,11,'#fff4be');star(g,bx+220,by-398,8,'#fff4be');g.restore();}
  if(E.shock>.15){g.save();g.globalAlpha=E.shock;for(let i=-1;i<=1;i++)curve(g,[[bx+230+i*15,by-437],[bx+233+i*16,by-455],[bx+236+i*17,by-462],[bx+239+i*18,by-472]],INK,3);g.restore();}
  g.restore();
  shape(g,p=>{p.moveTo(-10,950);p.quadraticCurveTo(350,883,710,950);p.lineTo(710,1035);p.lineTo(-10,1035);p.closePath();},gradient(g,0,921,0,1040,['#c7d9f3','#a0b9e0']),'#7188b8',3);
  grain(g,.45);g.restore();
}
