import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, fixturesFor, parseScore, deriveStandings, schedule, preview, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/tournament.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-round-robin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.matches.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later match scores; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '2-1'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.fixture_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a score', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '2-1'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.finalStandings, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across match scores', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '2-1'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).finalStandings, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '2-1');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '2-1'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '2-1'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing scorekeeper before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '2-1');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '2-1'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).finalStandings, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const roster = n => ({...simple(),players:Array.from({length:n},(_,i)=>({id:`p${i}`,label:`Player ${i}`}))});

test('circle fixtures cover every pair once with no round clashes and one bye per odd-roster player', () => {
  for(let n=2;n<=6;n++) {
    const input=roster(n),plan=schedule(input),pairs=new Set(),byeCounts=new Map(input.players.map(p=>[p.id,0]));
    assert.equal(plan.fixtures.length,n*(n-1)/2);assert.equal(plan.rounds.length,n%2?n:n-1);
    for(const round of plan.rounds) {
      const players=[];
      for(const fixture of plan.fixtures.filter(f=>f.round===round.round)) {
        assert.ok(fixture.a<fixture.b);players.push(fixture.a,fixture.b);
        const pair=[fixture.a,fixture.b].sort().join('|');assert.equal(pairs.has(pair),false);pairs.add(pair);
      }
      assert.equal(new Set(players).size,players.length);
      assert.deepEqual(round.fixtureIds,plan.fixtures.filter(f=>f.round===round.round).map(f=>f.id));
      if(n%2) {assert.equal(players.includes(round.byePlayerId),false);byeCounts.set(round.byePlayerId,byeCounts.get(round.byePlayerId)+1);}
      else assert.equal(round.byePlayerId,null);
      assert.deepEqual([...players,...(round.byePlayerId?[round.byePlayerId]:[])].sort(),input.players.map(p=>p.id));
    }
    const expected=new Set();for(let a=0;a<n;a++)for(let b=a+1;b<n;b++)expected.add(`p${a}|p${b}`);
    assert.deepEqual(pairs,expected);assert.ok([...byeCounts.values()].every(v=>v===(n%2?1:0)));
  }
});

test('roster input order cannot change fixture meaning or canonical identity', async t => {
  for(let n=2;n<=6;n++) {
    const input=roster(n),reordered={...input,players:[...input.players].reverse()};
    assert.deepEqual(schedule(input),schedule(reordered));assert.deepEqual(validateInput(input),validateInput(reordered));
    assert.equal(preview(input).inputHash,preview(reordered).inputHash);
    for(const f of fixturesFor(input))assert.deepEqual(requestFor(input,CONFIG,f.id,id(1)),requestFor(reordered,CONFIG,f.id,id(1)));
  }
  const s=await setup(t);await s.run();const state=await s.saved(),reverse={...s.options.input,players:[...s.options.input.players].reverse()};
  assert.doesNotThrow(()=>validateState(state,reverse));assert.equal((await s.run({input:reverse})).status,'pending');
});

test('normalized scores accept canonical 0–99 A-B only and never turn Unknown into a draw', () => {
  for(const a of [0,1,9,10,99])for(const b of [0,1,9,10,99])assert.deepEqual(parseScore(`${a}-${b}`),{kind:'score',aScore:a,bScore:b});
  assert.deepEqual(parseScore('Unknown'),{kind:'unknown',aScore:null,bScore:null});
  for(const value of ['unknown','Unknown ',' 2-1','2-1 ','02-1','1-01','-0-0','+1-2','1 - 2','1:2','1.0-2','1e1-2','100-0','0-100','1–2','1-2\n',null,1,''])assert.throws(()=>parseScore(value));
});

test('scores derive WDL, points and score totals; equal points share competition places', () => {
  const input=roster(4),values=fixturesFor(input).map(f=>({fixtureId:f.id,aScore:2,bScore:2}));
  const rows=deriveStandings(input,values);
  assert.deepEqual(rows.map(r=>r.place),[1,1,1,1]);assert.ok(rows.every(r=>r.played===3&&r.drawn===3&&r.points===3&&r.scoreFor===6&&r.scoreAgainst===6));
  const partial=deriveStandings(input,[{fixtureId:fixturesFor(input)[0].id,aScore:99,bScore:0}]);
  assert.deepEqual(partial.map(r=>r.place),[1,2,2,2]);assert.equal(partial[0].won,1);assert.equal(partial[0].points,3);
  assert.equal(partial.reduce((s,r)=>s+r.lost,0),1);assert.equal(partial.reduce((s,r)=>s+r.played,0),2);
});

