'use strict';

// An optional public view. Raw operational records remain available to existing
// internal consumers; never derive a citation from a source's array position.
const PHASES = Object.freeze({ knowledge: '资料检索', web: '联网搜索', answer: '回答生成' });
const { createHash } = require('node:crypto');
const sourceId = url => createHash('sha256').update(webUrl(url)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
const validKey = key => /^(index|context|ref|para):[^\s?&#\u0000-\u001f\u007f]{1,128}$/u.test(key);

function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || /(^|\.)(ima\.qq\.com|ima\.tencent\.com)$/iu.test(url.hostname)
      || [...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
        .some(key => /token|cookie|credential|secret|password|authorization|api[_-]?key|signature/iu.test(key))) return '';
    return url.href;
  } catch { return ''; }
}

function citationMap(value) {
  const result = {};
  if (!object(value)) return result;
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (!validKey(key) || !object(entry)) continue;
    const type = entry.conflicted === true ? 'unknown'
      : ['knowledge', 'web', 'unknown'].includes(entry.type) ? entry.type : 'unknown';
    result[key] = { type, ...(typeof entry.conflicted === 'boolean' ? { conflicted: entry.conflicted } : {}) };
    if (Array.isArray(entry.displayNumbers)) result[key].displayNumbers = [...new Set(entry.displayNumbers
      .filter(n => typeof n === 'string' && /^\d{1,6}$/u.test(n)))].slice(0, 100);
    if (type === 'web') {
      result[key].sources = (Array.isArray(entry.sources) ? entry.sources : []).slice(0, 10)
        .flatMap(source => {
          const url = webUrl(source?.url);
          return url ? [{ url, title: text(source.title, 512), snippet: text(source.snippet, 5000) }] : [];
        });
    }
  }
  return result;
}

function mergeCitations(previous, incoming) {
  const result = citationMap(previous);
  for (const [key, entry] of Object.entries(citationMap(incoming))) {
    const old = result[key];
    if (!old && Object.keys(result).length >= 100) continue;
    const displayNumbers = [...new Set([...(old?.displayNumbers || []), ...(entry.displayNumbers || [])])].slice(0, 100);
    if (old?.conflicted || entry.conflicted === true) {
      result[key] = { type: 'unknown', conflicted: true, displayNumbers }; continue;
    }
    // Conflicting provenance cannot authorize a web card.
    if (old && old.type !== entry.type && old.type !== 'unknown' && entry.type !== 'unknown') {
      result[key] = { type: 'unknown', conflicted: true, displayNumbers }; continue;
    }
    if (entry.type === 'unknown' && old) {
      // Unknown provenance cannot replace proved sources. A later done may
      // still add explicit numbers for this exact key, including old unknowns.
      result[key] = { ...old, ...(entry.conflicted === false ? { conflicted: false } : {}), displayNumbers }; continue;
    }
    const sources = new Map((old?.sources || []).map(source => [source.url, source]));
    for (const source of entry.sources || []) {
      const before = sources.get(source.url) || {};
      sources.set(source.url, { url: source.url, title: source.title || before.title || '',
        snippet: source.snippet || before.snippet || '' });
    }
    result[key] = { ...entry, ...(old?.conflicted === false && entry.conflicted === undefined ? { conflicted: false } : {}),
      ...(entry.type === 'web' ? { sources: [...sources.values()].slice(0, 10) } : {}),
      displayNumbers };
  }
  return result;
}

function suggestions(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value.slice(0, 100)) {
    // IMA SUGGEST_QUESTION carries objects with text/Text. Discard all tool and
    // knowledge-base metadata, including when text is absent or invalid.
    const raw = typeof item === 'string' ? item : item?.text ?? item?.Text;
    if (typeof raw !== 'string' || raw.length > 2000) continue;
    const question = text(raw, 2000);
    if (question && !result.includes(question)) result.push(question);
    if (result.length === 3) break;
  }
  return result;
}

function processStep(value) {
  if (!object(value) || !Object.hasOwn(PHASES, value.phase)
    || !['running', 'completed', 'failed', 'cancelled'].includes(value.status)) return null;
  return { stepId: `chat:${value.phase}`, phase: value.phase, status: value.status, label: PHASES[value.phase] };
}

function metadata(value = {}) {
  return { ...(Object.hasOwn(value, 'citationMap') ? { citationMap: citationMap(value.citationMap) } : {}),
    ...(Object.hasOwn(value, 'suggestions') ? { suggestions: suggestions(value.suggestions) } : {}),
    ...(Object.hasOwn(value, 'process') ? { process: (Array.isArray(value.process) ? value.process : [])
      .map(processStep).filter(Boolean).slice(-40) } : {}) };
}

