
import crypto from "node:crypto";
import {
  users,recovery,sessions,reportsStore,decksStore,prefsStore,json,cleanName,hash,recoveryCode,makeSession,auth,
  DATA_SCHEMA_VERSION,normalizeUser,normalizeReport,ensureSchemaMeta
} from "./_lib.mjs";

export default async function(req){
  await ensureSchemaMeta();
  const url=new URL(req.url);
  const action=url.searchParams.get("action")||"me";

  if(action==="me"){
    const a=await auth(req);
    return a?json({user:a.user,schemaVersion:DATA_SCHEMA_VERSION}):json({error:"Session abgelaufen."},401);
  }

  if(req.method!=="POST")return json({error:"Method not allowed"},405);

  let b={};
  try{b=await req.json()}catch{return json({error:"Ungültige Anfrage."},400)}

  if(action==="create"){
    const name=cleanName(b.name);
    if(name.length<2)return json({error:"Bitte gib einen Namen mit mindestens 2 Zeichen ein."},400);

    const id=crypto.randomUUID();
    let code=recoveryCode();
    while(await recovery.get(hash(code),{type:"json"}))code=recoveryCode();

    const user=normalizeUser({
      schemaVersion:DATA_SCHEMA_VERSION,
      id,name,
      createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString()
    });

    await users.setJSON(id,user,{onlyIfNew:true});
    await recovery.setJSON(hash(code),{
      schemaVersion:DATA_SCHEMA_VERSION,
      userId:id,
      createdAt:new Date().toISOString()
    });

    const sessionToken=await makeSession(id);
    return json({user,sessionToken,recoveryCode:code,schemaVersion:DATA_SCHEMA_VERSION});
  }

  if(action==="recover"){
    const code=String(b.recoveryCode||"").trim().toUpperCase();
    const hit=await recovery.get(hash(code),{type:"json",consistency:"strong"});
    if(!hit?.userId)return json({error:"Recovery-Code nicht gefunden."},404);

    const raw=await users.get(hit.userId,{type:"json",consistency:"strong"});
    if(!raw)return json({error:"Account nicht gefunden."},404);

    const user=normalizeUser(raw);
    await users.setJSON(user.id,user);
    const sessionToken=await makeSession(user.id);
    return json({user,sessionToken,schemaVersion:DATA_SCHEMA_VERSION});
  }


  if(action==="delete"){
    const a=await auth(req);
    if(!a)return json({error:"Bitte melde dich erneut an."},401);

    const confirmName=cleanName(b.confirmName);
    if(confirmName!==a.user.name){
      return json({error:"Der eingegebene Name stimmt nicht mit diesem Account überein."},400);
    }

    const userId=a.user.id;

    // 1) Delete all private learning decks.
    const deckPrefix=`user/${userId}/deck/`;
    const deckList=await decksStore.list({prefix:deckPrefix});
    for(const item of deckList.blobs||[]){
      await decksStore.delete(item.key);
    }

    // 2) Delete private preferences/favorites.
    await prefsStore.delete(`user/${userId}/prefs`);

    // 3) Delete all published reports authored by this account.
    const reportList=await reportsStore.list({prefix:"report/"});
    for(const item of reportList.blobs||[]){
      const raw=await reportsStore.get(item.key,{type:"json"});
      if(!raw)continue;
      const report=normalizeReport(raw);
      if(report.authorId===userId){
        await reportsStore.delete(item.key);
      }
    }

    // 4) Delete recovery mappings pointing to this user.
    const recoveryList=await recovery.list();
    for(const item of recoveryList.blobs||[]){
      const rec=await recovery.get(item.key,{type:"json"});
      if(rec?.userId===userId){
        await recovery.delete(item.key);
      }
    }

    // 5) Delete every active session for this user.
    const sessionList=await sessions.list();
    for(const item of sessionList.blobs||[]){
      const ses=await sessions.get(item.key,{type:"json"});
      if(ses?.userId===userId){
        await sessions.delete(item.key);
      }
    }

    // 6) Finally remove the user record itself.
    await users.delete(userId);

    return json({ok:true,deletedUserId:userId});
  }

  return json({error:"Unbekannte Aktion."},400);
}
export const config={path:"/api/account",rateLimit:{windowLimit:20,windowSize:60,aggregateBy:["ip","domain"]}};
