#!/usr/bin/env python3
"""Read-only reproducible BankScope audit. No credentials, preparation or database writes.

python scripts/audit-bankscope-accuracy.py --fetch --capture-dir /tmp/bankscope-audit \
  --output docs/audits/bankscope-2026-09-30.json

Without --fetch, replay the captured public responses. The independent mapping
below follows the June 2026 FFIEC 031/041/051 forms, not application imports.
"""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from urllib.parse import urlencode

BANKS = [493741, 946274, 2758613, 451965, 852218, 480228]
PERIOD = '2026-06-30'
SITE = 'https://secedgarterminal.com'
FDIC = 'https://api.fdic.gov/banks/financials'
FIELDS = ('CERT NAME RSSDID REPDTE ASSET LNLSGR LNRE LNCI LNCON DEP DEPDOM DEPNI DEPNIDOM BRO ROA ROE NIMY RBC1AAJ NCLNLSR NTLNLSR '
          'CBLRIND RBCT1CER RBC1RWAJ RBCRWAJ EQV LNATRESR LNATRES NCLNLS EEFFR NONIXR NONIIR CHBALR ASSTLTR SCMTGBKR SC '
          'ASSET5 EQ5 NETINC NETINCA NIM NIMA ERNAST5 LNLSGRJ LNLSGR5 NTLNLS NTLNLSA RBCT1 AVASSETJ RBC RWAJT EEFF IEFF NONIX NONII')
FDIC_URL = FDIC + '?' + urlencode({'filters': 'REPDTE:20260630 AND (' + ' OR '.join(f'RSSDID:{b}' for b in BANKS) + ')',
                                'fields': ','.join(FIELDS.split()), 'format': 'json', 'limit': '10'})
CORE = {
    'assets': '2170', 'cash': '0081 0071', 'securities': 'JJ34 1773 JA22', 'loans': '2122',
    'loans_hfi': 'B528', 'loans_hfs': '5369', 'liabilities': '2948', 'equity': 'G105', 'bank_equity': '3210',
    'past_due_30_89': '1406', 'past_due_90': '1407', 'nonaccrual': '1403', 'allowance': '3123',
    'fhlb_advances': 'F055 F056 F057 F058',
}
FLOWS = {'interest_income': '4107', 'interest_expense': '4073', 'net_interest_income': '4074', 'provision': 'JJ33',
         'noninterest_income': '4079', 'noninterest_expense': '4093', 'net_income': '4340', 'charge_offs': '4635', 'recoveries': '4605'}
CAPITAL = {'tier1': '8274', 'total_capital': '3792', 'rwa': 'A223', 'cet1_ratio': 'P793', 'tier1_ratio': '7206',
           'total_capital_ratio': '7205', 'leverage_ratio': '7204'}
RISK_BASED = {'total_capital', 'rwa', 'cet1_ratio', 'tier1_ratio', 'total_capital_ratio'}
CREDIT = {'construction': 'F158 F159', 'cre': '1460 F160 F161', 'residential': '1797 5367 5368',
          'consumer': 'B538 B539 K137 K207'}
QUALITY = {'construction': ['F172 F173', 'F174 F175', 'F176 F177'], 'cre': ['3499 F178 F179', '3500 F180 F181', '3501 F182 F183'],
           'residential': ['5398 C236 C238', '5399 C237 C239', '5400 C229 C230'],
           'consumer': ['B575 K213 K216', 'B576 K214 K217', 'B577 K215 K218']}
RATIO_FIELDS = {'roa': ('ROA', 'NETINCA', 'ASSET5'), 'nim': ('NIMY', 'NIMA', 'ERNAST5'),
                'chargeoffs': ('NTLNLSR', 'NTLNLSA', 'LNLSGR5'), 'noncurrent': ('NCLNLSR', 'NCLNLS', 'LNLSGRJ'),
                'leverage': ('RBC1AAJ', 'RBCT1', 'AVASSETJ'), 'totalCapital': ('RBCRWAJ', 'RBC', 'RWAJT'),
                'efficiency': ('EEFFR', 'EEFF', 'IEFF')}


def load(path):
    return json.loads(path.read_text())


def download(directory, name, url):
    subprocess.run(['curl', '-sSfL', '--max-time', '40', url, '-o', str(directory / name)], check=True)


