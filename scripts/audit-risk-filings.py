#!/usr/bin/env python3
"""Independently replay Risk sources against original SEC inline-XBRL documents.

No application parser/calculator, network calls, credentials, or production writes.
Requires lxml. The manifest lists exact documents, including reviewed incorporated
financial exhibits and predecessor filings. Raw files are kept outside the repo.
Example: python scripts/audit-risk-filings.py --manifest MANIFEST.json \
  --capture-dir CAPTURES --filing-dir FILINGS --notes-dir NOTES --output LEDGER.json
Matching a fact does not establish complete accounting scope or risk coverage.
"""
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
from lxml import html


def local(tag):
    return str(tag).split(':')[-1].lower()


def cik(value):
    try:
        return str(int(value))
    except (TypeError, ValueError):
        return None


def namespace(node, prefix):
    return next((ancestor.get('xmlns:' + prefix) for ancestor in [node, *node.iterancestors()]
                 if ancestor.get('xmlns:' + prefix)), '')


def inspect(path, companion_paths=()):
    raw = path.read_bytes()
    tree = html.fromstring(raw)
    # A filing can be an inline-XBRL document set: Progressive's incorporated
    # financial exhibit shares contexts/units declared in its primary 10-K.
    # Resolve only companions explicitly listed in this same accession.
    resource_trees = [tree, *(html.fromstring(p.read_bytes()) for p in companion_paths if p != path)]
    contexts, units, facts = {}, {}, []
    for node in (node for resource in resource_trees for node in resource.iter()):
        if local(node.tag) == 'context':
            values = {local(e.tag): e.text for e in node.iter()
                      if local(e.tag) in ['startdate', 'enddate', 'instant', 'identifier']}
            values['dimensions'] = sorted((e.get('dimension'), ''.join(e.itertext()).strip())
                                          for e in node.iter() if local(e.tag) == 'explicitmember')
            values['typed'] = any(local(e.tag) == 'typedmember' for e in node.iter())
            key = node.get('id')
            contexts[key] = values if key not in contexts or contexts[key] == values else None
        elif local(node.tag) == 'unit':
            numerator, denominator = [], []
            for e in node.iter():
                if local(e.tag) != 'measure':
                    continue
                target = denominator if any(local(p.tag) == 'unitdenominator' for p in e.iterancestors()) else numerator
                target.append((e.text or '').split(':')[-1])
            key = node.get('id')
            value = '*'.join(numerator) + ('/' + '*'.join(denominator) if denominator else '')
            units[key] = value if key not in units or units[key] == value else None
    for node in tree.iter():
        if local(node.tag) != 'nonfraction':
            continue
        context = contexts.get(node.get('contextref')) or {}
        text = ''.join(node.itertext()).strip()
        try:
            value = Decimal('0' if 'fixed-zero' in node.get('format', '') else
                            text.replace(',', '').replace('$', '').replace(' ', '').replace('\xa0', '').replace('−', '-'))
            value *= Decimal(10) ** int(node.get('scale', '0'))
            value *= -1 if node.get('sign') == '-' else 1
        except (InvalidOperation, ValueError):
            continue
        prefix, _, tag = node.get('name', '').partition(':')
        ns = namespace(node, prefix)
        taxonomy = 'us-gaap' if 'fasb.org/us-gaap/' in ns else 'srt' if 'fasb.org/srt/' in ns else 'ifrs-full' if 'xbrl.ifrs.org/taxonomy/' in ns else None
        row = node
        while row is not None and local(row.tag) != 'tr':
            row = row.getparent()
        facts.append({'tag': tag, 'taxonomy': taxonomy, 'namespace': ns,
                      'value': float(value), 'unit': units.get(node.get('unitref')),
                      'start': context.get('startdate'), 'end': context.get('instant') or context.get('enddate'),
                      'entity': cik(context.get('identifier')), 'dimensions': context.get('dimensions', []),
                      'typed': context.get('typed'), 'factId': node.get('id'), 'contextId': node.get('contextref'),
                      'rowText': ' '.join(row.text_content().split())[:400] if row is not None else ''})
    return facts, hashlib.sha256(raw).hexdigest()


