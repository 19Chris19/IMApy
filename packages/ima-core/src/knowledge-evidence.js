'use strict';

// Private provenance, deliberately independent of the public chat projection.
const { createHash } = require('node:crypto');
const chat = require('./chat-presentation');
const EVENT = 'knowledge_evidence';
const MAX = 100;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const safeKey = key => typeof key === 'string' && /^(index|context):[^\s?&#]{1,128}$/u.test(key)
  && !/(__proto__|constructor|prototype)/u.test(key);
const clean = (value, limit = 512) => typeof value === 'string' && value.length <= limit
  && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const scopeRef = value => /^[a-f0-9]{64}$/u.test(value || '') ? value : '';
const sourceRef = (scope, namespace, id) => hash(JSON.stringify([scope, namespace, id]));
const empty = scope => ({ schemaVersion: 1, scopeRef: scopeRef(scope), materials: {}, citations: {} });
function positions(value) {
  if (value === undefined) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw.length > 2048 || /token|cookie|credential|secret|password|__proto__|constructor|prototype/iu.test(raw)) return undefined;
    return JSON.parse(raw);
  } catch { return undefined; }
}

function normalize(value, catalog = {}) {
  const result = empty(value?.scopeRef);
  if (!object(value) || value.schemaVersion !== 1) return result;
  for (const [ref, item] of Object.entries(object(value.materials) ? value.materials : {}).slice(0, MAX)) {
    if (!object(item) || item.idNamespace !== 'ima_web_media') continue;
    const materialId = clean(item.materialId, 2048);
    if (!materialId || ref !== sourceRef(result.scopeRef, item.idNamespace, materialId)) continue;
    result.materials[ref] = { materialId, idNamespace: item.idNamespace,
      ...(clean(item.title) ? { title: clean(item.title) } : {}),
      ...(clean(item.knowledgeBaseId) ? { knowledgeBaseId: clean(item.knowledgeBaseId) } : {}),
      ...(Number.isSafeInteger(item.mediaType) ? { mediaType: item.mediaType } : {}),
      ...(typeof item.conflicted === 'boolean' ? { conflicted: item.conflicted } : {}) };
  }
  for (const [key, entry] of Object.entries(object(value.citations) ? value.citations : {}).slice(0, MAX)) {
    if (!safeKey(key) || !object(entry)) continue;
    const type = ['knowledge', 'web', 'unknown'].includes(entry.type) ? entry.type : 'unknown';
    const refs = [...new Set(Array.isArray(entry.sourceRefs) ? entry.sourceRefs : [])]
      .filter(ref => own(result.materials, ref) || own(catalog, ref)).slice(0, 10);
    const numbers = [...new Set(Array.isArray(entry.displayNumbers) ? entry.displayNumbers : [])]
      .filter(n => typeof n === 'string' && /^\d{1,6}$/u.test(n)).slice(0, MAX);
    const location = positions(entry.upstreamPositions);
    result.citations[key] = { type, sourceRefs: type === 'web' ? [] : refs, displayNumbers: numbers,
      ...(location !== undefined ? { upstreamPositions: location, positionFormat: 'upstream_opaque' } : {}),
      ...(typeof entry.conflicted === 'boolean' ? { conflicted: entry.conflicted } : {}) };
  }
  return result;
}

function merge(previous, incoming) {
  const result = normalize(previous), next = normalize(incoming, result.materials);
  if (!result.scopeRef && !Object.keys(result.materials).length && !Object.keys(result.citations).length) result.scopeRef = next.scopeRef;
  if (result.scopeRef !== next.scopeRef) return result;
  for (const [ref, item] of Object.entries(next.materials)) {
    const old = result.materials[ref];
    if (!old && Object.keys(result.materials).length >= MAX) continue;
    result.materials[ref] = { ...old, ...item,
      ...((old?.conflicted || (old?.knowledgeBaseId && item.knowledgeBaseId && old.knowledgeBaseId !== item.knowledgeBaseId))
        ? { conflicted: true } : {}) };
  }
  for (const [key, entry] of Object.entries(next.citations)) {
    const old = result.citations[key];
    if (!old && Object.keys(result.citations).length >= MAX) continue;
    const conflicted = old?.conflicted || entry.conflicted || (old && old.type !== 'unknown' && entry.type !== 'unknown' && old.type !== entry.type);
    const type = conflicted ? 'unknown' : entry.type === 'unknown' && old ? old.type : entry.type;
    result.citations[key] = { type,
      sourceRefs: type === 'web' ? [] : [...new Set([...(old?.sourceRefs || []), ...entry.sourceRefs])].slice(0, 10),
      displayNumbers: [...new Set([...(old?.displayNumbers || []), ...entry.displayNumbers])].slice(0, MAX),
      ...(entry.upstreamPositions !== undefined || old?.upstreamPositions !== undefined
        ? { upstreamPositions: entry.upstreamPositions ?? old.upstreamPositions, positionFormat: 'upstream_opaque' } : {}),
      ...(conflicted ? { conflicted: true }
        : typeof old?.conflicted === 'boolean' || typeof entry.conflicted === 'boolean' ? { conflicted: false } : {}) };
  }
  return result;
}