test('standings match an independent per-player oracle over every four-player win/draw/loss combination', () => {
  const input=roster(4),fixtures=fixturesFor(input);let cases=0;
  for(let mask=0;mask<3**fixtures.length;mask++) {
    let remaining=mask;
    const results=fixtures.map(f=>{const outcome=remaining%3;remaining=Math.floor(remaining/3);return {fixtureId:f.id,aScore:outcome===0?0:1,bScore:outcome===2?0:1};});
    const rows=deriveStandings(input,results);
    for(const row of rows) {
      const games=fixtures.map((f,i)=>({...f,...results[i]})).filter(f=>f.a===row.playerId||f.b===row.playerId);
      const mine=games.map(f=>f.a===row.playerId?f.aScore:f.bScore),theirs=games.map(f=>f.a===row.playerId?f.bScore:f.aScore);
      const won=mine.filter((s,i)=>s>theirs[i]).length,drawn=mine.filter((s,i)=>s===theirs[i]).length,lost=mine.filter((s,i)=>s<theirs[i]).length;
      assert.deepEqual({won:row.won,drawn:row.drawn,lost:row.lost,points:row.points,played:row.played,scoreFor:row.scoreFor,scoreAgainst:row.scoreAgainst},
        {won,drawn,lost,points:3*won+drawn,played:games.length,scoreFor:mine.reduce((a,b)=>a+b,0),scoreAgainst:theirs.reduce((a,b)=>a+b,0)});
      assert.equal(row.place,1+rows.filter(other=>other.points>row.points).length);
    }
    assert.equal(rows.reduce((s,r)=>s+r.scoreFor,0),rows.reduce((s,r)=>s+r.scoreAgainst,0));assert.equal(rows.reduce((s,r)=>s+r.played,0),2*fixtures.length);cases++;
  }
  assert.equal(cases,729);
});

test('complete SDK session keeps attributed scores and shared first place without an alphabetical winner', async t => {
  const s=await setup(t),result=await decide(s,['1-1','0-0','99-99']);
  assert.equal(result.status,'complete');assert.equal(result.reportedMatchCount,3);
  assert.deepEqual(result.firstPlacePlayerIds,['amber','birch','cedar']);assert.ok(result.finalStandings.every(r=>r.place===1));
  assert.equal(result.matches[0].responderId,CONFIG.participant.id);assert.equal(result.matches[0].askerId,ASKER);
  assert.equal(result.matches[1].aScore,0);assert.equal(result.matches[1].result,'draw');
  const before=s.api.calls.length;assert.deepEqual((await s.run()).finalStandings,result.finalStandings);assert.equal(s.api.calls.length,before);
  assert.deepEqual((await localReport(s.directory,s.options.input,{save:true})).finalStandings,result.finalStandings);
});

test('unresolved and Unknown scores stay absent from provisional totals and withhold final standings', async t => {
  const s=await setup(t);let result=await decide(s,['3-1']);
  assert.equal(result.status,'ready');assert.equal(result.finalStandings,null);assert.equal(result.firstPlacePlayerIds,null);
  assert.equal(result.provisionalStandings.reduce((sum,r)=>sum+r.played,0),2);assert.equal(result.missingFixtureIds.length,2);
  result=await decide(s,['Unknown','0-0']);assert.equal(result.status,'incomplete');assert.equal(result.finalStandings,null);assert.equal(result.firstPlacePlayerIds,null);
  assert.equal(result.matches[1].kind,'unknown');assert.equal(result.matches[1].aScore,null);assert.equal(result.matches[1].result,null);
  assert.equal(result.provisionalStandings.reduce((sum,r)=>sum+r.played,0),4);assert.equal(result.reportedMatchCount,2);
});

test('expiry, cancellation and invalid score text cannot become zero scores or draws', async t => {
  for(const terminal of ['expired','cancelled','invalid']) {
    const s=await setup(t);await s.run();
    if(terminal==='expired'){s.clock.value='2026-01-01T09:16:00.000Z';s.api.terminal(id(1),'expired');}
    else if(terminal==='cancelled')s.api.terminal(id(1),'cancelled');else s.api.answer(id(1),'100-0');
    let result=await s.run();assert.equal(result.finalStandings,null);assert.equal(result.matches[0].aScore,null);assert.equal(result.matches[0].result,null);
    result=await decide(s,['1-0','1-0']);assert.equal(result.status,'incomplete');assert.equal(result.reportedMatchCount,2);
  }
});

