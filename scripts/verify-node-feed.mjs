// verify-node-feed.mjs —— 确认 /topic/node/topics 对不同 nodeId 真的返回不同内容
import fs from 'node:fs/promises';
import path from 'node:path';
const OUT='out35';
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BASE='https://haijiao.com';
const dec = p => { let c=String(p).trim(); for(let i=0;i<6;i++){ const b=Buffer.from(c,'base64'), t=b.toString('utf8'); try{return JSON.parse(t)}catch(e){c=t.trim()} } return null; };
async function g(p){ const r=await fetch(BASE+p,{headers:{'User-Agent':UA,'Accept':'application/json, text/plain, */*','Referer':BASE+'/home','mver':'211112203214','x-user-id':'null','x-user-token':'null'}}); const t=await r.text(); try{const e=JSON.parse(t); return e.data?dec(e.data):null}catch{return null} }
const ids = d => (d&&d.results?d.results.map(x=>x.topicId):[]);
async function main(){
  const nodes=[900,2020,1001,115,205];
  const got={};
  for(const n of nodes){
    const d=await g(`/api/topic/node/topics?nodeId=${n}&page=1&type=1`);
    got[n]=ids(d);
    console.log(`nodeId=${String(n).padEnd(5)} 条数=${got[n].length}  前3=${got[n].slice(0,3).join(',')}`);
  }
  const keys=Object.keys(got);
  let allDiff=true;
  for(let i=0;i<keys.length;i++)for(let j=i+1;j<keys.length;j++){
    const a=new Set(got[keys[i]]), b=new Set(got[keys[j]]);
    let hit=0; for(const x of a) if(b.has(x)) hit++;
    const ov = a.size? hit/Math.max(a.size,b.size):0;
    if(ov>0.9) allDiff=false;
    console.log(`  ${keys[i]} vs ${keys[j]}: 重合 ${(ov*100).toFixed(0)}%`);
  }
  console.log(allDiff?'\n结论：不同 nodeId 返回不同内容，过滤真实生效 ✓':'\n结论：仍有大量重合，可能接口不对 ✗');
  await fs.mkdir(OUT,{recursive:true});
  await fs.writeFile(path.join(OUT,'verify.json'),JSON.stringify(got,null,2));
}
await fs.mkdir(OUT,{recursive:true});
await main();
console.log('done');