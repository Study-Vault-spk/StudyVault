
import crypto from "node:crypto";
import {
  decksStore,json,auth,normalizeDeck,DATA_SCHEMA_VERSION,ensureSchemaMeta
} from "./_lib.mjs";

function prefix(userId){return `user/${userId}/deck/`}
function key(userId,id){return prefix(userId)+id}

async function listDecks(userId){
  const {blobs}=await decksStore.list({prefix:prefix(userId)});
  const items=[];
  for(const b of blobs){
    const raw=await decksStore.get(b.key,{type:"json"});
    if(!raw)continue;
    const d=normalizeDeck(raw,userId);
    if(raw.schemaVersion!==DATA_SCHEMA_VERSION){
      await decksStore.setJSON(b.key,d);
    }
    items.push(d);
  }
  return items.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt));
}

export default async function(req){
  await ensureSchemaMeta();
  const a=await auth(req);
  if(!a)return json({error:"Bitte melde dich erneut an."},401);

  const u=new URL(req.url);
  const id=u.searchParams.get("id");

  if(req.method==="GET"){
    if(id){
      const raw=await decksStore.get(key(a.user.id,id),{type:"json",consistency:"strong"});
      if(!raw)return json({error:"Lernkartenset nicht gefunden."},404);
      return json({deck:normalizeDeck(raw,a.user.id)});
    }
    return json({decks:await listDecks(a.user.id),schemaVersion:DATA_SCHEMA_VERSION});
  }

  if(req.method==="POST"){
    let body;
    try{body=await req.json()}catch{return json({error:"Ungültiges Lernkartenset."},400)}

    const deck=normalizeDeck({
      ...body,
      id:String(body?.id||crypto.randomUUID()),
      userId:a.user.id,
      createdAt:body?.createdAt||new Date().toISOString(),
      updatedAt:new Date().toISOString()
    },a.user.id);

    if(!Array.isArray(deck.cards)||deck.cards.length<1){
      return json({error:"Das Lernkartenset enthält keine Karten."},400);
    }

    await decksStore.setJSON(key(a.user.id,deck.id),deck);
    return json({deck},201);
  }

  if(req.method==="PATCH"){
    if(!id)return json({error:"Deck-ID fehlt."},400);
    const raw=await decksStore.get(key(a.user.id,id),{type:"json",consistency:"strong"});
    if(!raw)return json({error:"Lernkartenset nicht gefunden."},404);
    let body;
    try{body=await req.json()}catch{return json({error:"Ungültige Änderung."},400)}

    const base=normalizeDeck(raw,a.user.id);
    const nextProgress={...base.progress};
    if(body?.progress && typeof body.progress==="object") Object.assign(nextProgress,body.progress);
    if(body?.cardId!==undefined && ["again","unsure","know"].includes(body?.rating)){
      nextProgress[String(body.cardId)]=body.rating;
    }
    const next=normalizeDeck({
      ...base,
      progress:nextProgress,
      name:body?.name??base.name,
      updatedAt:new Date().toISOString()
    },a.user.id);

    await decksStore.setJSON(key(a.user.id,id),next);
    return json({deck:next});
  }

  if(req.method==="DELETE"){
    if(!id)return json({error:"Deck-ID fehlt."},400);
    await decksStore.delete(key(a.user.id,id));
    return json({ok:true});
  }

  return json({error:"Method not allowed"},405);
}
export const config={path:"/api/decks"};