class Source:
    def __init__(self, path, rssd, period, expected_hash):
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == expected_hash, f'Hash mismatch: {path}'
        assert b'<!DOCTYPE' not in raw and b'<!ENTITY' not in raw
        root = ET.fromstring(raw)
        ns = {'x': 'http://www.xbrl.org/2003/instance'}
        self.contexts = {}
        for c in root.findall('x:context', ns):
            identity = c.find('x:entity/x:identifier', ns)
            if identity is None or int(identity.text) != rssd or c.find('x:scenario', ns) is not None or c.find('x:entity/x:segment', ns) is not None:
                continue
            instant = c.find('x:period/x:instant', ns)
            end, start = c.find('x:period/x:endDate', ns), c.find('x:period/x:startDate', ns)
            if instant is not None and instant.text == period:
                self.contexts[c.attrib['id']] = 'instant'
            elif end is not None and start is not None and end.text == period and start.text == period[:4] + '-01-01':
                self.contexts[c.attrib['id']] = 'ytd'
        self.units = {u.attrib['id']: u.find('x:measure', ns).text.split(':')[-1] for u in root.findall('x:unit', ns)}
        self.items = {}
        for e in root:
            code, context = e.tag.split('}')[-1], e.attrib.get('contextRef')
            if context not in self.contexts:
                continue
            value = None if e.attrib.get('{http://www.w3.org/2001/XMLSchema-instance}nil') in ('true', '1') else e.text
            try:
                value = float(value)
            except (TypeError, ValueError):
                value = None
            self.items.setdefault(code, []).append({'value': value, 'rawValue': e.text,
                'unit': self.units.get(e.attrib.get('unitRef')), 'contextRef': context, 'period': self.contexts[context], 'decimals': e.attrib.get('decimals')})

    def fact(self, code, period='instant', unit='USD'):
        candidates = [f for f in self.items.get(code, []) if f['period'] == period and f['unit'] == unit]
        values = set(f['value'] for f in candidates)
        return candidates[0]['value'] if len(values) == 1 else None

    def balance(self, code):
        direct = self.fact(code)
        if direct is not None:
            return direct
        if code.endswith('JJ34'):
            a, b, c = self.fact(code, 'ytd'), self.fact(code[:4] + '1754'), self.fact('RIADJH93', 'ytd')
            if None not in (a, b, c) and abs(b - c - a) <= 1000:
                return a
        if code == 'RCONHK14':
            a = self.fact(code, 'ytd')
            b = [self.fact('RCON' + c) for c in ['HK12', 'HK13', 'HK15', 'J474']]
            if None not in [a, *b] and min([a, *b]) >= 0 and abs(b[3] - a - sum(b[:3])) <= 3000:
                return a
        return None


def total(source, codes, period='instant', percent=False):
    values = [source.fact(c, period, 'pure') if percent else source.fact(c, period) if period == 'ytd' else source.balance(c) for c in codes]
    return None if None in values else sum(values) * (100 if percent else 1)


def core_expected(source, form):
    prefix, cap = ('RCFD', 'RCFA') if form == '031' else ('RCON', 'RCOA')
    mapping = {k: [prefix + c for c in codes.split()] for k, codes in CORE.items()}
    mapping.update({k: ['RIAD' + c] for k, c in FLOWS.items()})
    mapping.update({k: [cap + c] for k, c in CAPITAL.items()})
    mapping.update({'domestic_deposits': ['RCON2200'], 'brokered_deposits': ['RCON2365'],
                    'deposits': ['RCON2200', 'RCFN2200'] if form == '031' else ['RCON2200'],
                    'foreign_deposits': ['RCFN2200'], 'cet1': ['RCFAP859', 'RCFWP859'] if form == '031' else ['RCOAP859']})
    elected = source.fact('RCOALE74', unit='nonMonetary') == 1 or source.fact('RCOALE74', unit='pure') == 1
    result = {}
    for key, codes in mapping.items():
        if key == 'cet1':
            candidates = [c for c in codes if source.fact(c) is not None]
            amount = source.fact(candidates[0]) if len(candidates) == 1 else None
        else:
            amount = total(source, codes, 'ytd' if key in FLOWS else 'instant', key.endswith('_ratio'))
        if elected and key in RISK_BASED or form != '031' and key == 'foreign_deposits':
            amount = None
        result[key] = {'codes': codes, 'expected': amount, 'unit': 'percent' if key.endswith('_ratio') else 'USD', 'period': 'ytd' if key in FLOWS else 'instant'}
    return result


