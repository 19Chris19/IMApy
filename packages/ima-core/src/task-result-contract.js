'use strict';
// Pure normalized task-result contract; no credentials, filesystem or service startup.
const terminal = new Set(['succeeded','failed','cancelled','indeterminate']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const fault = code => Object.assign(new Error(code), {code});
const ref = v => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const identifier = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(v);
function generalPin(v) { if (!exact(v,['modelRef','mode','webSearch']) || !ref(v.modelRef) || !['quick','deep'].includes(v.mode) || typeof v.webSearch !== 'boolean') throw fault('invalid_general_selection'); return Object.freeze({modelRef:v.modelRef,mode:v.mode,webSearch:v.webSearch}); }
function libraryPin(v) { if (!exact(v,['scopeRef']) || !ref(v.scopeRef)) throw fault('invalid_library_selection'); return Object.freeze({...v}); }
function createTaskResultContract({chat,web,generalSelection=generalPin,librarySelection=libraryPin} = {}) {
 if (typeof chat?.mergeCitations !== 'function' || typeof web?.inspectWebEvidence !== 'function') throw fault('invalid_task_result_contract');
function project(snapshot, { onCitationDiagnostic } = {}) {
  const { task } = snapshot;
  const events = snapshot.snapshot?.events || [];
  let answer = '', sources = [], citationMap = {}, done = null, failureReason, suggestions = [];
  const steps = new Map();
  const diagnosticSignatures = new Set();
  for (const { event, data = {} } of events) {
    if (event === 'delta') answer += data.text || '';
    if (Array.isArray(data.sources)) sources = data.sources;
    if (data.citationMap) {
      citationMap = mergeCitations(citationMap, data.citationMap);
      if (typeof onCitationDiagnostic === 'function') for (const [key, entry] of Object.entries(data.citationMap).slice(0, 100)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const current = citationMap[key];
        const numbers = Array.isArray(entry.displayNumbers) ? entry.displayNumbers : [];
        const category = current?.conflicted ? 'conflicted' : numbers.some(n => !current?.displayNumbers?.includes(n))
          ? 'projection_loss' : entry.type === 'unknown' ? 'classification_unproved' : 'preserved';
        if (!diagnosticSignatures.has(category) && diagnosticSignatures.size < 16) {
          diagnosticSignatures.add(category);
          try { onCitationDiagnostic(Object.freeze({ phase: 'projection', category })); } catch { /* Optional, memory-only observer. */ }
        }
      }
    }
    for (const step of event === 'process' ? [data] : data.process || []) {
      if (['knowledge', 'web', 'answer'].includes(step?.phase) && ['running', 'completed', 'failed', 'cancelled'].includes(step.status)) {
        steps.set(step.phase, { stepId: `chat:${step.phase}`, phase: step.phase, status: step.status });
      }
    }
    if (Array.isArray(data.suggestions)) suggestions = [...new Set(data.suggestions.filter(x => typeof x === 'string' && x.trim() && x.length <= 2000))].slice(0, 3);
    if (event === 'done') done = data;
    if (event === 'error') failureReason = data.failureReason;
  }
  if (task.sessionKind === 'scoped_agent' && (task.requestedSelection === undefined || task.librarySelection === undefined ||
    task.sourceIntent !== undefined && task.sourceIntent !== (generalSelection(task.requestedSelection).webSearch ? 'web' : 'knowledge'))) throw fault('invalid_task_selection');
  if (task.sessionKind === 'library' && task.requestedSelection !== undefined) throw fault('invalid_task_selection');
  citationMap = chat.withDisplayNumbers(citationMap, answer);
  return { taskId: task.id, conversationId: task.conversationId, status: task.status, question: task.question,
    answer, sources, citationMap, ...chat.citationDetails(citationMap, answer), process: [...steps.values()], suggestions,
    ...(task.requestedSelection !== undefined ? { sessionKind: task.sessionKind === 'scoped_agent' ? 'scoped_agent' : 'general', requestedSelection: generalSelection(task.requestedSelection) } : {}),
    ...(['library','scoped_agent'].includes(task.sessionKind) ? { sessionKind: task.sessionKind, librarySelection: librarySelection(task.librarySelection) } : {}),
    sourceIntent: task.sourceIntent || 'knowledge',
    ...web.inspectWebEvidence({ done: done || undefined, citationMap, terminal: terminal.has(task.status) }),
    complete: task.status === 'succeeded' && !task.eventsExpired && !snapshot.snapshot?.eventsExpired && Boolean(done) && done.complete !== false && !done.interrupted,
    eventsExpired: Boolean(task.eventsExpired || snapshot.snapshot?.eventsExpired),
    answerBasis: done?.answer_basis ?? done?.answerBasis ?? 'unknown',
    sourceCount: done?.source_count ?? done?.sourceCount ?? sources.length,
    knowledgeSourceCount: done?.knowledge_source_count ?? done?.knowledgeSourceCount ?? null,
    webSourceCount: done?.web_source_count ?? done?.webSourceCount ?? null,
    failureReason: failureReason || (task.status === 'indeterminate' ? 'execution_interrupted' : null),
    lastEventId: task.lastEventId, observedAt: new Date().toISOString() };
}
// Preserve explicit keys and one-to-many relations; never infer a citation from an array index.
function mergeCitations(previous, incoming) {
  // Standalone distribution carries a byte-checked public contract copy;
  // it must not import Provider runtime or upstream credential code.
  return chat.mergeCitations(previous, incoming);
}

const taskFields = ['id','conversationId','status','question','requestedSelection','sessionKind','librarySelection','sourceIntent','eventsExpired','lastEventId'];
const doneFields = ['complete','interrupted','answer_basis','answerBasis','source_count','sourceCount','knowledge_source_count','knowledgeSourceCount','web_source_count','webSourceCount'];
const pick = (value, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(value || {}, k)).map(k => [k,value[k]]));
function validTask(task) {
  return object(task) && identifier(task.id) && identifier(task.conversationId)
    && ['queued','running',...terminal].includes(task.status)
    && Number.isSafeInteger(task.lastEventId) && task.lastEventId >= 0
    && (task.question === undefined || typeof task.question === 'string');
}
function pack(snapshot) {
  if (!validTask(snapshot?.task) || !Array.isArray(snapshot?.snapshot?.events)) throw fault('invalid_task_result_view');
  const value = project(snapshot), original = snapshot.snapshot.events;
  const events = [
    {event:'delta',data:{text:value.answer}},
    {event:'sources',data:{sources:value.sources,citationMap:value.citationMap,process:value.process,suggestions:value.suggestions}},
  ];
  const done = original.findLast(item => item.event === 'done');
  if (done) events.push({event:'done',data:pick(done.data,doneFields)});
  if (value.failureReason !== null && value.failureReason !== undefined) events.push({event:'error',data:{failureReason:value.failureReason}});
  // These are canonical result frames, never replay cursors. Keep the actual
  // task's lastEventId and original event count, and leave raw logs untouched.
  return {schemaVersion:1,kind:'agent_result_v1',sourceEventCount:original.length,
    task:pick(snapshot.task,taskFields),snapshot:{events,
      ...(Object.hasOwn(snapshot.snapshot,'eventsExpired') ? {eventsExpired:snapshot.snapshot.eventsExpired} : {})}};
}
function compactSnapshot(value, {taskId} = {}) {
  const invalid = () => { throw fault('invalid_task_result_view'); };
  if (!exact(value,['schemaVersion','kind','sourceEventCount','task','snapshot']) || value.schemaVersion !== 1
    || value.kind !== 'agent_result_v1' || !validTask(value.task) || value.task.id !== taskId
    || Object.keys(value.task).some(k=>!taskFields.includes(k)) || !Number.isSafeInteger(value.sourceEventCount) || value.sourceEventCount < 0
    || !exact(value.snapshot,['events',...(Object.hasOwn(value.snapshot || {},'eventsExpired')?['eventsExpired']:[])])
    || Object.hasOwn(value.snapshot,'eventsExpired') && typeof value.snapshot.eventsExpired !== 'boolean'
    || !Array.isArray(value.snapshot.events) || value.snapshot.events.length < 2 || value.snapshot.events.length > 4
    || value.sourceEventCount > value.task.lastEventId) invalid();
  const events=value.snapshot.events;
  for(let index=0;index<events.length;index++){
    const item=events[index];if(!exact(item,['event','data']) || !object(item.data)) invalid();
    if(index===0){if(item.event!=='delta'||!exact(item.data,['text'])||typeof item.data.text!=='string') invalid();}
    else if(index===1){if(item.event!=='sources'||!exact(item.data,['sources','citationMap','process','suggestions'])
      ||!Array.isArray(item.data.sources)||!object(item.data.citationMap)||!Array.isArray(item.data.process)||!Array.isArray(item.data.suggestions)) invalid();}
    else if(item.event==='done'){if(index!==2||Object.keys(item.data).some(k=>!doneFields.includes(k))) invalid();}
    else if(item.event==='error'){if(index!==events.length-1||!exact(item.data,['failureReason'])) invalid();}
    else invalid();
  }
  if(events.length===4&&(events[2].event!=='done'||events[3].event!=='error')) invalid();
  const hasDone=events.some(e=>e.event==='done'),hasText=Boolean(events[0].data.text);
  if((hasDone||hasText)&&value.sourceEventCount<1 || hasDone&&hasText&&value.sourceEventCount<2) invalid();
  // Run the same selection/lifecycle/evidence validation as a raw result. The
  // transport never gets to invent a complete answer or trust a web claim.
  return {task:value.task,snapshot:value.snapshot};
}
function unpack(value, options) {
  const snapshot=compactSnapshot(value,options);project(snapshot);return snapshot;
}
// Same validation and evidence projection, returned once instead of building
// and discarding a full result inside unpack() before the caller projects again.
function projectPacked(value, options) { return project(compactSnapshot(value,options)); }
 return Object.freeze({project,pack,unpack,projectPacked});
}
module.exports={createTaskResultContract};
