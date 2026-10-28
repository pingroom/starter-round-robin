import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.equal(body.options, undefined);
    assert.deepEqual(body.text_input, {placeholder:'A-B or Unknown',max_length:60});
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: [],
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:null, label:null, text:process.env.PROBE_ANSWER, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'round-robin-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/tournament.json'), join(directory, 'tournament.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.equal(answer.code,3,answer.stderr);
  }
  return answer;
}

test('CLI previews offline from another directory and exports complete shared-place standings',async t=>{
  const directory=await fixture(t);
  const preview=await run(directory,['preview'],{PROBE_OFFLINE:'yes'});assert.equal(preview.code,0,preview.stderr);
  assert.equal(JSON.parse(preview.stdout).fixtures.length,3);assert.equal(JSON.parse(preview.stdout).status,'not_started');
  const validation=await run(directory,['validate'],{PROBE_OFFLINE:'yes'});assert.equal(validation.code,0,validation.stderr);
  const finished=await collect(directory,['1-1','0-0','2-2']);assert.equal(finished.code,0,finished.stderr);
  const result=JSON.parse(finished.stdout);assert.equal(result.status,'complete');assert.deepEqual(result.firstPlacePlayerIds,['amber','birch','cedar']);
  for(const command of ['status','report','preview']){const output=await run(directory,[command],{PROBE_OFFLINE:'yes'});assert.equal(output.code,0,output.stderr);assert.equal(JSON.parse(output.stdout).status,'complete');}
  assert.equal((await stat(join(directory,'.tournament/report.json'))).mode&0o777,0o600);
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,3);
});
test('CLI lost creation blocks another send and recovers the exact Question with its score',async t=>{
  const directory=await fixture(t);assert.equal((await run(directory,['run'],{PROBE_LOST:'yes'})).code,4);assert.equal((await run(directory)).code,4);
  const found=await run(directory,['find']);assert.equal(found.code,4,found.stderr);const questionId=JSON.parse(found.stdout).candidates[0].id;
  const recovered=await run(directory,['recover',questionId],{PROBE_ANSWER:'2-1'});assert.equal(recovered.code,3,recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).matches[0].result,'a_win');assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);
  assert.equal((await run(directory,['recover','bad-id'])).code,1);
});
test('CLI Unknown finishes incomplete and excludes missing scores from provisional totals',async t=>{
  const directory=await fixture(t),result=await collect(directory,['2-1','Unknown','0-0']);assert.equal(result.code,2,result.stderr);
  const value=JSON.parse(result.stdout);assert.equal(value.finalStandings,null);assert.equal(value.firstPlacePlayerIds,null);assert.equal(value.reportedMatchCount,2);
  assert.equal(value.provisionalStandings.reduce((sum,row)=>sum+row.played,0),4);
});
test('CLI cancellation and invalid text report failure while later fixtures remain ready',async t=>{
  for(const extra of [{PROBE_CANCEL:'yes'},{PROBE_ANSWER:'100-0'},{PROBE_ANSWER:'01-2'}]){
    const directory=await fixture(t);await run(directory);const result=await run(directory,['run'],extra);
    assert.equal(result.code,2,result.stderr);const value=JSON.parse(result.stdout);assert.equal(value.status,'ready');assert.equal(value.finalStandings,null);assert.equal(value.reportedMatchCount,0);
  }
});
test('CLI rejects partial and blank credentials without exposing them',async t=>{
  const directory=await fixture(t);for(const extra of [{PINGROOM_TOKEN:''},{PINGROOM_ROOM:''},{PINGROOM_TOKEN:'has whitespace'}]){
    const result=await run(directory,['run'],extra);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('has whitespace'),false);
  }
});