function scanAnswerReferences(answer) {
  // Only explicit native Markdown targets can link a displayed number to a
  // key. A missing source is retained as a gap, never filled from sources[N].
  let fence = null;
  const visible = String(answer || '').split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return /^(?: {4}|\t)/u.test(line) ? '' : line;
  }).join('\n')
    .replace(/(`+)[\s\S]*?\1(?!`)/gu, ' ')
    .replace(/(?<!\\)(\${1,2})[\s\S]*?(?<!\\)\1/gu, ' ');
  const references = new Map(); let truncated = false;
  for (const match of visible.matchAll(/(?<!\\)\[(\d{1,6}(?:\s*,\s*\d{1,6})*)\]\(@(context|index)-ref\?([^\s)]+)\)/gu)) {
    if (/%(?![a-f\d]{2})/iu.test(match[3])) continue;
    const query = new URLSearchParams(match[3]);
    if (query.getAll('id').length !== 1) continue;
    const key = `${match[2]}:${query.get('id')}`;
    if (!validKey(key)) continue;
    if (!references.has(key) && references.size >= 100) { truncated = true; continue; }
    const numbers = new Set(references.get(key) || []);
    // Do not split an arbitrarily long label into a temporary array before
    // enforcing the bound. Retain at most 100 distinct display numbers.
    for (const token of match[1].matchAll(/\d{1,6}/gu)) {
      if (!numbers.has(token[0]) && numbers.size === 100) { truncated = true; break; }
      numbers.add(token[0]);
    }
    references.set(key, [...numbers]);
  }
  return { references: [...references].map(([citationKey, displayNumbers]) => ({ citationKey, displayNumbers })), truncated };
}
const answerReferences = answer => scanAnswerReferences(answer).references;

function withDisplayNumbers(map, answer) {
  const result = citationMap(map);
  for (const { citationKey, displayNumbers } of answerReferences(answer)) {
    const entry = result[citationKey];
    if (entry) entry.displayNumbers = [...new Set([...(entry.displayNumbers || []), ...displayNumbers])].slice(0, 100);
  }
  return result;
}

function citationDetails(map, answer) {
  const entries = citationMap(map);
  const { references, truncated } = scanAnswerReferences(answer);
  return { citationReferencesTruncated: truncated, citationReferences: references.map(reference => {
    const entry = entries[reference.citationKey], type = entry?.type || 'unknown';
    const resolution = !entry ? 'missing_metadata' : entry.conflicted ? 'conflicted'
      : type === 'unknown' ? 'unknown' : type === 'knowledge' ? 'knowledge_typed'
      : entry.sources?.length ? 'web_linked' : 'missing_source';
    return { ...reference, type, resolution,
      ...(type === 'web' ? { sources: entry.sources || [] } : {}) };
  }) };
}
const citationReferences = (map, answer) => citationDetails(map, answer).citationReferences;

function projectData(name, data = {}) {
  if (name === 'knowledge_evidence') return null;
  if (name === 'sources') return { citationMap: presentationCitations(data.citationMap),
    sourceCount: Number.isSafeInteger(data.sources?.length) ? data.sources.length : Number(data.sourceCount) || 0 };
  if (name === 'process') return processStep(data) || {};
  if (name === 'suggestions') return { suggestions: suggestions(data.suggestions) };
  if (name === 'done') {
    const { searchSummary, sources, ...rest } = data;
    const result = {};
    for (const key of ['conversationId', 'requestId', 'source_intent', 'answer_basis', 'source_count',
      'knowledge_source_count', 'web_source_count', 'sourceIntent', 'answerBasis', 'sourceCount',
      'knowledgeSourceCount', 'webSourceCount', 'complete', 'interrupted']) {
      if (Object.hasOwn(rest, key)) result[key] = rest[key];
    }
    if (object(rest.timing)) result.timing = { elapsed_ms: Number(rest.timing.elapsed_ms) || 0, queue_wait_ms: Number(rest.timing.queue_wait_ms) || 0 };
    return { ...result, ...presentationMetadata(rest) };
  }
  return data;
}

function projectSnapshot(value) {
  return { ...value, snapshot: value.snapshot ? { ...value.snapshot,
    events: (value.snapshot.events || []).filter(event => event.event !== 'knowledge_evidence')
      .map(event => ({ ...event, data: projectData(event.event, event.data) })) } : value.snapshot };
}

function projectHistory(value) {
  return { ...value, messages: (value.messages || []).map(message => {
    if (message.role !== 'assistant') return message;
    const { sources, searchSummary, knowledgeEvidence, ...rest } = message;
    return { ...rest, ...presentationMetadata(message), sourceCount: sources?.length || message.sourceCount || 0 };
  }) };
}
function presentationCitations(value) {
  const map = citationMap(value);
  for (const entry of Object.values(map)) if (entry.type === 'web') {
    entry.sources = entry.sources.map(source => ({ ...source, sourceId: sourceId(source.url) }));
  }
  return map;
}
function presentationMetadata(value) {
  return { ...metadata(value), ...(Object.hasOwn(value, 'citationMap') ? { citationMap: presentationCitations(value.citationMap) } : {}) };
}

module.exports = { PHASES, webUrl, citationMap, mergeCitations, suggestions, processStep, metadata,
  withDisplayNumbers, answerReferences, citationReferences, citationDetails, projectData, projectSnapshot, projectHistory, sourceId, presentationCitations };
