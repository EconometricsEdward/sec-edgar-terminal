import { timingSafeEqual } from 'node:crypto';
import { runBankWorker } from '../../../../utils/bank/worker.js';
export const runtime='nodejs';
export const maxDuration=240;
export const dynamic='force-dynamic';
export async function GET(request){
  const expected=process.env.CRON_SECRET?Buffer.from(`Bearer ${process.env.CRON_SECRET}`):null,actual=Buffer.from(request.headers.get('authorization')||'');
  if(!expected||actual.length!==expected.length||!timingSafeEqual(expected,actual))return Response.json({error:'Unauthorized'},{status:401});
  if(process.env.VERCEL_ENV!=='production')return Response.json({error:'Production schedule only'},{status:403});
  return Response.json(await runBankWorker({maintain:true,maxFilings:8}),{headers:{'Cache-Control':'private, no-store'}});
}
