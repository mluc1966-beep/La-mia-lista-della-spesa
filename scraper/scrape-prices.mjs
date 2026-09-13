import { chromium } from "playwright";
import fs from "node:fs/promises";

const requestId = process.env.REQUEST_ID || `req-${Date.now()}`;

function parseJsonEnv(name, fallback=[]){
  const raw=String(process.env[name] ?? "").trim();
  if(!raw) return fallback;
  try { return JSON.parse(raw); }
  catch(e){ throw new Error(`${name} non è JSON valido: ${raw.slice(0,180)}`); }
}

const items = parseJsonEnv("ITEMS_JSON",[]);
const prefs = parseJsonEnv("PREFS_JSON",[]);

const stores = [
  {
    id:"gigante_rivalta",
    name:"Il Gigante Rivalta",
    city:"rivalta-di-torino",
    chain:["il gigante","gigante"],
    address:["via giaveno","57"],
    promoPage:"https://www.promoqui.it/rivalta-di-torino/il-gigante",
    official:[
      "https://ilgigante.net/volantini/",
      "https://ilgigante.net/cerca-punto-vendita/"
    ]
  },
  {
    id:"ipercoop_collegno",
    name:"Ipercoop Collegno · Piazza Bruno Trentin 1",
    city:"collegno",
    chain:["ipercoop","coop"],
    address:["piazza bruno trentin","1"],
    promoPage:"https://www.promoqui.it/collegno/ipercoop",
    official:[
      "https://www.novacoop.it/",
      "https://www.novacoop.it/punti-vendita/coop-collegno"
    ]
  },
  {
    id:"ipercoop_beinasco",
    name:"Ipercoop Beinasco · Le Fornaci",
    city:"beinasco",
    chain:["ipercoop","coop"],
    address:["strada torino","34"],
    promoPage:"https://www.promoqui.it/beinasco/ipercoop",
    official:[
      "https://www.novacoop.it/",
      "https://www.novacoop.it/news-eventi/news/ipercoop-beinasco-rinnovato"
    ]
  },
  {
    id:"lidl_beinasco",
    name:"Lidl Beinasco",
    city:"beinasco",
    chain:["lidl"],
    address:["strada torino","25"],
    promoPage:"https://www.promoqui.it/beinasco/lidl",
    official:[
      "https://www.lidl.it/s/it-IT/ricerca-negozio/beinasco-to/strada-torino-25/",
      "https://www.lidl.it/c/volantino-lidl/s10018048"
    ]
  },
  {
    id:"lidl_rivoli",
    name:"Lidl Rivoli · Corso Susa 260/A",
    city:"rivoli",
    chain:["lidl"],
    address:["corso susa","260"],
    promoPage:"https://www.promoqui.it/rivoli/lidl",
    official:[
      "https://www.lidl.it/s/it-IT/ricerca-negozio/rivoli-to/corso-susa-260a/",
      "https://www.lidl.it/c/volantino-lidl/s10018048"
    ]
  },
  {
    id:"ekom_bruino",
    name:"Ekom Bruino",
    city:"bruino",
    chain:["ekom"],
    address:["bruino"],
    promoPage:"https://www.promoqui.it/bruino/ekom",
    official:[
      "https://www.ekomdiscount.it/punti-vendita",
      "https://www.ekomdiscount.it/volantini"
    ]
  }
];

const norm = s => String(s||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g," ")
  .replace(/\s+/g," ")
  .trim();

const moneyRx = /(\d{1,3}[.,]\d{2})\s*€/g;

function prefFor(name){
  const n=norm(name);
  return prefs.find(p=>norm(p.prodotto)===n)||null;
}

function queriesFor(item){
  const out=[String(item.nome||"").trim()];
  const p=prefFor(item.nome);
  if(p?.regola){
    let r=String(p.regola)
      .replace(/^sempre\s+/i,"")
      .replace(/\b(?:della|del|da|di)\s+(?:Ipercoop|Coop|Lidl|Ekom|Gigante|Il Gigante)\b.*$/i,"")
      .trim();
    if(r){
      out.unshift(r);
      if(!norm(r).includes(norm(item.nome))) out.unshift(`${item.nome} ${r}`);
    }
  }

  // sinonimi utili per prodotti generici
  const n=norm(item.nome);
  if(/\bspaghett/.test(n)) out.push("pasta di semola","pasta");
  if(/\blatte\b/.test(n)) out.push("latte uht","latte parzialmente scremato");
  if(/\bfette biscottate\b/.test(n)) out.push("fette biscottate");

  return [...new Set(out.map(x=>String(x||"").trim()).filter(Boolean))];
}