def exposure_expected(source, form):
    prefix = 'RCFD' if form == '031' else 'RCON'
    mapping = {'loan_total': ['RCON2122']}
    segments = {**CREDIT, 'commercial': '1763 1764' if form == '031' else '1766'}
    quality = {**QUALITY, 'commercial': ['1251 1254', '1252 1255', '1253 1256'] if form == '031' else ['1606', '1607', '1608']}
    for key, codes in segments.items():
        mapping['loan_' + key] = ['RCON' + c for c in codes.split()]
        for status, codes in zip(['past30', 'past90', 'nonaccrual'], quality[key]):
            p = prefix if key in ('commercial', 'consumer') else 'RCON'
            mapping[key + '_' + status] = [p + c for c in codes.split()]
    for key, codes in {'deposits': '2200', 'transaction': '2215', 'mmda': '6810', 'savings': '0352', 'time_small': '6648 J473',
                       'time_large': 'J474', 'uninsured': '5597', 'brokered': '2365', 'noninterest': '6631'}.items():
        mapping[key] = ['RCON' + c for c in codes.split()]
    if form == '031':
        mapping['foreign_deposits'] = ['RCFN2200']
    for i in range(4):
        mapping[f'time_maturity_{i}'] = [f'RCONHK{7+i:02}', f'RCONHK{12+i}']
        mapping[f'fhlb_{i}'] = [f'{prefix}F0{55+i}']
    mapping['fhlb_total'] = [f'{prefix}F0{55+i}' for i in range(4)]
    for key, code in {'htm_cost': '1754', 'htm_fair': '1771', 'afs_cost': '1772', 'afs_fair': '1773',
                      'mbs_life_short': 'A561', 'mbs_life_long': 'A562'}.items():
        mapping[key] = [prefix + code]
    for i in range(6):
        mapping[f'securities_other_{i}'] = [f'{prefix}A{549+i}']
        mapping[f'securities_pass_{i}'] = [f'{prefix}A{555+i}']
    result = {k: {'codes': codes, 'expected': total(source, codes), 'unit': 'USD', 'period': 'instant'} for k, codes in mapping.items()}
    for name in ('htm', 'afs'):
        a, b = result[name + '_fair']['expected'], result[name + '_cost']['expected']
        result[name + '_gap'] = {'formula': 'fair value - amortized cost', 'codes': mapping[name + '_fair'] + mapping[name + '_cost'],
                               'expected': None if None in (a, b) else a - b, 'unit': 'USD', 'period': 'instant'}
    inputs = [result['loan_' + k]['expected'] for k in ['total', *segments]]
    amount = None if None in inputs else inputs[0] - sum(inputs[1:])
    result['loan_other'] = {'formula': 'total domestic loans - five named segments', 'codes': [c for k in ['total', *segments] for c in mapping['loan_' + k]],
                           'expected': amount if amount is None or amount >= 0 else None, 'unit': 'USD', 'period': 'instant'}
    return result