// Private mutable state stays inside this collector. Only incoming records are
// normalized; emitted deltas and snapshots are independent copies. This avoids
// revalidating/copying the whole graph on every repeated source frame.
function createAccumulator(scope) {
  const state = empty(scope); let materialCount = 0, citationCount = 0;
  return Object.freeze({
    append(value) {
      const change = empty(state.scopeRef);
      if (!state.scopeRef || value?.scopeRef !== state.scopeRef) return change;
      const next = normalize(value, state.materials);
      for (const [ref, item] of Object.entries(next.materials)) {
        const old = state.materials[ref];
        if (!old && materialCount >= MAX) continue;
        const merged = { ...old, ...item,
          ...((old?.conflicted || (old?.knowledgeBaseId && item.knowledgeBaseId && old.knowledgeBaseId !== item.knowledgeBaseId))
            ? { conflicted: true } : {}) };
        if (JSON.stringify(old) === JSON.stringify(merged)) continue;
        if (!old) materialCount++;
        state.materials[ref] = merged; change.materials[ref] = merged;
      }
      for (const [key, entry] of Object.entries(next.citations)) {
        const old = state.citations[key];
        if (!old && citationCount >= MAX) continue;
        const conflicted = old?.conflicted || entry.conflicted || (old && old.type !== 'unknown' && entry.type !== 'unknown' && old.type !== entry.type);
        const type = conflicted ? 'unknown' : entry.type === 'unknown' && old ? old.type : entry.type;
        const merged = { type,
          sourceRefs: type === 'web' ? [] : [...new Set([...(old?.sourceRefs || []), ...entry.sourceRefs])]
            .filter(ref => own(state.materials, ref)).slice(0, 10),
          displayNumbers: [...new Set([...(old?.displayNumbers || []), ...entry.displayNumbers])].slice(0, MAX),
          ...(entry.upstreamPositions !== undefined || old?.upstreamPositions !== undefined
            ? { upstreamPositions: entry.upstreamPositions ?? old.upstreamPositions, positionFormat: 'upstream_opaque' } : {}),
          ...(conflicted ? { conflicted: true }
            : typeof old?.conflicted === 'boolean' || typeof entry.conflicted === 'boolean' ? { conflicted: false } : {}) };
        if (JSON.stringify(old) === JSON.stringify(merged)) continue;
        if (!old) citationCount++;
        state.citations[key] = merged; change.citations[key] = merged;
      }
      return structuredClone(change);
    },
    snapshot(answer) { return answer === undefined ? normalize(state) : withDisplayNumbers(state, answer); },
  });
}

// A bounded delta: unchanged titles/IDs are not copied on every source update.
function delta(previous, next) {
  const before = normalize(previous), after = normalize(next), result = empty(after.scopeRef);
  for (const [key, item] of Object.entries(after.materials))
    if (JSON.stringify(before.materials[key]) !== JSON.stringify(item)) result.materials[key] = item;
  for (const [key, item] of Object.entries(after.citations)) {
    if (JSON.stringify(before.citations[key]) === JSON.stringify(item)) continue;
    result.citations[key] = item;
  }
  return result;
}
const hasData = value => Object.keys(value?.materials || {}).length > 0 || Object.keys(value?.citations || {}).length > 0;

function withDisplayNumbers(value, answer) {
  const result = normalize(value), map = chat.withDisplayNumbers(result.citations, answer);
  for (const [key, entry] of Object.entries(result.citations)) entry.displayNumbers = map[key]?.displayNumbers || entry.displayNumbers;
  return result;
}
function fromEvents(events, scope) {
  let result = empty(scope);
  for (const event of events || []) if (event.event === EVENT) result = merge(result, event.data?.knowledgeEvidence);
  return result;
}
function allowed(config, applicationKey) {
  return typeof applicationKey === 'string' && applicationKey.startsWith('application:')
    && Array.isArray(config?.sourceEvidence?.applications)
    && config.sourceEvidence.applications.includes(applicationKey.slice(12));
}
function publicData(name, data) {
  if (name === EVENT) return null;
  const { knowledgeEvidence, ...rest } = data || {};
  return rest;
}
function publicSnapshot(value) {
  return { ...value, snapshot: value.snapshot ? { ...value.snapshot,
    events: (value.snapshot.events || []).filter(event => event.event !== EVENT)
      .map(event => ({ ...event, data: publicData(event.event, event.data) })) } : value.snapshot };
}

