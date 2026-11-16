import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Execute the actual widget lifecycle, with a deterministic clock and a visibility-aware widget stub.
export function humanUI(options={}) {
  const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
  const calls=[],timers=new Set(),elements={},events=[];
  let now=1000000,token='',callbacks,resetCount=0,scrolls=0;
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  const ctx={Promise,Error,Date:{now:()=>now},window:null,
    setTimeout(fn,ms){const timer={fn,at:now+ms};timers.add(timer);return timer;},
    clearTimeout(timer){timers.delete(timer);},
    document:{getElementById(id){return elements[id] ||= {style:{},className:'',textContent:'',clientWidth:400,
      scrollIntoView(){scrolls++;events.push('reveal');},querySelector(){return {};}};}},
    fetch:async(url,init)=>{calls.push({url,init});if(url==='/api/turnstile-key')return Response.json({ok:true,required:true,siteKey:'public-test-site-key'});
      if(options.fetch)return options.fetch(url,init);
      return Response.json({ok:true},{headers:options.used?{'X-Human-Token':'used'}:{}});},
    turnstile:{render(selector,args){callbacks=args;events.push('render');return 1;},
      reset(){resetCount++;token='';events.push('reset');if(options.resetThrows)throw new Error('widget unavailable');},getResponse(){return token;}},
    showError(){},$:id=>ctx.document.getElementById(id)};
  ctx.window=ctx;vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('  var TS_MSG_LOADING'),html.indexOf('    /* 反馈表单 */')),ctx);
  return {ctx,calls,elements,events,flush,
    run:s=>vm.runInContext(s,ctx),
    async init(){await ctx.initParseTs();ctx.tsSetState('ready');},
    async advance(ms){now+=ms;for(const t of [...timers])if(t.at<=now){timers.delete(t);t.fn();}await flush();},
    async solve(value='fresh-token'){token=value;callbacks.callback(value);await this.advance(300);},
    setToken(value){token=value;},get callbacks(){return callbacks;},get resets(){return resetCount;},get scrolls(){return scrolls;}
  };
}
