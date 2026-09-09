
import {prefsStore,json,auth,normalizePrefs,DATA_SCHEMA_VERSION,ensureSchemaMeta} from "./_lib.mjs";

export default async function(req){
  await ensureSchemaMeta();
  const a=await auth(req);
  if(!a)return json({error:"Bitte melde dich erneut an."},401);
  const key=`user/${a.user.id}/prefs`;

  if(req.method==="GET"){
    const raw=await prefsStore.get(key,{type:"json",consistency:"strong"});
    const prefs=normalizePrefs(raw||{},a.user.id);
    if(!raw || raw.schemaVersion!==DATA_SCHEMA_VERSION)await prefsStore.setJSON(key,prefs);
    return json({prefs});
  }

  if(req.method==="PATCH"){
    let body={};
    try{body=await req.json()}catch{return json({error:"Ungültige Einstellungen."},400)}
    const raw=await prefsStore.get(key,{type:"json",consistency:"strong"});
    const current=normalizePrefs(raw||{},a.user.id);
    const next=normalizePrefs({
      ...current,
      favorites:Array.isArray(body.favorites)?body.favorites:current.favorites,
      helpfulReports:Array.isArray(body.helpfulReports)?body.helpfulReports:current.helpfulReports,
      lastActiveDeckId:body.lastActiveDeckId!==undefined?body.lastActiveDeckId:current.lastActiveDeckId,
      updatedAt:new Date().toISOString()
    },a.user.id);
    await prefsStore.setJSON(key,next);
    return json({prefs:next});
  }

  return json({error:"Method not allowed"},405);
}
export const config={path:"/api/preferences"};