// Pure identity lookup, deliberately not a permission check or material read.
// The host supplies the library from its validated account/session context.
function identifyKnowledgeCitations({ evidence, knowledgeBaseId, citationKeys, catalogPages = [] } = {}) {
  const invalid = code => { throw Object.assign(new Error(code), { code }); };
  const exactId = (value, max = 2048) => typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!exactId(knowledgeBaseId, 512)) invalid('ima_knowledge_scope_invalid');
  const input = normalize(evidence), expected = hash(knowledgeBaseId);
  const keys = citationKeys === undefined ? Object.keys(input.citations) : citationKeys;
  if (!Array.isArray(keys) || keys.length > MAX || !keys.every(safeKey)) invalid('ima_knowledge_citation_keys_invalid');
  if (!Array.isArray(catalogPages) || catalogPages.length > 20) invalid('ima_knowledge_catalog_invalid');
  const catalog = new Set(); let catalogScopeMismatch = false;
  for (const page of catalogPages) {
    if (!object(page) || !object(page.library) || !exactId(page.library.id, 512)
      || !Array.isArray(page.materials) || page.materials.length > 50
      || !page.materials.every(item => object(item) && exactId(item.materialId))) invalid('ima_knowledge_catalog_invalid');
    if (page.library.id !== knowledgeBaseId) catalogScopeMismatch = true;
    for (const item of page.materials) catalog.add(item.materialId);
  }
  const scopeStatus = !input.scopeRef ? 'unproved' : input.scopeRef === expected ? 'matched' : 'mismatch';
  const catalogStatus = catalogScopeMismatch ? 'scope_mismatch' : catalogPages.length ? 'matched' : 'not_supplied';
  const results = {};
  for (const key of [...new Set(keys)]) {
    const entry = input.citations[key], raw = evidence?.citations?.[key];
    const reject = status => { results[key] = { status, materialCandidates: [] }; };
    if (scopeStatus !== 'matched' || catalogScopeMismatch) { reject('scope_unproved'); continue; }
    if (!entry) { reject('missing'); continue; }
    if (entry.conflicted === true) { reject('conflicted'); continue; }
    if (entry.type === 'web') { reject('not_knowledge'); continue; }
    if (entry.type !== 'knowledge') { reject('type_unproved'); continue; }
    const refs = Array.isArray(raw?.sourceRefs) ? [...new Set(raw.sourceRefs)] : [];
    if (!refs.length || refs.length > 10 || refs.some(ref => typeof ref !== 'string'
      || !entry.sourceRefs.includes(ref) || !input.materials[ref])) { reject('identity_missing'); continue; }
    const candidates = []; let failure;
    for (const ref of refs) {
      const material = input.materials[ref], original = evidence?.materials?.[ref];
      if (!exactId(original?.materialId) || original.materialId !== material.materialId) { failure = 'identity_missing'; break; }
      if (material.conflicted === true) { failure = 'conflicted'; break; }
      if (own(original, 'knowledgeBaseId') && (!exactId(original.knowledgeBaseId, 512)
        || original.knowledgeBaseId !== knowledgeBaseId)) { failure = 'scope_unproved'; break; }
      candidates.push({ sourceRef: ref, materialId: material.materialId, idNamespace: material.idNamespace,
        identityEvidence: catalog.has(material.materialId) ? 'catalog_exact_match' : 'upstream_reference',
        scopeEvidence: material.knowledgeBaseId === knowledgeBaseId ? 'advertised_match' : 'request_bound',
        ...(material.title ? { title: material.title } : {}),
        ...(material.knowledgeBaseId ? { knowledgeBaseId: material.knowledgeBaseId } : {}) });
    }
    if (failure) { reject(failure); continue; }
    results[key] = { status: 'identified', materialCandidates: candidates };
  }
  return { schemaVersion: 1, scopeRef: expected, scopeStatus, catalogStatus, readAuthorization: 'not_evaluated', citations: results };
}
function agentSnapshot(value, knowledgeEvidence) {
  const evidence = normalize(knowledgeEvidence);
  return { ...value, knowledgeEvidence: evidence };
}

module.exports = { EVENT, MAX, empty, normalize, merge, delta, hasData, withDisplayNumbers, fromEvents,
  allowed, publicData, publicSnapshot, agentSnapshot, sourceRef, hash, identifyKnowledgeCitations, createAccumulator };
