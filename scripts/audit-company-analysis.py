#!/usr/bin/env python3
"""Independent original-filing replay for captured Company Analysis responses.

Requires Python lxml. Uses no application parser/calculator, credentials or writes
outside --output. Prepare captures named <ticker>-<basis>-live.json and matching
< ticker >-< annual|quarter >-filing.htm from the exact source URL in the payload.
Run: python3 scripts/audit-company-analysis.py --capture-dir /tmp/analysis-audit \
  --output docs/audits/company-original-filings-2026-09-30.json

This checks latest reported values, not every historical/derived amount, and does
not certify that a matching taxonomy tag has the correct economic scope.
"""
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
from lxml import html


def local(tag):
    return str(tag).split(':')[-1].lower()


def normalized_cik(value):
    try:
        return str(int(value))
    except (ValueError, TypeError):
        return None


def inspect_document(path):
    raw = path.read_bytes()
    tree = html.fromstring(raw)
    contexts, units, inventory = {}, {}, []
    for node in tree.iter():
        if local(node.tag) == 'context':
            values = {local(e.tag): e.text for e in node.iter()
                      if local(e.tag) in ['startdate', 'enddate', 'instant', 'identifier']}
            values['dimensional'] = any(local(e.tag) in ['explicitmember', 'typedmember'] for e in node.iter())
            contexts[node.get('id')] = values
        elif local(node.tag) == 'unit':
            numerator, denominator = [], []
            for e in node.iter():
                if local(e.tag) != 'measure':
                    continue
                value = (e.text or '').split(':')[-1]
                target = denominator if any(local(p.tag) == 'unitdenominator' for p in e.iterancestors()) else numerator
                target.append(value)
            units[node.get('id')] = '*'.join(numerator) + ('/' + '*'.join(denominator) if denominator else '')
    for node in tree.iter():
        if local(node.tag) != 'nonfraction':
            continue
        attrs = node.attrib
        context = contexts.get(attrs.get('contextref'), {})
        text = ''.join(node.itertext()).strip()
        try:
            value = Decimal('0' if 'fixed-zero' in attrs.get('format', '') else
                            text.replace(',', '').replace('$', '').replace(' ', '').replace('\xa0', '').replace('−', '-'))
            value *= Decimal(10) ** int(attrs.get('scale', '0'))
            value *= -1 if attrs.get('sign') == '-' else 1
        except (InvalidOperation, ValueError):
            continue
        row = node
        while row is not None and local(row.tag) != 'tr':
            row = row.getparent()
        prefix, _, tag = attrs.get('name', '').partition(':')
        namespace = next((p.get('xmlns:' + prefix) for p in [node, *node.iterancestors()]
                          if p.get('xmlns:' + prefix)), None)
        standard = bool(namespace and ('fasb.org/us-gaap/' in namespace or 'xbrl.ifrs.org/taxonomy/' in namespace))
        inventory.append({'tag': tag, 'standardNamespace': standard, 'unit': units.get(attrs.get('unitref')),
                          'value': float(value), 'start': context.get('startdate'),
                          'end': context.get('instant') or context.get('enddate'),
                          'entity': context.get('identifier'), 'dimensional': context.get('dimensional'),
                          'factId': attrs.get('id'), 'contextId': attrs.get('contextref'),
                          'rowText': ' '.join(row.text_content().split())[:500] if row is not None else ''})
    declared_ciks = {normalized_cik("".join(node.itertext())) for node in tree.iter()
                     if local(node.tag) == 'nonnumeric' and node.get('name', '').endswith(':EntityCentralIndexKey')}
    return inventory, hashlib.sha256(raw).hexdigest(), declared_ciks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-dir', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    reports = []
    for path in sorted(args.capture_dir.glob('*-live.json')):
        if not any(path.name.endswith('-' + basis + '-live.json') for basis in ['annual', 'quarter']):
            continue
        document = path.with_name(path.name.replace('-live.json', '-filing.htm'))
        if not document.exists():
            continue
        live = json.loads(path.read_text())
        if not live.get('periods'):
            continue
        period = live['periods'][0]
        inventory, digest, declared_ciks = inspect_document(document)
        checks = []
        for key, points in live['metrics'].items():
            point = points[0]
            if point.get('classification') != 'reported':
                continue
            sources = [live['sourceCatalog'][i] for i in point.get('sourceIds', [])] if live.get('packed') else point.get('sources', [])
            for source in sources:
                if source.get('accession') != period['accession']:
                    continue
                cik = normalized_cik(source.get('sourceCik') or live['cik'])
                # A verified pre-transition combined filing can declare both
                # the current issuer and predecessor. Keep the original XBRL
                # entity explicit rather than silently renaming its contexts.
                continuity = live.get('sourceCoverage', {}).get('continuity', {})
                predecessor_ciks = {normalized_cik(value) for value in continuity.get('predecessorCiks', [])}
                allowed_ciks = {cik}
                if continuity.get('status') == 'applied' and source['end'] < continuity.get('effectiveDate', '') and cik in declared_ciks:
                    allowed_ciks |= predecessor_ciks & declared_ciks
                matches = [fact for fact in inventory if fact['standardNamespace'] and not fact['dimensional']
                           and fact['tag'] == source['tag'] and fact['start'] == source.get('start')
                           and fact['end'] == source['end'] and fact['unit'] == source['unit']
                           and fact['value'] == source['value'] == point['value']
                           and normalized_cik(fact['entity']) in allowed_ciks]
                checks.append({'metric': key, 'value': point['value'], 'tag': source['tag'],
                               'start': source.get('start'), 'end': source['end'], 'unit': source['unit'],
                               'sourceCik': cik, 'url': source['documentUrl'], 'matched': bool(matches),
                               'predecessorEntityContext': bool(matches) and all(normalized_cik(fact['entity']) != cik for fact in matches), 'facts': matches[:3]})
        reports.append({'ticker': live['ticker'], 'basis': live['basis'], 'period': period,
                        'sourceFile': document.name, 'sourceSha256': digest, 'checks': checks})
    all_checks = [check for report in reports for check in report['checks']]
    result = {'method': 'Independent inline-XBRL amount, sign, scale, unit, context, standard namespace and entity verification',
              'baseline': 'Captured pre-remediation production responses, 2026-09-30',
              'limitations': 'Latest reported facts cited to inspected primary accession only; matching a tag does not establish appropriate financial scope; derived formulas and historical observations are outside this count.',
              'predecessorEntityContexts': sum(check['predecessorEntityContext'] for check in all_checks),
              'files': len(reports), 'checked': len(all_checks), 'matched': sum(check['matched'] for check in all_checks), 'reports': reports}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print({key: result[key] for key in ['files', 'checked', 'matched']})
    for report in reports:
        for check in report['checks']:
            if not check['matched']:
                print('UNMATCHED', report['ticker'], report['basis'], check['metric'], check['value'])


if __name__ == '__main__':
    main()
