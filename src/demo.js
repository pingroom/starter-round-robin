import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readJson } from './storage.js';
import { step } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input=await readJson(new URL('../examples/tournament.json',import.meta.url));
for(const [scenario,scores,expected] of [
  ['recorded club matches',['2-1','3-0','2-2'],'complete'],
  ['shared first place',['1-1','0-0','2-2'],'complete'],
  ['one score unavailable',['2-1','Unknown','0-0'],'incomplete'],
]) {
  const directory=await mkdtemp(join(tmpdir(),'pingroom-round-robin-demo-'));
  try {
    const now=()=> '2026-01-01T09:00:00.000Z',api=mockApi(now);
    const options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};
    let result;
    for(const score of scores){result=await step(options);api.answer(result.matches.find(m=>m.status==='pending').questionId,score);result=await step(options);}
    assert.equal(result.status,expected);assert.equal(api.calls.filter(c=>c.method==='POST').length,3);
    if(expected==='incomplete'){assert.equal(result.finalStandings,null);assert.equal(result.firstPlacePlayerIds,null);}
    console.log(JSON.stringify({scenario,status:result.status,rounds:result.rounds,fixtures:result.fixtures,provisionalStandings:result.provisionalStandings,finalStandings:result.finalStandings,firstPlacePlayerIds:result.firstPlacePlayerIds},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
console.log('Offline demo used the pinned SDK with a local mock transport. No live phone delivery or competition actions.');
