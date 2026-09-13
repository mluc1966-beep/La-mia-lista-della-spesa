import { chromium } from "playwright";
import fs from "node:fs/promises";

const requestId = process.env.REQUEST_ID || `req-${Date.now()}`;
const items = JSON.parse(process.env.ITEMS_JSON || "[]");
const prefs = JSON.parse(process.env.PREFS_JSON || "[]");

const stores = [
  {
    id:"gigante_rivalta", name:"Il Gigante Rivalta", city:"rivalta-di-torino",
    chain:["il gigante","gigante"], address:["via giaveno","57"],
    official:["https://ilgigante.net/volantini/","https://ilgigante.net/cerca-punto-vendita/"]
  },
  {
    id:"ipercoop_collegno", name:"Ipercoop Collegno · Piazza Bruno Trentin 1", city:"collegno",
    chain:["ipercoop","coop"], address:["piazza bruno trentin","1"],
    official:["https://www.novacoop.it/","https://www.novacoop.it/punti-vendita/coop-collegno"]
  },
  {
    id:"ipercoop_beinasco", name:"Ipercoop Beinasco · Le Fornaci", city:"beinasco",
    chain:["ipercoop","coop"], address:["strada torino","34"],
    official:["https://www.novacoop.it/","https://www.novacoop.it/news-eventi/news/ipercoop-beinasco-rinnovato"]
  },
  {
    id:"lidl_beinasco", name:"Lidl Beinasco", city:"beinasco",
    chain:["lidl"], address:["strada torino","25"],
    official:[
      "https://www.lidl.it/s/it-IT/ricerca-negozio/beinasco-to/strada-torino-25/",
      "https://www.lidl.it/c/volantino-lidl/s10018048"
    ]
  },
  {
    id:"lidl_rivoli", name:"Lidl Rivoli · Corso Susa 260a", city:"rivoli",
    chain:["lidl"], address:["corso susa","260"],
    official:[
      "https://www.lidl.it/s/it-IT/ricerca-negozio/rivoli-to/corso-susa-260a/",
      "https://www.lidl.it/c/volantino-lidl/s10018048"
    ]
  },
  {
    id:"ekom_bruino", name:"Ekom Bruino", city:"bruino",
    chain:["ekom"], address:["via torino","59"],
    official:["https://www.ekomdiscount.it/punti-vendita","https://www.ekomdiscount.it/volantini"]
  }
];