def sources(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'sources' and isinstance(item, list):
                yield from (source for source in item if source.get('tag') and source.get('accession'))
            else:
                yield from sources(item)
    elif isinstance(value, list):
        for item in value:
            yield from sources(item)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True, type=Path)
    p.add_argument('--capture-dir', required=True, type=Path)
    p.add_argument('--filing-dir', required=True, type=Path)
    p.add_argument('--notes-dir', type=Path)
    p.add_argument('--output', required=True, type=Path)
    args = p.parse_args()
    manifest = json.loads(args.manifest.read_text())
    result = {'method': 'Independent original-document amount, scale, sign, unit, dates, namespace, legal entity and note dimensions',
              'limitations': 'Selected supported source observations only. A numerical match does not prove complete financial scope, narrative coverage, economic comparability or every company/period.',
              'issuers': []}
    for issuer in manifest['issuers']:
        capture = args.capture_dir / issuer['captureName']
        if not capture.exists():
            continue
        data = json.loads(capture.read_text())
        unique = {tuple(source.get(k) for k in ['taxonomy', 'tag', 'accession', 'start', 'end', 'value', 'unit']): source
                  for source in sources({'annual': data['annual'], 'current': data['current']})}
        record = {'ticker': issuer['ticker'], 'cik': issuer['cik'], 'sic': issuer['sic'], 'version': data['version'],
                  'captureSha256': hashlib.sha256(capture.read_bytes()).hexdigest(), 'filings': []}
        for filing in issuer['filings']:
            inventory, documents = [], []
            for document in filing['documents']:
                facts, digest = inspect(args.filing_dir / document['fileName'],
                                        [args.filing_dir / d['fileName'] for d in filing['documents']])
                inventory += facts
                documents.append({**document, 'sha256': digest, 'originalFactCount': len(facts)})
            checks = []
            for source in unique.values():
                if source['accession'] != filing['accession']:
                    continue
                allowed = {cik(source.get('sourceCik') or issuer['cik'])}
                # Only the explicit reviewed joint-filer manifest grants this
                # exception; arbitrary co-registrants are never interchangeable.
                allowed |= {cik(value) for value in filing.get('additionalVerifiedFactCiks', [])}
                matches = [fact for fact in inventory if fact['tag'] == source['tag']
                           and fact['taxonomy'] == source.get('taxonomy', 'us-gaap') and not fact['dimensions'] and not fact['typed']
                           and fact['unit'] == source['unit'] and fact['start'] == source.get('start')
                           and fact['end'] == source['end'] and fact['value'] == source['value'] and fact['entity'] in allowed]
                checks.append({'tag': source['tag'], 'taxonomy': source.get('taxonomy'), 'value': source['value'],
                               'unit': source['unit'], 'start': source.get('start'), 'end': source['end'],
                               'sourceCik': source.get('sourceCik'), 'matched': bool(matches), 'originalFacts': matches[:2]})
            note_checks = []
            note_path = args.notes_dir / f'{issuer["ticker"]}-{filing["accession"]}.json' if args.notes_dir else None
            if note_path and note_path.exists():
                notes = json.loads(note_path.read_text())
                for row in notes['notes']['rows']:
                    dimensions = sorted((d['axis'], d['member']) for d in row['dimensions'])
                    for position in ['current', 'prior']:
                        point = row.get(position)
                        if not point:
                            continue
                        matches = [fact for fact in inventory if fact['taxonomy'] == 'us-gaap'
                                   and fact['tag'] == point['tag'].split(':')[-1] and fact['unit'] == row['unit']
                                   and fact['value'] == point['value'] and fact['start'] == point.get('start')
                                   and fact['end'] == point['end'] and fact['dimensions'] == dimensions
                                   and fact['entity'] == cik(notes['cik']) and fact['contextId'] == point['contextId']
                                   and (not point.get('factId') or fact['factId'] == point['factId'])]
                        note_checks.append({'kind': row['kind'], 'position': position, 'label': row['label'],
                                            'tag': point['tag'], 'value': point['value'], 'unit': row['unit'],
                                            'start': point.get('start'), 'end': point['end'], 'dimensions': dimensions,
                                            'matched': bool(matches), 'originalFacts': matches[:1]})
            record['filings'].append({k: v for k, v in filing.items() if k != 'documents'} | {'documents': documents, 'checks': checks, 'noteChecks': note_checks})
        result['issuers'].append(record)
        print(issuer['ticker'], sum(len(f['checks']) for f in record['filings']), sum(len(f['noteChecks']) for f in record['filings']), flush=True)
    filings = [f for issuer in result['issuers'] for f in issuer['filings']]
    checks = [c for f in filings for c in f['checks']]
    notes = [c for f in filings for c in f['noteChecks']]
    result['summary'] = {'issuers': len(result['issuers']), 'filings': len(filings), 'documents': sum(len(f['documents']) for f in filings),
                         'sourceChecks': len(checks), 'sourceMatches': sum(c['matched'] for c in checks),
                         'noteChecks': len(notes), 'noteMatches': sum(c['matched'] for c in notes)}
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(result['summary'])


if __name__ == '__main__':
    main()
