import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export function validateInput(input) {
  if (!keys(input, ['tournamentId','title','scoreUnit','players']) || !word(input.tournamentId)
    || !line(input.title,60) || !line(input.scoreUnit,20) || !Array.isArray(input.players)
    || input.players.length < 2 || input.players.length > 6) throw new Error('Provide a bounded tournament manifest with two to six players.');
  const ids = new Set();
  for (const player of input.players) {
    if (!keys(player,['id','label']) || !word(player.id) || player.id.length > 16 || ids.has(player.id)
      || ['constructor','prototype','__proto__'].includes(player.id) || !line(player.label,40)) throw new Error('Players need unique bounded IDs and labels.');
    ids.add(player.id);
  }
  return {...structuredClone(input),players:[...input.players].map(p=>({...p})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact scorekeeper UUID and label.');
  return structuredClone(config);
}
export function schedule(rawInput) {
  const input=validateInput(rawInput), ring=input.players.map(p=>p.id);
  if (ring.length%2) ring.push(null);
  const rounds=[],fixtures=[];
  for(let round=1;round<ring.length;round++) {
    const pairs=[];let byePlayerId=null;
    for(let i=0;i<ring.length/2;i++) {
      const one=ring[i],two=ring[ring.length-1-i];
      if(one===null||two===null) byePlayerId=one??two;
      else {const [a,b]=[one,two].sort();pairs.push({a,b});}
    }
    pairs.sort((x,y)=>x.a<y.a?-1:x.a>y.a?1:x.b<y.b?-1:x.b>y.b?1:0);
    const games=pairs.map((pair,i)=>({id:`r${round}-m${i+1}`,round,...pair}));
    rounds.push({round,fixtureIds:games.map(g=>g.id),byePlayerId});fixtures.push(...games);
    ring.splice(1,0,ring.pop());
  }
  return {rounds,fixtures};
}
export const fixturesFor = input => schedule(input).fixtures;
export function parseScore(text) {
  if(text==='Unknown') return {kind:'unknown',aScore:null,bScore:null};
  if(typeof text!=='string'||!/^(0|[1-9][0-9]?)-(0|[1-9][0-9]?)$/.test(text)) throw new Error('Use A-B with integers 0 to 99, such as 2-1, or exactly Unknown.');
  const [aScore,bScore]=text.split('-').map(Number);return {kind:'score',aScore,bScore};
}
export function requestFor(rawInput,rawConfig,fixtureId,attemptId) {
  const input=validateInput(rawInput),config=validateConfig(rawConfig),fixture=fixturesFor(input).find(f=>f.id===fixtureId);
  if(!fixture||!isId(attemptId)) throw new Error('Invalid fixture or attempt.');
  const player=id=>input.players.find(p=>p.id===id);
  const a=player(fixture.a),b=player(fixture.b);
  const prompt=`${input.title}\nRound ${fixture.round}, ${fixture.id}\nA: ${a.label} [${a.id}]\nB: ${b.label} [${b.id}]\nAfter this match is played, enter the actual ${input.scoreUnit} as A-B (each 0 to 99), for example 2-1. Higher score wins; equal scores draw. Type Unknown if unavailable. Do not predict or invent a result.`;
  if(prompt.length>500) throw new Error('Match prompt exceeds 500 characters.');
  const key=`round-robin-${attemptId}`;
  return {prompt,context:`To ${config.participant.id}`,text_input:{placeholder:'A-B or Unknown',max_length:60},responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),fixture_id:fixtureId,attempt_id:attemptId},idempotencyKey:key};
}
const scoreInteger=value=>Number.isSafeInteger(value)&&value>=0&&value<=99&&!Object.is(value,-0);
export function deriveStandings(rawInput,results) {
  const input=validateInput(rawInput),fixtures=fixturesFor(input),seen=new Set();
  if(!Array.isArray(results)||results.length>fixtures.length) throw new Error('Invalid match result list.');
  const rows=new Map(input.players.map(p=>[p.id,{playerId:p.id,label:p.label,played:0,won:0,drawn:0,lost:0,points:0,scoreFor:0,scoreAgainst:0}]));
  for(const result of results) {
    const fixture=fixtures.find(f=>f.id===result?.fixtureId);
    if(!keys(result,['fixtureId','aScore','bScore'])||!fixture||seen.has(result.fixtureId)||!scoreInteger(result.aScore)||!scoreInteger(result.bScore)) throw new Error('Each observed match needs one bounded score pair.');
    seen.add(result.fixtureId);
    const a=rows.get(fixture.a),b=rows.get(fixture.b);a.played++;b.played++;
    a.scoreFor+=result.aScore;a.scoreAgainst+=result.bScore;b.scoreFor+=result.bScore;b.scoreAgainst+=result.aScore;
    if(result.aScore>result.bScore){a.won++;b.lost++;a.points+=3;}
    else if(result.aScore<result.bScore){b.won++;a.lost++;b.points+=3;}
    else {a.drawn++;b.drawn++;a.points++;b.points++;}
  }
  const ordered=[...rows.values()].sort((a,b)=>b.points-a.points||(a.playerId<b.playerId?-1:a.playerId>b.playerId?1:0));
  let place=0,previousPoints=null;
  return ordered.map((row,index)=>{if(row.points!==previousPoints)place=index+1;previousPoints=row.points;return {place,...row};});
}
export function preview(rawInput) {
  const input=validateInput(rawInput);
  return {tournamentId:input.tournamentId,title:input.title,scoreUnit:input.scoreUnit,inputHash:hash(input),players:input.players,
    scoring:{win:3,draw:1,loss:0,tieBreak:'shared place on equal points'},...schedule(input)};
}
export function report(state,rawInput) {
  const input=validateInput(rawInput);validateState(state,input);
  const fixtures=fixturesFor(input);
  const matches=fixtures.map(fixture=>{
    const attempt=state.attempts.find(a=>a.fixtureId===fixture.id),answer=attempt?.observation?.answer;
    return {...fixture,status:attempt?.status==='creating'?'create_unknown':attempt?.status??'unasked',text:answer?.text??null,kind:answer?.kind??null,
      aScore:answer?.aScore??null,bScore:answer?.bScore??null,result:answer?.kind==='score'?(answer.aScore>answer.bScore?'a_win':answer.aScore<answer.bScore?'b_win':'draw'):null,
      questionId:attempt?.questionId??null,attemptId:attempt?.id??null,responderId:answer?.responderId??null,answeredAt:answer?.answeredAt??null,
      askerId:attempt?.observation?.askerId??null,observedAt:attempt?.observation?.checkedAt??null};
  });
  const scores=matches.filter(m=>m.kind==='score').map(({id:fixtureId,aScore,bScore})=>({fixtureId,aScore,bScore}));
  const complete=scores.length===fixtures.length,standings=deriveStandings(input,scores),active=matches.find(m=>['create_unknown','pending'].includes(m.status));
  const status=active?.status??(matches.some(m=>m.status==='unasked')?'ready':complete?'complete':'incomplete');
  return {...preview(input),status,participant:state.config.participant,matches,reportedMatchCount:scores.length,
    missingFixtureIds:matches.filter(m=>m.kind!=='score').map(m=>m.id),currentFixture:active?fixtures.find(f=>f.id===active.id):null,nextFixture:active?null:fixtures[state.attempts.length]??null,
    provisionalStandings:standings,finalStandings:complete?standings:null,firstPlacePlayerIds:complete?standings.filter(row=>row.place===1).map(row=>row.playerId):null};
}