const norm = s => String(s||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();

function prefFor(name){
  const n=norm(name);
  return prefs.find(p=>norm(p.prodotto)===n)||null;
}
function queriesFor(item){
  const out=[item.nome];
  const p=prefFor(item.nome);
  if(p?.regola){
    let r=String(p.regola).replace(/^sempre\s+/i,"")
      .replace(/\b(?:della|del|da|di)\s+(?:Ipercoop|Coop|Lidl|Ekom|Gigante|Il Gigante)\b.*$/i,"").trim();
    if(r) out.unshift(r);
    if(r && !norm(r).includes(norm(item.nome))) out.unshift(`${item.nome} ${r}`);
  }
  return [...new Set(out.filter(Boolean))];
}
const slug=s=>norm(s).replace(/\s+/g,"-");

async function visibleText(page){
  await page.waitForTimeout(1200);
  return await page.locator("body").innerText({timeout:15000}).catch(()=> "");
}

async function visitOfficial(page,store){
  const seen=[];
  for(const url of store.official){
    try{
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
      await dismissCookies(page);
      const text=await visibleText(page);
      seen.push({url,text:text.slice(0,12000)});
    }catch(e){
      seen.push({url,error:String(e.message||e)});
    }
  }
  return seen;
}

async function dismissCookies(page){
  for(const rx of [/accetta/i,/acconsenti/i,/accept/i,/rifiuta tutti/i]){
    const b=page.getByRole("button",{name:rx}).first();
    if(await b.count().catch(()=>0)){
      await b.click({timeout:1500}).catch(()=>{});
      break;
    }
  }
}

function extractStoreBlock(text,store){
  const n=norm(text);
  let bestStart=-1;
  for(const chain of store.chain){
    const i=n.indexOf(norm(chain));
    if(i>=0 && (bestStart<0 || i<bestStart)) bestStart=i;
  }
  if(bestStart<0) return "";
  // body.innerText e testo normalizzato hanno lunghezze simili ma non identiche:
  // usiamo una finestra ampia e verifichiamo l'indirizzo nel testo reale.
  const candidates=[];
  for(let start=Math.max(0,bestStart-500); start<Math.min(text.length,bestStart+6000); start+=600){
    const block=text.slice(start,Math.min(text.length,start+7000));
    const nb=norm(block);
    const addrHits=store.address.filter(t=>nb.includes(norm(t))).length;
    const chainHit=store.chain.some(t=>nb.includes(norm(t)));
    if(chainHit && addrHits>=Math.min(2,store.address.length)) candidates.push(block);
  }
  return candidates[0] || "";
}

function parseOffers(block,query){
  if(!block) return [];
  const qterms=norm(query).split(" ").filter(x=>x.length>2);
  const lines=block.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const out=[];
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(/(?:€\s*)?(\d{1,3}[.,]\d{2})(?:\s*€)?/);
    if(!m) continue;
    const price=Number(m[1].replace(",","."));
    if(!Number.isFinite(price)||price<=0||price>500) continue;
    const context=lines.slice(Math.max(0,i-5),Math.min(lines.length,i+3)).join(" ");
    const nc=norm(context);
    const hits=qterms.filter(t=>nc.includes(t)).length;
    if(qterms.length && hits===0) continue;
    const nameCandidates=lines.slice(Math.max(0,i-5),i)
      .filter(x=>!/volantino|sconto|scade|aperto|chiuso|via |strada |corso |piazza /i.test(x))
      .filter(x=>!/\d{1,3}[.,]\d{2}/.test(x));
    const name=(nameCandidates.reverse().find(x=>x.length>2)||query).slice(0,180);
    const discount=(context.match(/-\s*(\d{1,2})\s*%/)||[])[1]||null;
    out.push({name,price,discount:discount?Number(discount):null,score:hits});
  }
  return out.sort((a,b)=>(b.score-a.score)||(a.price-b.price));
}

async function promoQuiOffers(page,store,query){
  const url=`https://www.promoqui.it/${store.city}/offerte/${slug(query)}`;
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
  await dismissCookies(page);
  const text=await visibleText(page);
  const block=extractStoreBlock(text,store);
  return {url,offers:parseOffers(block,query),block:block.slice(0,2500)};
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:"it-IT",
  userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36"
});
const page=await context.newPage();

const results=[];
const diagnostics=[];

for(const store of stores){
  const official=await visitOfficial(page,store);
  diagnostics.push({storeId:store.id,official:official.map(x=>({url:x.url,ok:!!x.text,error:x.error||null}))});

  for(const item of items){
    let best=null, bestQuery=null, sourceUrl=null;
    for(const q of queriesFor(item)){
      try{
        const r=await promoQuiOffers(page,store,q);
        const offer=r.offers[0];
        if(offer && (!best || offer.score>best.score || (offer.score===best.score && offer.price<best.price))){
          best=offer; bestQuery=q; sourceUrl=r.url;
        }
      }catch(e){
        diagnostics.push({storeId:store.id,item:item.nome,query:q,error:String(e.message||e)});
      }
    }
    if(best){
      results.push({
        nomeLista:item.nome,
        prodotto:best.name,
        storeId:store.id,
        storeName:store.name,
        prezzo:best.price,
        valuta:"EUR",
        offerta:true,
        scontoPercentuale:best.discount,
        tipoFonte:"browser",
        fonte:"PromoQui (navigazione browser)",
        sourceUrl,
        validationUrls:store.official,
        confidence:"medium",
        query:bestQuery,
        checkedAt:new Date().toISOString()
      });
    }
  }
}
await browser.close();

const payload={
  requestId,
  generatedAt:new Date().toISOString(),
  engine:"playwright-browser-v1",
  items,
  prices:results,
  diagnostics
};

const out=process.env.OUTPUT_FILE || `data/price-results/${requestId}.json`;
await fs.mkdir(out.split("/").slice(0,-1).join("/"),{recursive:true});
await fs.writeFile(out,JSON.stringify(payload,null,2),"utf8");
console.log(JSON.stringify({requestId,prices:results.length,output:out}));