function queryScore(text,q){
  const t=norm(text), terms=norm(q).split(" ").filter(x=>x.length>2);
  if(!terms.length) return 0;
  let hits=terms.filter(x=>t.includes(x)).length;
  if(hits===terms.length) hits+=3;
  return hits;
}

async function dismissCookies(page){
  for(const rx of [/accetta tutto/i,/accetta/i,/acconsenti/i,/accept all/i,/accept/i,/rifiuta tutti/i]){
    const b=page.getByRole("button",{name:rx}).first();
    if(await b.count().catch(()=>0)){
      await b.click({timeout:1500}).catch(()=>{});
      break;
    }
  }
}

async function gotoText(page,url,wait=1800){
  await page.goto(url,{waitUntil:"domcontentloaded",timeout:35000});
  await dismissCookies(page);
  await page.waitForTimeout(wait);
  return await page.locator("body").innerText({timeout:15000}).catch(()=> "");
}

function priceFromLine(s){
  const ms=[...String(s||"").matchAll(moneyRx)];
  if(!ms.length) return null;
  const p=Number(ms[0][1].replace(",","."));
  return Number.isFinite(p)&&p>0&&p<500?p:null;
}

function cleanProductName(s,q){
  let x=String(s||"").replace(/\s+/g," ").trim();
  x=x.replace(/^\d{1,3}[.,]\d{2}\s*€/,"");
  x=x.replace(/^\d{1,3}[.,]\d{2}\s*€/,"");
  x=x.replace(/^-\s*\d{1,2}\s*%/,"");
  x=x.replace(/\b(?:VOLANTINO|OFFERTA|SCONTO)\b/gi," ").replace(/\s+/g," ").trim();
  return (x||q).slice(0,180);
}

/* Le pagine negozio PromoQui sono molto più affidabili delle vecchie pagine
   /offerte/<query>, perché sono già vincolate alla catena + città. */
function parseStorePage(text,item){
  const lines=String(text||"").split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const queries=queriesFor(item);
  const candidates=[];

  for(let i=0;i<lines.length;i++){
    // PromoQui spesso mette prezzo + vecchio prezzo + sconto + nome nella stessa riga.
    // A volte invece spezza prezzo e prodotto su righe vicine: analizziamo una finestra.
    const win=lines.slice(Math.max(0,i-1),Math.min(lines.length,i+4)).join(" ");
    const p=priceFromLine(win);
    if(p==null) continue;

    let bestQ="",score=0;
    for(const q of queries){
      const s=queryScore(win,q);
      if(s>score){score=s;bestQ=q;}
    }
    if(score<=0) continue;

    const current=lines[i];
    const next=lines.slice(i,Math.min(lines.length,i+4)).join(" ");
    const discount=(next.match(/-\s*(\d{1,2})\s*%/)||[])[1]||null;

    // Se la riga corrente ha solo il prezzo, usa le righe successive come nome.
    let name=current;
    if(norm(current).split(" ").length<2 || /^\d/.test(current)){
      name=lines.slice(i,Math.min(lines.length,i+4))
        .filter(x=>!/^(\d{1,3}[.,]\d{2}\s*€|-?\d{1,2}\s*%)$/.test(x))
        .join(" ");
    }

    candidates.push({
      price:p,
      name:cleanProductName(name,bestQ),
      discount:discount?Number(discount):null,
      score
    });
  }

  // Elimina duplicati e privilegia corrispondenza semantica, poi prezzo più basso.
  const dedup=[];
  const seen=new Set();
  for(const c of candidates.sort((a,b)=>(b.score-a.score)||(a.price-b.price))){
    const k=norm(c.name)+"|"+c.price;
    if(seen.has(k)) continue;
    seen.add(k);dedup.push(c);
  }
  return dedup;
}

function parseQueryPageForStore(text,store,item){
  const lines=String(text||"").split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const queries=queriesFor(item);
  const out=[];

  for(let i=0;i<lines.length;i++){
    const short=norm(lines[i]);
    const isChain=store.chain.some(c=>short===norm(c) || (short.includes(norm(c)) && short.length<40));
    if(!isChain) continue;

    const block=lines.slice(i,Math.min(lines.length,i+28)).join(" ");
    const nb=norm(block);
    const addrHits=store.address.filter(a=>nb.includes(norm(a))).length;
    if(store.address.length && addrHits<1) continue;

    const p=priceFromLine(block);
    if(p==null) continue;

    let bestQ="",score=0;
    for(const q of queries){
      const s=queryScore(block,q);
      if(s>score){score=s;bestQ=q;}
    }
    if(score<=0) continue;

    const discount=(block.match(/-\s*(\d{1,2})\s*%/)||[])[1]||null;
    out.push({
      price:p,
      name:cleanProductName(block,bestQ),
      discount:discount?Number(discount):null,
      score:score+addrHits*2
    });
  }
  return out.sort((a,b)=>(b.score-a.score)||(a.price-b.price));
}