test('manifest and result helpers reject malformed schemas, duplicate results and out-of-range values', async t => {
  for(const mutate of [i=>i.players.pop(),i=>i.players=roster(6).players.concat({id:'extra',label:'Extra'}),i=>i.players[0].id=i.players[1].id,
    i=>i.players[0].id='constructor',i=>i.players[0].id='p'.repeat(17),i=>i.players[0].label='x'.repeat(41),i=>i.scoreUnit='units\n',i=>i.title='',i=>i.extra=true]) {
    const input=roster(2);mutate(input);const s=await setup(t,input);await assert.rejects(s.run());assert.equal(s.api.calls.length,0);
  }
  const input=roster(2),first={fixtureId:'r1-m1',aScore:0,bScore:0};
  for(const results of [[first,first],[{...first,fixtureId:'missing'}],[{...first,aScore:-0}],[{...first,aScore:-1}],[{...first,bScore:100}],[{...first,bScore:1.5}],[{...first,extra:true}],null])assert.throws(()=>deriveStandings(input,results));
  assert.throws(()=>validateConfig({...CONFIG,extra:true}));
});

test('roster, labels, units, scorekeeper, room and credentials stay bound to saved evidence', async t => {
  const s=await setup(t);await decide(s,['2-1']);const before=s.api.calls.length;
  for(const mutate of [i=>i.players[0].label='Changed',i=>i.players[0].id='other',i=>i.scoreUnit='goals',i=>i.title='Other match']) {
    const input=simple();mutate(input);await assert.rejects(s.run({input}));
  }
  await assert.rejects(s.run({token:'other'}));await assert.rejects(s.run({room:'OTHER1234567'}));await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}));assert.equal(s.api.calls.length,before);
  const original=await s.saved();for(const mutate of [state=>state.attempts[0].observation.answer.aScore=3,state=>state.attempts[0].fixtureId='r2-m1',state=>state.attempts[0].observation.answer.kind='unknown']) {
    const state=structuredClone(original);mutate(state);assert.throws(()=>validateState(state,s.options.input));
  }
});

test('maximum field lengths fit API bounds and six players complete exactly 15 Questions', async t => {
  const input={tournamentId:'t'.repeat(40),title:'T'.repeat(60),scoreUnit:'s'.repeat(20),players:Array.from({length:6},(_,i)=>({id:`p${i}`+'a'.repeat(14),label:'L'.repeat(40)}))};
  for(const fixture of fixturesFor(input)) {
    const request=requestFor(input,CONFIG,fixture.id,id(99));assert.ok(request.prompt.length<=500);assert.ok(request.context.length<=40);
    assert.equal(request.options,undefined);assert.deepEqual(request.text_input,{placeholder:'A-B or Unknown',max_length:60});
    assert.ok(request.prompt.includes(`A: ${input.players.find(p=>p.id===fixture.a).label} [${fixture.a}]`));
  }
  const s=await setup(t,input),result=await decide(s,Array(15).fill('99-99'));assert.equal(result.status,'complete');assert.equal(sends(s.api),15);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved()))<1024*1024);assert.ok(result.finalStandings.every(r=>r.played===5&&r.scoreFor===495));
});

test('pending or uncertain fixtures remain current and never expose a later fixture as ready', async t => {
  for(const lost of [false,true]) {
    const s=await setup(t);s.api.controls.loseNext=lost;const result=await s.run();
    assert.equal(result.currentFixture.id,'r1-m1');assert.equal(result.nextFixture,null);
    s.api.answer(id(1),'2-1');const resolved=lost?await s.run({command:'recover',attachId:id(1)}):await s.run();
    assert.equal(resolved.currentFixture,null);assert.equal(resolved.nextFixture.id,'r2-m1');
  }
});

test('saved and later observations cannot predate intent or regress across Questions', async t => {
  const s=await setup(t);await s.run();s.clock.value='2026-01-01T09:01:00.000Z';await s.run();
  s.clock.value='2026-01-01T09:00:30.000Z';await assert.rejects(s.run(),/regressed/);
  const state=await s.saved();state.attempts[0].observation.checkedAt='2026-01-01T08:59:59.000Z';assert.throws(()=>validateState(state,s.options.input),/predates/);
  s.clock.value='2026-01-01T09:01:00.000Z';s.api.answer(id(1),'2-1');await s.run();
  s.clock.value='2026-01-01T09:00:59.000Z';await assert.rejects(s.run(),/Invalid saved match/);assert.equal(sends(s.api),1);
});
