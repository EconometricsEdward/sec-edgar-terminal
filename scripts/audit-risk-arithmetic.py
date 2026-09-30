#!/usr/bin/env python3
import argparse,datetime,json,math,pathlib
parser=argparse.ArgumentParser(description="Independent arithmetic replay for captured Risk annual and TTM profiles; no network or application imports.")
parser.add_argument("--capture-dir",required=True,type=pathlib.Path)
parser.add_argument("--output",required=True,type=pathlib.Path)
args=parser.parse_args()
checks=[];issues=[]
def close(a,b):return a==b if a is None or b is None else math.isclose(a,b,rel_tol=1e-10,abs_tol=1e-9)
def ratio(a,b):return a/b if a is not None and b is not None and b>0 else None
for p in sorted(args.capture_dir.glob('*.json')):
 if p.stem.endswith('-annual'):continue
 d=json.loads(p.read_text())
 for basis in ['annual','current']:
  profile=d[basis];rows={**profile.get('reportedBalances',{}),**profile.get('reportedFlows',{})};metrics={m['id']:m for m in profile['metrics']}
  at=lambda k,end:next((v for v in rows.get(k,[]) if v['end']==end),{})
  for period in profile['periods']:
   end=period['end'];v=lambda k:at(k,end).get('value')
   rules={'liab_to_assets':ratio(v('totalLiabilities'),v('totalAssets')),
    'debt_to_equity':v('totalLiabilities')/v('equity') if v('equity') and v('totalLiabilities') is not None else None,
    'net_margin':ratio(v('netIncome'),v('revenue')),
    'interest_coverage':ratio(v('operatingIncome'),v('interestExpense')),
    'ocf_to_debt':ratio(v('operatingCashFlow'),v('totalDebt')),
    'net_debt':v('totalDebt')-v('cash') if v('totalDebt') is not None and v('cash') is not None else None,
    'current_ratio':ratio(v('currentAssets'),v('currentLiabilities')),
    'cash_to_assets':ratio(v('cash'),v('totalAssets')),
    'bank_equity_assets':ratio(v('equity'),v('totalAssets')),
    'bank_earnings_assets':ratio(v('netIncome'),v('totalAssets')),
    'bank_allowance_nonaccrual':ratio(v('allowance'),v('nonaccrualLoans')),
    'bank_cash_deposits':ratio(v('cash'),v('deposits')),
    'bank_cash_assets':ratio(v('cash'),v('totalAssets')),
    'nib_deposit_share':ratio(v('noninterestDeposits'),v('deposits')),
    'loans_deposits':ratio(v('loans'),v('deposits')),
    'reserve_coverage':ratio(v('allowance'),v('grossLoans')),
    'provision_rate':ratio(v('provision'),v('grossLoans')),
    'npl_ratio':ratio(v('nonaccrualLoans'),v('grossLoans')),
    'ins_equity_assets':ratio(v('equity'),v('totalAssets'))}
   for key,expected in rules.items():
    if key not in metrics:continue
    m=metrics[key];point=next((a for a in m['series'] if a['end']==end),{})
    actual=point.get('value');row={'ticker':d['ticker'],'basis':basis,'end':end,'metric':key,'expected':expected,'actual':actual,'matched':close(actual,expected)}
    checks.append(row)
    if not row['matched']:issues.append({**row,'issue':'arithmetic'})
   for key,row in rows.items():
    point=at(key,end)
    if point.get('value') is None:continue
    if not point.get('sources'):issues.append({'ticker':d['ticker'],'basis':basis,'end':end,'metric':key,'issue':'missing-evidence'})
    if key in profile.get('reportedFlows',{}):
     start=point.get('start')
     days=(datetime.date.fromisoformat(end)-datetime.date.fromisoformat(start)).days+1 if start else 0
     if not 300<=days<=400:issues.append({'ticker':d['ticker'],'basis':basis,'end':end,'start':start,'metric':key,'value':point['value'],'issue':'flow-duration','days':days})
    elif any(s.get('start') or s.get('end')!=end for s in point.get('sources',[])):
     issues.append({'ticker':d['ticker'],'basis':basis,'end':end,'metric':key,'issue':'balance-source-date'})
   for a,b in [('netIncome','revenue'),('operatingCashFlow','capitalExpenditure'),('operatingIncome','interestExpense')]:
    aa,bb=at(a,end),at(b,end)
    if aa.get('value') is not None and bb.get('value') is not None and aa.get('start')!=bb.get('start'):
     issues.append({'ticker':d['ticker'],'basis':basis,'end':end,'a':a,'b':b,'aStart':aa.get('start'),'bStart':bb.get('start'),'issue':'flow-scope-mismatch'})
result={'issuerCount':len(set(c['ticker'] for c in checks)),'checks':len(checks),'matched':sum(c['matched'] for c in checks),'issues':issues,'observations':checks}
args.output.write_text(json.dumps(result,indent=2)+'\n')
print({k:v for k,v in result.items() if k not in ['observations','issues']})
print('Issues:',len(issues))
