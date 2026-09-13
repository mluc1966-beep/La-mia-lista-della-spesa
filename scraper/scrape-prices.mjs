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
    official:["https://ilgigante.net/volantini/","https://ilgigante.net/cerca-punto-vendita/"]
  },
  {
    id:"ipercoop_collegno",
    name:"Ipercoop Collegno · Piazza Bruno Trentin 1",
    city:"collegno",
    chain:["ipercoop","coop"],
    address:["piazza bruno trentin","1"],
    promoPage:"https://www.promoqui.it/collegno/ipercoop",
    official:["https://www.novacoop.it/","https://www.novacoop.it/punti-vendita/coop-collegno"]
  },
  {
    id:"ipercoop_beinasco",
    name:"Ipercoop Beinasco · Le Fornaci",
    city:"beinasco",
    chain:["ipercoop","coop"],
    address:["strada torino","34"],
    promoPage:"https://www.promoqui.it/beinasco/ipercoop",
    official:["https://www.novacoop.it/","https://www.novacoop.it/news-eventi/news/ipercoop-beinasco-rinnovato"]
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
    address:["via torino","59"],
    promoPage:"https://www.promoqui.it/bruino/ekom",
    official:["https://www.ekomdiscount.it/punti-vendita","https://www.ekomdiscount.it/volantini"]
  }
];

const norm = s => String(s||"").toLowerCase().normalize("NFD")
  .replace(/[\u0300-\u036f]/g,"")
  .replace(/[^a-z0-9]+/g," ")
  .replace(/\s+/g," ")
  .trim();

const MAX_HTML = 2_500_000;
const MAX_VISIBLE = 500_000;

function clipText(s, limit){
  s=String(s||"");
  if(s.length<=limit) return s;
  const half=Math.floor(limit/2);
  return s.slice(0,half)+"\n...\n"+s.slice(-half);
}

function htmlToText(html){
  return String(html||"")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<[^>]+>/g,"\n")
    .replace(/&nbsp;/gi," ")
    .replace(/&euro;|&#8364;/gi,"€")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/\r/g,"")
    .replace(/\n{2,}/g,"\n");
}

function rawSnippetsForItem(raw,item){
  raw=String(raw||"");
  const out=[];
  const low=raw.toLowerCase();
  for(const q of queriesFor(item)){
    for(const term of norm(q).split(" ").filter(x=>x.length>2)){
      let from=0, hits=0;
      while(hits<8){
        const i=low.indexOf(term,from);
        if(i<0) break;
        out.push(raw.slice(Math.max(0,i-1200),Math.min(raw.length,i+1800)));
        from=i+term.length;
        hits++;
      }
    }
  }
  return out.join("\n");
}

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
  const n=norm(item.nome);
  if(/\bspaghett/.test(n)) out.push("spaghetti","spaghettini","pasta di semola");
  if(/\blatte\b/.test(n)) out.push("latte","latte uht","parzialmente scremato");
  return [...new Set(out.map(x=>String(x||"").trim()).filter(Boolean))];
}

function queryScore(text,q){
  const t=norm(text), terms=norm(q).split(" ").filter(x=>x.length>2);
  if(!terms.length) return 0;
  let hits=terms.filter(x=>t.includes(x)).length;
  if(hits===terms.length) hits+=5;
  return hits;
}

function extractPriceCandidates(text,item){
  const raw=String(text||"");
  const queries=queriesFor(item);
  const lines=raw.split(/\n+/).map(x=>x.trim()).filter(Boolean);
  const out=[];

  for(let i=0;i<lines.length;i++){
    const window=lines.slice(Math.max(0,i-3),Math.min(lines.length,i+6)).join(" ");
    let bestQ="", score=0;
    for(const q of queries){
      const s=queryScore(window,q);
      if(s>score){score=s;bestQ=q;}
    }
    if(score<=0) continue;

    const matches=[...window.matchAll(/(?:€\s*)?(\d{1,3}[.,]\d{2})(?:\s*€)?/g)];
    for(const m of matches){
      const price=Number(m[1].replace(",","."));
      if(!Number.isFinite(price)||price<=0||price>500) continue;

      // Evita di scegliere il prezzo barrato quando nello stesso contesto c'è uno sconto:
      // preferiamo il primo prezzo che compare vicino al nome prodotto.
      const discount=(window.match(/-\s*(\d{1,2})\s*%/)||[])[1]||null;
      const productLine=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+4))
        .filter(x=>queryScore(x,bestQ)>0)
        .sort((a,b)=>queryScore(b,bestQ)-queryScore(a,bestQ))[0] || bestQ;

      out.push({
        price,
        name:productLine.replace(/\s+/g," ").slice(0,180),
        discount:discount?Number(discount):null,
        score
      });
    }
  }

  const seen=new Set(), dedup=[];
  for(const x of out.sort((a,b)=>(b.score-a.score)||(a.price-b.price))){
    const k=`${norm(x.name)}|${x.price}`;
    if(seen.has(k)) continue;
    seen.add(k); dedup.push(x);
  }
  return dedup;
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