async function visitOfficial(page,store,item){
  const hits=[];
  for(const url of store.official){
    try{
      const text=await gotoText(page,url,1500);
      const n=norm(text);
      for(const q of queriesFor(item)){
        const s=queryScore(text,q);
        if(s<=0) continue;

        // Cerca prezzi vicino alla prima occorrenza del termine.
        const terms=norm(q).split(" ").filter(x=>x.length>2);
        const first=terms.map(t=>n.indexOf(t)).filter(x=>x>=0).sort((a,b)=>a-b)[0];
        if(first==null) continue;
        const approx=Math.min(text.length,Math.max(0,first));
        const ctx=text.slice(Math.max(0,approx-500),Math.min(text.length,approx+1200));
        const p=priceFromLine(ctx);
        if(p!=null){
          hits.push({price:p,name:q,discount:null,score:s,sourceUrl:url});
        }
      }
    }catch(e){}
  }
  return hits.sort((a,b)=>(b.score-a.score)||(a.price-b.price));
}

async function promoQuiStoreOffers(page,store,item){
  const text=await gotoText(page,store.promoPage,1800);
  return parseStorePage(text,item);
}

async function promoQuiQueryOffers(page,store,item){
  let all=[];
  for(const q of queriesFor(item)){
    const url=`https://www.promoqui.it/${store.city}/offerte/${norm(q).replace(/\s+/g,"-")}`;
    try{
      const text=await gotoText(page,url,1500);
      const offers=parseQueryPageForStore(text,store,item).map(x=>({...x,sourceUrl:url}));
      all=all.concat(offers);
    }catch(e){}
  }
  return all.sort((a,b)=>(b.score-a.score)||(a.price-b.price));
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:"it-IT",
  viewport:{width:1440,height:1200},
  userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"
});
const page=await context.newPage();

const results=[];
const diagnostics=[];

for(const store of stores){
  const storeDiag={storeId:store.id,storeName:store.name,promoPage:store.promoPage,items:[]};

  for(const item of items){
    let best=null, source="";

    // 1. Pagina negozio specifica: evita il vecchio errore di dover ricostruire
    //    la sezione del negozio dentro una pagina generica.
    try{
      const hits=await promoQuiStoreOffers(page,store,item);
      if(hits[0]){
        best={...hits[0],sourceUrl:store.promoPage};
        source="PromoQui pagina negozio";
      }
    }catch(e){
      storeDiag.items.push({item:item.nome,stage:"promo-store",error:String(e.message||e)});
    }

    // 2. Ricerca per prodotto, utile se la pagina negozio mostra solo le offerte in evidenza.
    if(!best){
      try{
        const hits=await promoQuiQueryOffers(page,store,item);
        if(hits[0]){
          best=hits[0];
          source="PromoQui ricerca prodotto";
        }
      }catch(e){
        storeDiag.items.push({item:item.nome,stage:"promo-query",error:String(e.message||e)});
      }
    }

    // 3. Ultimo tentativo sui siti ufficiali visibili al browser.
    if(!best){
      try{
        const hits=await visitOfficial(page,store,item);
        if(hits[0]){
          best=hits[0];
          source="Sito ufficiale";
        }
      }catch(e){
        storeDiag.items.push({item:item.nome,stage:"official",error:String(e.message||e)});
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
        offerta:source!=="Sito ufficiale" || !!best.discount,
        scontoPercentuale:best.discount,
        tipoFonte:"browser",
        fonte:source,
        sourceUrl:best.sourceUrl || store.promoPage,
        validationUrls:store.official,
        confidence:source==="Sito ufficiale"?"medium":"medium",
        checkedAt:new Date().toISOString()
      });
      storeDiag.items.push({item:item.nome,found:true,price:best.price,source});
    }else{
      storeDiag.items.push({item:item.nome,found:false});
    }
  }

  diagnostics.push(storeDiag);
}

await browser.close();

const payload={
  requestId,
  generatedAt:new Date().toISOString(),
  engine:"playwright-browser-v2",
  items,
  prices:results,
  diagnostics
};

const out=process.env.OUTPUT_FILE || `data/price-results/${requestId}.json`;
await fs.mkdir(out.split("/").slice(0,-1).join("/"),{recursive:true});
await fs.writeFile(out,JSON.stringify(payload,null,2),"utf8");
console.log(JSON.stringify({requestId,prices:results.length,output:out,engine:payload.engine}));