def compare(expected, actual):
    for key, row in expected.items():
        row['actual'] = actual.get(key)
        row['matches'] = row['expected'] == row['actual'] or (row['expected'] is not None and row['actual'] is not None and abs(row['expected'] - row['actual']) < 1e-9)
    return expected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-dir', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--fetch', action='store_true')
    args = parser.parse_args()
    directory = args.capture_dir
    directory.mkdir(parents=True, exist_ok=True)
    urls = {'live-banks.json': SITE + '/api/banks?rssds=493741,2758613,451965,946274',
            'live-large-banks.json': SITE + '/api/banks?rssds=852218,480228', 'fdic-audit.json': FDIC_URL}
    if args.fetch:
        for name, url in urls.items():
            download(directory, name, url)
    reports = load(directory / 'live-banks.json')['reports'] + load(directory / 'live-large-banks.json')['reports']
    for r in reports:
        urls[f"source-{r['id_rssd']}-{r['report_date']}.xml"] = SITE + '/api/banks/source?' + urlencode({'rssd': r['id_rssd'], 'period': r['report_date'], 'hash': r['source_sha256']})
    for rssd in BANKS:
        for kind in ('exposures', 'peers'):
            urls[f'live-{rssd}-{kind}.json'] = SITE + f'/api/banks/{kind}?rssd={rssd}&period={PERIOD}'
    if args.fetch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda item: download(directory, *item), [(k, v) for k, v in urls.items() if k not in ('live-banks.json', 'live-large-banks.json', 'fdic-audit.json')]))
    ledger = {'auditedAt': datetime.now(timezone.utc).isoformat(), 'method': 'Independent Python XML parser and explicit official-form mappings; retained XML hashes verified; public FDIC data independently compared',
              'officialDefinitions': 'https://api.fdic.gov/banks/docs/risview_properties.yaml', 'sources': urls, 'reports': [], 'fdic': []}
    for r in reports:
        rssd, date, form = r['id_rssd'], r['report_date'], r['form_type']
        source = Source(directory / f'source-{rssd}-{date}.xml', rssd, date, r['source_sha256'])
        exposure = next(x for x in load(directory / f'live-{rssd}-exposures.json')['reports'] if x['period'] == date)
        row = {'rssd': rssd, 'period': date, 'form': form, 'sourceSha256': r['source_sha256'], 'submission': r['submission_date_raw'],
               'formUrl': f'https://www.ffiec.gov/sites/default/files/data/reporting-forms/FFIEC{form}_202606_f.pdf',
               'core': compare(core_expected(source, form), {m['key']: m['value'] for m in r['metrics']}),
               'exposures': compare(exposure_expected(source, form), {k: m['value'] for k, m in exposure['values'].items()})}
        used = {c for group in ('core', 'exposures') for m in row[group].values() for c in m['codes']}
        used.update(['RCOALE74', 'RIADJH93', ('RCFA' if form == '031' else 'RCOA') + 'A224'])
        used.update(['RCON1420', 'RCON1590', 'RCON2107'])  # Explain community-bank residuals.
        row['facts'] = {c: source.items.get(c, []) for c in sorted(used)}
        ledger['reports'].append(row)
    for entry in load(directory / 'fdic-audit.json')['data']:
        raw = entry['data']
        rssd = raw['RSSDID']
        live = load(directory / f'live-{rssd}-peers.json')
        metrics = live['bank']['metrics']
        ratios = {}
        for key, (field, num, den) in RATIO_FIELDS.items():
            expected = raw[num] / raw[den] * 100 if raw.get(num) is not None and raw.get(den, 0) > 0 else None
            if key == 'totalCapital' and raw['CBLRIND'] == 1:
                expected = None
            ratios[key] = {'field': field, 'numerator': num, 'denominator': den, 'expected': expected, 'unit': 'percent', 'period': 'annualized_ytd' if key in ('roa', 'nim', 'chargeoffs') else 'reported'}
        ratios['noninterestDeposits'] = {'field': 'DEPNIDOM / DEPDOM * 100', 'numerator': 'DEPNIDOM', 'denominator': 'DEPDOM',
                                       'expected': raw['DEPNIDOM'] / raw['DEPDOM'] * 100, 'unit': 'percent', 'period': 'instant'}
        ledger['fdic'].append({'rssd': rssd, 'cert': raw['CERT'], 'name': raw['NAME'], 'period': PERIOD, 'rawUnit': 'USD thousands; ratios percent',
                              'sourceIndex': load(directory / 'fdic-audit.json')['meta']['index'], 'liveModel': live['snapshot']['model_version'],
                              'sourceSha256': hashlib.sha256((directory / 'fdic-audit.json').read_bytes()).hexdigest(),
                              'raw': raw, 'ratios': compare(ratios, metrics)})
    for group in ('core', 'exposures'):
        rows = [m for r in ledger['reports'] for m in r[group].values()]
        ledger[group + 'Comparisons'] = {'count': len(rows), 'matching': sum(m['matches'] for m in rows)}
    rows = [m for r in ledger['fdic'] for m in r['ratios'].values()]
    ledger['fdicComparisons'] = {'count': len(rows), 'matching': sum(m['matches'] for m in rows)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(ledger, indent=2) + '\n')
    print(json.dumps({k: v for k, v in ledger.items() if k.endswith('Comparisons')}))


if __name__ == '__main__':
    main()
