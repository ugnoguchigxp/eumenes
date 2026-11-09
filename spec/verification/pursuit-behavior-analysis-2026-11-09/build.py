"""Rebuild the analysis from retained evidence, without opening a product database."""
import csv
import hashlib
import json
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VER = ROOT.parent
PREV = VER / 'research-routing-performance-2026-11-08'
OLD = VER / 'web-research-markdown-2026-11-08/live'
JST = timezone(timedelta(hours=9))

def load(path):
    return json.loads(Path(path).read_text())

def ms(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    return round(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)

def stamp(value):
    return None if value is None else datetime.fromtimestamp(value / 1000, JST).isoformat(timespec='milliseconds')

def write(name, data):
    (ROOT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')

def model_stats(rows):
    return {'calls': len(rows), 'inputTokens': sum(r['inputTokens'] for r in rows),
            'cachedInputTokens': sum(r['cachedInputTokens'] for r in rows) if all(r['cachedInputTokens'] is not None for r in rows) else None,
            'outputTokens': sum(r['outputTokens'] for r in rows), 'milliseconds': sum(r['durationMs'] for r in rows)}

snapshot = load(ROOT / 'api-snapshot.json')
web_snapshot = load(ROOT / 'web-api-snapshot.json')
latest = load(PREV / 'live/measurements.json')['cases'][:2]
base_timing = load(PREV / 'baseline/timing-components.json')
base_totals = load(PREV / 'baseline/total-with-memory.json')['cases']
usage = load(PREV / 'baseline/usage-window.json')['rows'] + load(PREV / 'live/usage-window.json')['rows']
usage = {r['id']: r for r in usage}
cache = {r['id']: r for r in snapshot['cache']}
logs = []
log_sources = [ROOT / 'source-events.jsonl']
for source in log_sources:
    for line in source.read_text().splitlines():
        row = json.loads(line)
        row['_evidence'] = source.name
        logs.append(row)
job_by_id = {j['id']: j for j in snapshot['jobs']}
model_end = {l['attemptId']: l for l in logs if l.get('event') == 'pursuit.model_finished' and l.get('attemptId')}
inference_start = {l['attemptId']: l for l in logs if l.get('event') == 'inference.attempt_started' and l.get('attemptId')}
job_start = {l['jobId']: l for l in logs if l.get('event') == 'queue.execution_started' and l.get('jobId')}
job_end = {l['jobId']: l for l in logs if l.get('event') == 'queue.settled' and l.get('jobId')}
web_end = {l['jobId']: l for l in logs if l.get('event') in ['web.completed', 'web.failed'] and l.get('jobId')}
retained_web = {r['id']: r for c in load(PREV / 'live/web-acquisitions.json') for r in c['rows']}

configs = []
for i, (name, title) in enumerate([('case-a', '技術比較・前回完了'), ('case-b3', '博物館比較・前回完了')]):
    result = load(OLD / (name + '-result.json'))
    timing = base_timing[i]
    configs.append({'id': name, 'title': title, 'pursuitId': result['id'], 'conversationId': result['conversationId'],
                    'start': ms(result['notice']['createdAt']) - timing['wallMs'], 'end': ms(result['notice']['createdAt']),
                    'outcome': result['notice']['outcome'], 'ownedAttemptIds': base_totals[i]['attemptIds'],
                    'expectedPursuitCalls': timing['pursuit']['calls'], 'expectedPursuitInput': timing['pursuit']['inputTokens'],
                    'expectedPursuitOutput': timing['pursuit']['outputTokens'], 'expectedQueueWait': timing['queueWaitMs'],
                    'resultFile': str((OLD / (name + '-result.json')).relative_to(VER))})
for item, title in zip(latest, ['技術比較・再検証partial', '博物館比較・再検証partial']):
    configs.append({'id': item['caseId'], 'title': title, 'pursuitId': item['pursuitIds'][0], 'conversationId': item['conversationId'],
                    'start': ms(item['rootCreatedAt']), 'end': ms(item['noticeAt']), 'outcome': item['noticeOutcome'],
                    'ownedAttemptIds': item['attemptIds'], 'expectedPursuitCalls': item['pursuit']['calls'],
                    'expectedPursuitInput': item['pursuit']['inputTokens'], 'expectedPursuitOutput': item['pursuit']['outputTokens'],
                    'expectedQueueWait': item['queue']['totalWaitMs'],
                    'resultFile': str((PREV / 'live' / (item['caseId'] + '-result.json')).relative_to(VER))})

cases = []
all_events = []
relevant_log_ids = set()
for cfg in configs:
    pid = cfg['pursuitId']
    jobs = [j for j in snapshot['jobs'] if j['subjectRef'] == pid]
    job_ids = {j['id'] for j in jobs}
    owned = [usage[aid] for aid in cfg['ownedAttemptIds']]
    model = []
    for r in sorted(owned, key=lambda x: x['started']):
        if not r['subject'].startswith('pursuit:' + pid + '-'):
            continue
        c = cache.get(r['id'], {})
        endlog = model_end.get(r['id'], {})
        startlog = inference_start.get(r['id'], {})
        assert c.get('inputTokens', r['inputTokens']) == r['inputTokens']
        assert c.get('outputTokens', r['outputTokens']) == r['outputTokens']
        model.append({'attemptId': r['id'], 'requestId': r['requestId'], 'jobId': startlog.get('jobId', endlog.get('jobId')),
                      'startMs': r['started'], 'endMs': r['ended'], 'durationMs': r['ended'] - r['started'],
                      'purpose': endlog.get('purpose'), 'status': r['status'], 'inputTokens': r['inputTokens'],
                      'cachedInputTokens': c.get('cacheReadTokens'), 'outputTokens': r['outputTokens'],
                      'reasoningTokens': c.get('reasoningTokens'),
                      'purposeEvidence': endlog.get('_evidence'), 'evidence': 'retained_paginated_usage_and_usage_dashboard'})
    waits = []
    executions = []
    for j in jobs:
        start = job_start.get(j['id'])
        end = job_end.get(j['id'])
        if start:
            a, b = ms(j['createdAt']), ms(start['time'])
            assert b >= a
            waits.append({'jobId': j['id'], 'startMs': a, 'endMs': b, 'durationMs': b-a, 'evidence': 'public_job_createdAt_and_queue.execution_started'})
            if end:
                executions.append({'jobId': j['id'], 'startMs': b, 'endMs': ms(end['time']), 'durationMs': end.get('durationMs'), 'status': end.get('status')})
    web = []
    for row in web_snapshot['rows']:
        j = row['job']
        if j['parentJobId'] not in job_ids:
            continue
        w = retained_web.get(j['subjectRef'], row['run'])
        event = web_end.get(j['id'], {})
        started = job_start.get(j['id'], {})
        ended = job_end.get(j['id'], {})
        operation = w.get('operation', event.get('kind'))
        duration = ended.get('durationMs')
        start, end = ms(j['createdAt']), ms(j.get('finishedAt'))
        associated = [r for r in model if r['jobId'] == j['parentJobId'] and r['endMs'] <= start + 25]
        last_model = max(associated, key=lambda x: x['endMs']) if associated else None
        wrow = {'jobId': j['id'], 'runId': j['subjectRef'], 'parentJobId': j['parentJobId'], 'operation': operation,
                'startMs': start, 'endMs': end, 'durationMs': duration,
                'executionStartMs': ms(started.get('time')), 'status': w.get('status', j['state']),
                'errorCode': w.get('errorCode', event.get('reason', j.get('errorCode'))),
                'query': None, 'queryCoverage': 'not_exposed_by_public_API_or_operational_logs',
                'documents': w.get('documents'), 'hits': w.get('hits'),
                'documentCount': len(w['documents']) if 'documents' in w else event.get('documentCount'),
                'hitCount': len(w['hits']) if 'hits' in w else event.get('hitCount'),
                'resultDetailAvailable': 'documents' in w,
                'precedingModelAttemptId': last_model['attemptId'] if last_model else None,
                'precedingModelPurpose': last_model['purpose'] if last_model else None,
                'evidence': 'public_web_job_and_saved_run_snapshot_or_web.completed_log'}
        web.append(wrow)
    web.sort(key=lambda r: r['startMs'])
    for i, row in enumerate(web):
        previous = web[i-1]['endMs'] if i else cfg['start']
        row['gapBeforeMs'] = max(0, row['startMs'] - previous)
        row['modelCallsInGap'] = sum(r['startMs'] >= previous and r['endMs'] <= row['startMs'] for r in model)
        row['modelMsInGap'] = sum(max(0, min(r['endMs'], row['startMs'])-max(r['startMs'], previous)) for r in model)
        row['queueWaitMsInGap'] = sum(max(0, min(r['endMs'], row['startMs'])-max(r['startMs'], previous)) for r in waits)
    phases = []
    for purpose in dict.fromkeys(r['purpose'] for r in model):
        subset = [r for r in model if r['purpose'] == purpose]
        phases.append({'purpose': purpose, **model_stats(subset)})
    overlap = [(a['jobId'], b['jobId']) for i,a in enumerate(web) for b in web[i+1:] if a['endMs'] and b['endMs'] and min(a['endMs'], b['endMs']) > max(a['startMs'], b['startMs'])]
    wait_sum = sum(r['durationMs'] for r in waits)
    assert len(model) == cfg['expectedPursuitCalls']
    assert sum(r['inputTokens'] for r in model) == cfg['expectedPursuitInput']
    assert sum(r['outputTokens'] for r in model) == cfg['expectedPursuitOutput']
    assert wait_sum == cfg['expectedQueueWait'], (cfg['id'], wait_sum, cfg['expectedQueueWait'])
    assert len({r['attemptId'] for r in model}) == len(model)
    total_cache = [cache.get(r['id']) for r in owned]
    assert all(c is not None for c in total_cache)
    total = {'calls': len(owned), 'inputTokens': sum(r['inputTokens'] for r in owned), 'outputTokens': sum(r['outputTokens'] for r in owned),
             'cachedInputTokens': sum(c['cacheReadTokens'] for c in total_cache), 'cacheUnknownCalls': sum(c['cacheReadTokens'] is None for c in total_cache)}
    last_web = max(r['endMs'] for r in web) if web else None
    after = [r for r in model if last_web is not None and r['startMs'] >= last_web]
    post_web = None if last_web is None else {'lastWebElapsedMs': last_web-cfg['start'], 'remainingWallMs':cfg['end']-last_web, 'modelCalls':len(after), 'modelMs':sum(r['durationMs'] for r in after), 'queueWaitMs':sum(max(0,min(w['endMs'],cfg['end'])-max(w['startMs'],last_web)) for w in waits)}
    saves = []
    result_data = load(VER / cfg['resultFile'])
    doc_link = next((l for l in result_data['notice']['links'] if l['kind']=='scratch'), None)
    if cfg['id'] in ['case-a','case-b3']:
        candidates = load(OLD / (cfg['id']+'-jobs.json'))['markdown']['items']
        save_id = doc_link['uri'].rsplit('/',1)[-1] if doc_link else None
        candidates = [j for j in candidates if j['subjectRef']==save_id]
    else:
        candidates = next(x['saveJobs'] for x in latest if x['caseId']==cfg['id'])
    for j in candidates:
        startlog, endlog = job_start.get(j['id'],{}), job_end.get(j['id'],{})
        saves.append({'jobId':j['id'],'startMs':ms(j['createdAt']),'endMs':ms(endlog.get('time',j.get('finishedAt',j.get('updatedAt')))), 'durationMs':endlog.get('durationMs',j.get('executionMs')), 'operation':'markdown.generated','status':j['state'],'evidence':'public_markdown_job_and_queue.settled'})
    metrics = {'documentSaveMs':sum(r['durationMs'] for r in saves),'afterLastWeb':post_web, 'wallMs': cfg['end']-cfg['start'], 'pursuit': model_stats(model), 'recordedTotalIncludingMemory': total,
               'queueWaitMs': wait_sum, 'queueStartedJobs': len(waits), 'queueUnknownStartedJobs': sum(j['attempt'] > 0 and j['id'] not in job_start for j in jobs),
               'webCalls': len(web), 'searchCalls': sum(r['operation']=='lookup' for r in web), 'readCalls': sum(r['operation']=='read' for r in web),
               'webExecutionMs': sum(r['durationMs'] or 0 for r in web), 'webUnknownExecutionDurations': sum(r['durationMs'] is None for r in web),
               'webOverlappingPairs': overlap, 'firstWebAfterStartMs': web[0]['startMs']-cfg['start'] if web else None,
               'modelPurposeUnknownCalls': sum(r['purpose'] is None for r in model), 'phases': phases}
    case = {**cfg, 'startJst': stamp(cfg['start']), 'endJst': stamp(cfg['end']), 'metrics': metrics, 'modelCalls': model,
            'webOperations': web, 'documentSaves':saves, 'queueWaits': waits, 'jobExecutions': executions,
            'coverage': {'searchQueryText': 'unavailable', 'localToolActions': 'unavailable', 'draftUpdateHistory': 'unavailable',
                         'modelPromptsOrHiddenReasoning': 'not_exported', 'fullCoreLedger': 'not_read; no existing public export route'}}
    cases.append(case)
    for kind, rows in [('model', model), ('web', web), ('queue_wait', waits), ('document_save',saves)]:
        for r in rows:
            e = {'case_id': cfg['id'], 'case_title': cfg['title'], 'outcome': cfg['outcome'], 'kind': kind,
                 'start_jst': stamp(r['startMs']), 'end_jst': stamp(r['endMs']),
                 'elapsed_start_s': round((r['startMs']-cfg['start'])/1000,3), 'elapsed_end_s': round((r['endMs']-cfg['start'])/1000,3),
                 'duration_ms': r['durationMs'], 'phase': r.get('purpose'), 'operation': r.get('operation'), 'status': r.get('status'),
                 'input_tokens_total': r.get('inputTokens'), 'input_tokens_cached': r.get('cachedInputTokens'),
                 'input_tokens_uncached':r['inputTokens']-r['cachedInputTokens'] if r.get('inputTokens') is not None and r.get('cachedInputTokens') is not None else None,
                 'output_tokens': r.get('outputTokens'), 'reasoning_tokens': r.get('reasoningTokens'),
                 'job_id': r.get('jobId'), 'parent_job_id': r.get('parentJobId'), 'attempt_id': r.get('attemptId'),
                 'request_id': r.get('requestId'), 'web_run_id': r.get('runId'), 'error_code': r.get('errorCode'),
                 'query': None, 'urls': ' | '.join(d['url'] for d in (r.get('documents') or [])),
                 'candidate_urls': ' | '.join(h['url'] for h in (r.get('hits') or [])),
                 'hits': r.get('hitCount'), 'documents': r.get('documentCount'), 'evidence': r['evidence']}
            all_events.append(e)
            relevant_log_ids.update(v for k,v in e.items() if k.endswith('_id') and v)

all_events.sort(key=lambda r: (r['case_id'], r['elapsed_start_s'], r['kind'], r['job_id'] or ''))
for cfg in configs:
    seq = 0
    for r in all_events:
        if r['case_id'] == cfg['id']:
            seq += 1
            r['event_seq'] = seq
fields = ['case_id','case_title','outcome','event_seq','kind','start_jst','end_jst','elapsed_start_s','elapsed_end_s','duration_ms','phase','operation','status','input_tokens_total','input_tokens_cached','input_tokens_uncached','output_tokens','reasoning_tokens','job_id','parent_job_id','attempt_id','request_id','web_run_id','error_code','query','urls','candidate_urls','hits','documents','evidence']
with (ROOT / 'timeline.csv').open('w',newline='',encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=fields);w.writeheader();w.writerows(all_events)
web_csv = []
for c in cases:
    for i,r in enumerate(c['webOperations'],1):
        web_csv.append({'case_id': c['id'],'order': i,'start_jst': stamp(r['startMs']), 'elapsed_start_s': round((r['startMs']-c['start'])/1000,3),
                        'operation':r['operation'],'duration_ms':r['durationMs'],'status':r['status'],'error_code':r['errorCode'],
                        'query':None,'urls':' | '.join(d['url'] for d in (r.get('documents') or [])),
                        'candidate_urls':' | '.join(h['url'] for h in (r.get('hits') or [])),
                        'hits':r.get('hitCount'),'documents':r.get('documentCount'),'gap_before_s':round(r['gapBeforeMs']/1000,3),
                        'model_calls_in_gap':r['modelCallsInGap'],'model_s_in_gap':round(r['modelMsInGap']/1000,3),
                        'queue_wait_s_in_gap':round(r['queueWaitMsInGap']/1000,3),'job_id':r['jobId'],'parent_job_id':r['parentJobId']})
with (ROOT / 'web-operations.csv').open('w',newline='',encoding='utf-8-sig') as f:
    w = csv.DictWriter(f,fieldnames=list(web_csv[0]));w.writeheader();w.writerows(web_csv)
write('analysis-data.json', {'schemaVersion':1,'analysisDate':'2026-11-09','timezone':'Asia/Tokyo',
    'note':'Actions and counters only; no raw model prompts/responses or hidden reasoning. Per-layer durations overlap; do not sum all categories as wall time. Null means unavailable, not zero.', 'cases':cases})
allowed = {'level','time','component','event','runId','jobId','attemptId','inferenceId','subjectId','purpose','kind','status','reason','durationMs','promptTokens','completionTokens','hitCount','documentCount','failureCount','phase','outcome'}
relevant = []
for l in logs:
    if any(l.get(k) in relevant_log_ids for k in ['runId','jobId','attemptId','inferenceId']):
        relevant.append({k:v for k,v in l.items() if k in allowed})
(ROOT / 'correlated-events.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in relevant))
assert all(ms(r['end_jst']) >= ms(r['start_jst']) and r['duration_ms'] >= 0 for r in all_events)
assert len({r['attempt_id'] for r in all_events if r['kind']=='model'}) == sum(len(c['modelCalls']) for c in cases)
assert sum(c['metrics']['recordedTotalIncludingMemory']['calls'] for c in cases) == 156
write('validation.json', {'status':'passed','cases':4,'timelineRows':len(all_events),'webRows':len(web_csv),'modelRows':sum(len(c['modelCalls']) for c in cases),
       'checks':['exact attempt counts and input/output equal retained all-page metrics','cache input/output equal the same attempt IDs','all known queue waits equal earlier measurements','no duplicate model attempt IDs','all time intervals nonnegative','public data and retained logs only; no product database reads'],
       'limitations':['local action names/arguments and exact search queries are not available from current public APIs','baseline model purposes were not logged in that server version'],
       'inputHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in log_sources+[ROOT/'api-snapshot.json',ROOT/'web-api-snapshot.json',PREV/'live/measurements.json',PREV/'live/web-acquisitions.json']}})
print(json.dumps([{'case':c['id'],'metrics':c['metrics']} for c in cases],ensure_ascii=False,indent=2))