async function loadAllRepresentations(page,url){
  const response=await page.goto(url,{waitUntil:"domcontentloaded",timeout:30000});
  let initialHtml="";
  try{
    initialHtml=response ? await response.text() : "";
  }catch(e){}
  initialHtml=clipText(initialHtml,MAX_HTML);

  await dismissCookies(page);
  await page.waitForTimeout(1200);

  const visible=clipText(
    await page.locator("body").innerText({timeout:12000}).catch(()=> ""),
    MAX_VISIBLE
  );
  const title=await page.title().catch(()=> "");

  // Niente page.content() e niente HTML grezzo completo:
  // erano la causa dell'esaurimento dei 4 GB di heap nel run #5.
  return {
    title,
    status:response?.status?.()||null,
    finalUrl:page.url(),
    visibleLength:visible.length,
    initialHtmlLength:initialHtml.length,
    visible,
    initialHtml
  };
}

async function findOnPage(page,url,item){
  const loaded=await loadAllRepresentations(page,url);
  const searchable=[
    loaded.visible,
    htmlToText(loaded.initialHtml),
    rawSnippetsForItem(loaded.initialHtml,item)
  ].join("\n");
  const candidates=extractPriceCandidates(searchable,item);
  return {loaded,candidates};
}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  locale:"it-IT",
  viewport:{width:1440,height:1200},
  userAgent:"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36"
});
const page=await context.newPage();
page.setDefaultTimeout(12000);

const results=[];
const diagnostics=[];

for(const store of stores){
  const storeDiag={
    storeId:store.id,
    storeName:store.name,
    promoPage:store.promoPage,
    page:null,
    items:[]
  };

  let storePage=null;
  try{
    storePage=await loadAllRepresentations(page,store.promoPage);
    storeDiag.page={
      title:storePage.title,
      status:storePage.status,
      finalUrl:storePage.finalUrl,
      visibleLength:storePage.visibleLength,
      initialHtmlLength:storePage.initialHtmlLength
    };
  }catch(e){
    storeDiag.page={error:String(e.message||e)};
  }

  for(const item of items){
    let best=null, source="", sourceUrl="";

    if(storePage){
      const searchable=[
        storePage.visible,
        htmlToText(storePage.initialHtml),
        rawSnippetsForItem(storePage.initialHtml,item)
      ].join("\n");
      const hits=extractPriceCandidates(searchable,item);
      if(hits[0]){
        best=hits[0];
        source="PromoQui pagina negozio";
        sourceUrl=store.promoPage;
      }
    }

    // Se la pagina negozio non contiene il prodotto, prova anche la pagina di ricerca.
    if(!best){
      for(const q of queriesFor(item)){
        const url=`https://www.promoqui.it/${store.city}/offerte/${norm(q).replace(/\s+/g,"-")}`;
        try{
          const r=await findOnPage(page,url,item);
          if(r.candidates[0]){
            best=r.candidates[0];
            source="PromoQui ricerca prodotto";
            sourceUrl=url;
            break;
          }
        }catch(e){}
      }
    }

    // Ultimo fallback: siti ufficiali, ma solo se troviamo prodotto+prezzo nello stesso contesto.
    if(!best){
      for(const url of store.official){
        try{
          const r=await findOnPage(page,url,item);
          if(r.candidates[0]){
            best=r.candidates[0];
            source="Sito ufficiale";
            sourceUrl=url;
            break;
          }
        }catch(e){}
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
        offerta:source.startsWith("PromoQui") || !!best.discount,
        scontoPercentuale:best.discount,
        tipoFonte:"browser",
        fonte:source,
        sourceUrl,
        confidence:"medium",
        checkedAt:new Date().toISOString()
      });
      storeDiag.items.push({
        item:item.nome,
        found:true,
        price:best.price,
        product:best.name,
        source
      });
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
  engine:"playwright-browser-v4",
  items,
  prices:results,
  diagnostics
};

const out=process.env.OUTPUT_FILE || `data/price-results/${requestId}.json`;
await fs.mkdir(out.split("/").slice(0,-1).join("/"),{recursive:true});
await fs.writeFile(out,JSON.stringify(payload,null,2),"utf8");
console.log(JSON.stringify({requestId,prices:results.length,output:out,engine:payload.engine}));
