'use client';
import { ResponsiveContainer,ScatterChart,Scatter,CartesianGrid,XAxis,YAxis,Tooltip,ReferenceLine,Cell } from 'recharts';
import { formatPeerPercent as pct } from '../../../utils/bank/peerMetrics.js';
import styles from './banks.module.css';

function PointTooltip({active,payload,xLabel,yLabel,bankRssd}){
  const p=payload?.[0]?.payload;
  if(!active||!p)return null;
  return <div className={styles.chartTooltip}><small>{String(p.rssd)===String(bankRssd)?'Selected bank':'Individual peer bank'} · RSSD {p.rssd}</small><strong>{p.name}</strong><div><span>{xLabel}</span><b>{pct(p.x)}</b></div><div><span>{yLabel}</span><b>{pct(p.y)}</b></div></div>;
}
export default function BankPeerLandscape({model,xMetric,yMetric,bank,selectedId,onSelect}){
  if(!model.points.length&&!model.selected)return <div className={styles.chartEmpty}>No banks report both selected metrics.</div>;
  const axis={tick:{fontSize:10,fill:'#a1b8d0'},axisLine:false,tickLine:false,tickFormatter:pct,type:'number'};
  return <div className={styles.peerLandscapeChart} role="group" aria-label={`${xMetric.label} versus ${yMetric.label} peer map`}>
    <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{width:670,height:360}}><ScatterChart margin={{top:20,right:24,left:2,bottom:12}} accessibilityLayer>
      <CartesianGrid stroke="#2b3f55" strokeDasharray="2 6"/>
      <XAxis {...axis} dataKey="x" domain={model.xDomain} tickCount={5}/><YAxis {...axis} dataKey="y" domain={model.yDomain} width={68} tickCount={5}/>
      {model.xMedian!=null&&<ReferenceLine x={model.xMedian} stroke="#c4a6ff" strokeDasharray="5 5" strokeOpacity={.6}/>}
      {model.yMedian!=null&&<ReferenceLine y={model.yMedian} stroke="#c4a6ff" strokeDasharray="5 5" strokeOpacity={.6}/>}
      <Tooltip content={<PointTooltip xLabel={xMetric.label} yLabel={yMetric.label} bankRssd={bank.rssd}/>} cursor={{stroke:'#a7c2db',strokeDasharray:'3 4'}}/>
      <Scatter data={model.points} fill="#c4a6ff" onClick={point=>onSelect(String(point.payload?.rssd||point.rssd))} isAnimationActive={false}>{model.points.map(p=><Cell key={p.rssd} fill={p.rssd===selectedId?'#eee0ff':'#b59ce6'} fillOpacity={p.rssd===selectedId?1:.65} stroke={p.rssd===selectedId?'#ffffff':'#0e1824'} strokeWidth={p.rssd===selectedId?2.5:1.5} cursor="pointer"/>)}</Scatter>
      {model.selected&&<Scatter data={[model.selected]} fill="#69c7ff" shape={({cx,cy})=><g><circle cx={cx} cy={cy} r="14" fill="#69c7ff" fillOpacity=".12" stroke="#69c7ff" strokeOpacity=".45"/><circle cx={cx} cy={cy} r="7" fill="#69c7ff" stroke="#d3f0ff" strokeWidth="1.5"/></g>} isAnimationActive={false}/>}
    </ScatterChart></ResponsiveContainer>
  </div>;
}
