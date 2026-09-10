import { refreshUniverseSnapshot } from '../../../../utils/marketUniverseServer.js';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=300;
export async function GET(request){
  const headers={'Cache-Control':'private, no-store'};
  if(!process.env.CRON_SECRET||request.headers.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)return Response.json({error:'Unauthorized'},{status:401,headers});
  const controller=new AbortController(),deadline=Date.now()+285000;
  const timer=setTimeout(()=>controller.abort(new Error('Universe refresh deadline reached.')),260000);
  try{return Response.json(await refreshUniverseSnapshot({signal:controller.signal,deadline}),{headers});}
  catch(error){return Response.json({error:error.message},{status:error.status||503,headers});}
  finally{clearTimeout(timer);}
}
