-- Read-only, independent PostgreSQL XML/XPath cross-check of retained FFIEC sources.
-- Run as database owner; this uses no FFIEC requests and no application parser.
with codes(metric_name,item_code) as (
 values ('assets','RCFD2170'),('loans','RCFD2122'),('equity','RCFDG105'),
 ('net_income','RIAD4340'),('tier1','RCFA8274'),('nonaccrual','RCFD1403')
), direct as (
 select r.id_rssd,r.report_date,c.metric_name,m.normalized_value,
 ((xpath('//*[local-name()="' || c.item_code || '"]/text()',xmlparse(document r.raw_xbrl)))[1]::text)::numeric as independent_xml_value
 from edgar_private.bank_call_reports r cross join codes c
 join edgar_private.bank_call_report_metrics m on m.report_id=r.id and m.metric_name=c.metric_name
), deposits as (
 select r.id_rssd,r.report_date,m.metric_name,m.normalized_value,
 ((xpath('//*[local-name()="RCON2200"]/text()',xmlparse(document r.raw_xbrl)))[1]::text)::numeric +
 ((xpath('//*[local-name()="RCFN2200"]/text()',xmlparse(document r.raw_xbrl)))[1]::text)::numeric as independent_xml_value
 from edgar_private.bank_call_reports r join edgar_private.bank_call_report_metrics m on m.report_id=r.id and m.metric_name='deposits'
), all_checks as (select * from direct union all select * from deposits)
select *,normalized_value=independent_xml_value as agrees from all_checks order by id_rssd,report_date,metric_name;