export function validateState(state,input) {
  input=validateInput(input);
  const fixtures=fixturesFor(input);
  if (!keys(state,['version','inputHash','config','room','credentialHash','startedAt','attempts']) || state.version!==1
    || state.inputHash!==hash(input) || typeof state.room!=='string' || !ROOM.test(state.room)
    || typeof state.credentialHash!=='string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length>fixtures.length || iso(state.startedAt)!==state.startedAt) throw new Error('Invalid state or changed tournament manifest. Restore the original inputs.');
  validateConfig(state.config);
  const ids=new Set(),questionIds=new Set();let previous=state.startedAt,askerId;
  for (const [index,attempt] of state.attempts.entries()) {
    if (!keys(attempt,['id','fixtureId','createdAt','request','questionId','status','observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.fixtureId!==fixtures[index].id || iso(attempt.createdAt)!==attempt.createdAt || attempt.createdAt<previous
      || hash(attempt.request)!==hash(requestFor(input,state.config,attempt.fixtureId,attempt.id))
      || !['creating','pending','answered','expired','cancelled','invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved match request.');
    ids.add(attempt.id);previous=attempt.createdAt;
    if (attempt.status==='creating') {
      if (attempt.questionId!==null || attempt.observation!==null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);validateObservation(attempt.observation,attempt.status,attempt.request);
      if (Date.parse(attempt.observation.createdAt)<Date.parse(attempt.createdAt)-CLOCK_SKEW_MS || attempt.observation.checkedAt<attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous=attempt.observation.checkedAt;
      if (askerId!==undefined && attempt.observation.askerId!==askerId) throw new Error('Questions belong to different asking registrations.');
      askerId=attempt.observation.askerId;
    }
    if (['creating','pending'].includes(attempt.status) && index!==state.attempts.length-1) throw new Error('Only the last fixture may have an active Question.');
  }
  return state;
}
function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'aScore', 'bScore', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseScore(answer.text)) !== hash({ kind: answer.kind, aScore: answer.aScore, bScore: answer.bScore })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved score evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered matches must not contain score evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved fixture, room, or scorekeeper.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseScore(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
