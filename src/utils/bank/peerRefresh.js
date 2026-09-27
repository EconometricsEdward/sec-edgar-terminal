import { peerPreparationPending } from './viewRequests.js';

/** Start only while the official-report drawer is open. Never poll a hidden tab,
 * retry an outage automatically, or let a pending report run an unbounded loop. */
export function watchPeerPreparation({load,onData,onPause,documentImpl=globalThis.document,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=30000,maxAttempts=8}) {
  let stopped=false,timer,attempts=0,busy=false;
  const controller=new AbortController();
  const schedule=()=>{if(!stopped&&!busy&&documentImpl.visibilityState!=='hidden')timer=setTimer(poll,intervalMs);};
  const pause=message=>{stopped=true;onPause(message);};
  async function poll() {
    timer=undefined;
    if(stopped||documentImpl.visibilityState==='hidden')return;
    busy=true;attempts++;
    try {
      const data=await load(controller.signal);
      if(stopped)return;
      onData(data);
      if(!peerPreparationPending(data)){stopped=true;return;}
      if(attempts>=maxAttempts){pause('Preparation is still in progress. Automatic checks have paused.');return;}
    }catch(error){if(!stopped&&error.name!=='AbortError')pause('Automatic checks paused because the service could not be reached.');}
    finally{busy=false;}
    schedule();
  }
  const visibility=()=>{clearTimer(timer);timer=undefined;schedule();};
  documentImpl.addEventListener('visibilitychange',visibility);
  schedule();
  return()=>{stopped=true;clearTimer(timer);controller.abort();documentImpl.removeEventListener('visibilitychange',visibility);};
}
