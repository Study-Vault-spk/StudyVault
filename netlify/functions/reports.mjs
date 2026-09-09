
import crypto from "node:crypto";
import {
  reportsStore,prefsStore,json,auth,normalizeReport,normalizePrefs,
  DATA_SCHEMA_VERSION,ensureSchemaMeta
} from "./_lib.mjs";

async function allReports(userId){
  const {blobs}=await reportsStore.list({prefix:"report/"});
  const items=[];
  for(const b of blobs){
    const raw=await reportsStore.get(b.key,{type:"json"});
    if(!raw)continue;
    const r=normalizeReport(raw);
    if(raw.schemaVersion!==DATA_SCHEMA_VERSION) await reportsStore.setJSON(b.key,r);
    items.push({...r,isOwn:r.authorId===userId});
  }
  return items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
}

export default async function(req){
  await ensureSchemaMeta();
  const a=await auth(req);
  if(!a)return json({error:"Bitte melde dich erneut an."},401);

  const u=new URL(req.url);
  const id=u.searchParams.get("id");
  const action=u.searchParams.get("action");

  if(req.method==="GET"){
    return json({reports:await allReports(a.user.id),schemaVersion:DATA_SCHEMA_VERSION});
  }

  if(req.method==="POST"){
    let b;
    try{b=await req.json()}catch{return json({error:"Ungültiger Bericht."},400)}
    const fach=String(b.fach||"").trim();
    const themen=String(b.themen||"").trim();
    if(!fach||!themen)return json({error:"Fach und Themen sind erforderlich."},400);

    const rid=crypto.randomUUID();
    const report=normalizeReport({
      schemaVersion:DATA_SCHEMA_VERSION,id:rid,
      semester:b.semester,jahr:b.jahr,fach,pruefer:b.pruefer,
      themen,tipps:b.tipps,schwierigkeit:b.schwierigkeit,form:b.form,
      authorId:a.user.id,authorName:a.user.name,helpfulCount:0,
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
    });
    await reportsStore.setJSON("report/"+rid,report,{onlyIfNew:true});
    return json({report:{...report,isOwn:true}},201);
  }

  if(req.method==="PATCH" && action==="helpful"){
    if(!id)return json({error:"Bericht-ID fehlt."},400);
    const key="report/"+id;
    const raw=await reportsStore.get(key,{type:"json",consistency:"strong"});
    if(!raw)return json({error:"Bericht nicht gefunden."},404);
    const report=normalizeReport(raw);

    const prefsKey=`user/${a.user.id}/prefs`;
    const prefsRaw=await prefsStore.get(prefsKey,{type:"json",consistency:"strong"});
    const prefs=normalizePrefs(prefsRaw||{},a.user.id);
    const has=prefs.helpfulReports.includes(String(id));
    prefs.helpfulReports=has
      ? prefs.helpfulReports.filter(x=>x!==String(id))
      : [...prefs.helpfulReports,String(id)].slice(-500);
    prefs.updatedAt=new Date().toISOString();

    report.helpfulCount=Math.max(0,report.helpfulCount+(has?-1:1));
    report.updatedAt=new Date().toISOString();

    await prefsStore.setJSON(prefsKey,prefs);
    await reportsStore.setJSON(key,report);
    return json({helpful:!has,helpfulCount:report.helpfulCount});
  }

  if(req.method==="PATCH"){
    if(!id)return json({error:"Bericht-ID fehlt."},400);
    const key="report/"+id;
    const raw=await reportsStore.get(key,{type:"json",consistency:"strong"});
    if(!raw)return json({error:"Bericht nicht gefunden."},404);
    const current=normalizeReport(raw);
    if(current.authorId!==a.user.id)return json({error:"Du kannst nur eigene Berichte bearbeiten."},403);

    let b;
    try{b=await req.json()}catch{return json({error:"Ungültige Änderung."},400)}
    const fach=String(b.fach??current.fach).trim();
    const themen=String(b.themen??current.themen).trim();
    if(!fach||!themen)return json({error:"Fach und Themen sind erforderlich."},400);

    const next=normalizeReport({
      ...current,
      semester:b.semester??current.semester,
      jahr:b.jahr??current.jahr,
      fach,
      pruefer:b.pruefer??current.pruefer,
      themen,
      tipps:b.tipps??current.tipps,
      schwierigkeit:b.schwierigkeit??current.schwierigkeit,
      form:b.form??current.form,
      updatedAt:new Date().toISOString()
    });
    await reportsStore.setJSON(key,next);
    return json({report:{...next,isOwn:true}});
  }

  if(req.method==="DELETE"){
    if(!id)return json({error:"Bericht-ID fehlt."},400);
    const raw=await reportsStore.get("report/"+id,{type:"json",consistency:"strong"});
    if(!raw)return json({error:"Bericht nicht gefunden."},404);
    const r=normalizeReport(raw);
    if(r.authorId!==a.user.id)return json({error:"Du kannst nur eigene Berichte löschen."},403);
    await reportsStore.delete("report/"+id);
    return json({ok:true});
  }

  return json({error:"Method not allowed"},405);
}
export const config={path:"/api/reports",rateLimit:{windowLimit:60,windowSize:60,aggregateBy:["ip","domain"]}};
