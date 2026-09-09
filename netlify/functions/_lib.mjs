
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const DATA_SCHEMA_VERSION = 4;

export const users=getStore("sv-users");
export const sessions=getStore("sv-sessions");
export const recovery=getStore("sv-recovery");
export const reportsStore=getStore("sv-reports");
export const decksStore=getStore("sv-decks");
export const prefsStore=getStore("sv-prefs");
export const metaStore=getStore("sv-meta");
export const summariesStore=getStore("sv-summaries");
export const votesStore=getStore("sv-votes");

export function corsHeaders(){
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Cache-Control": "no-store"
  };
}

export function json(data,status=200){
  return Response.json(data,{
    status,
    headers:corsHeaders()
  });
}

export function options(){
  return new Response(null,{
    status:204,
    headers:corsHeaders()
  });
}
export function cleanName(v){
  return String(v||"").trim().replace(/\s+/g," ").slice(0,40);
}
export function hash(v){
  return crypto.createHash("sha256").update(String(v)).digest("hex");
}
export function recoveryCode(){
  const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s="";
  for(let i=0;i<8;i++)s+=chars[crypto.randomInt(chars.length)];
  return `SV-${s.slice(0,4)}-${s.slice(4)}`;
}
export async function makeSession(userId){
  const token=crypto.randomBytes(32).toString("base64url");
  const now=Date.now();
  await sessions.setJSON(hash(token),{
    schemaVersion:DATA_SCHEMA_VERSION,
    userId,
    createdAt:new Date(now).toISOString(),
    expiresAt:new Date(now + 180*24*60*60*1000).toISOString()
  });
  return token;
}
export async function auth(req){
  const h=req.headers.get("authorization")||"";
  if(!h.startsWith("Bearer "))return null;
  const s=await sessions.get(hash(h.slice(7)),{type:"json",consistency:"strong"});
  if(!s?.userId)return null;
  if(s.expiresAt && Date.parse(s.expiresAt)<Date.now()){
    await sessions.delete(hash(h.slice(7)));
    return null;
  }
  const raw=await users.get(s.userId,{type:"json",consistency:"strong"});
  if(!raw)return null;
  const user=normalizeUser(raw);
  if(user.schemaVersion!==raw.schemaVersion){
    await users.setJSON(user.id,user);
  }
  return {user,token:h.slice(7)};
}

export function normalizeUser(raw){
  return {
    schemaVersion:DATA_SCHEMA_VERSION,
    id:String(raw?.id||""),
    name:cleanName(raw?.name||"Student")||"Student",
    createdAt:raw?.createdAt||new Date().toISOString(),
    updatedAt:raw?.updatedAt||raw?.createdAt||new Date().toISOString()
  };
}

export function normalizeReport(raw){
  return {
    schemaVersion:DATA_SCHEMA_VERSION,
    id:String(raw?.id||""),
    semester:String(raw?.semester||""),
    jahr:Number(raw?.jahr)||new Date().getFullYear(),
    fach:String(raw?.fach||"").slice(0,100),
    pruefer:String(raw?.pruefer||"").slice(0,100),
    themen:String(raw?.themen||"").slice(0,7000),
    tipps:String(raw?.tipps||"").slice(0,7000),
    schwierigkeit:String(raw?.schwierigkeit||"Mittel"),
    form:String(raw?.form||"Klausur"),
    authorId:String(raw?.authorId||""),
    authorName:String(raw?.authorName||"Unbekannt").slice(0,40),
    helpfulCount:Math.max(0,Number(raw?.helpfulCount)||0),
    createdAt:raw?.createdAt||new Date().toISOString(),
    updatedAt:raw?.updatedAt||raw?.createdAt||new Date().toISOString()
  };
}

export function normalizeDeck(raw,userId){
  const cards=Array.isArray(raw?.cards)?raw.cards:[];
  const progress=(raw?.progress && typeof raw.progress==="object")?raw.progress:{};
  return {
    schemaVersion:DATA_SCHEMA_VERSION,
    id:String(raw?.id||crypto.randomUUID()),
    userId:String(raw?.userId||userId||""),
    name:String(raw?.name||"Lernkartenset").slice(0,120),
    fileName:String(raw?.fileName||"").slice(0,180),
    difficulty:String(raw?.difficulty||"mittel"),
    focus:String(raw?.focus||"gemischt"),
    language:String(raw?.language||"Deutsch"),
    cards,
    progress,
    createdAt:raw?.createdAt||new Date().toISOString(),
    updatedAt:raw?.updatedAt||raw?.createdAt||new Date().toISOString()
  };
}

export function normalizePrefs(raw,userId){
  return {
    schemaVersion:DATA_SCHEMA_VERSION,
    userId:String(raw?.userId||userId||""),
    favorites:Array.isArray(raw?.favorites)?[...new Set(raw.favorites.map(String))].slice(0,500):[],
    helpfulReports:Array.isArray(raw?.helpfulReports)?[...new Set(raw.helpfulReports.map(String))].slice(0,500):[],
    lastActiveDeckId:raw?.lastActiveDeckId?String(raw.lastActiveDeckId):null,
    updatedAt:raw?.updatedAt||new Date().toISOString()
  };
}

export async function ensureSchemaMeta(){
  const current=await metaStore.get("schema",{type:"json",consistency:"strong"});
  if(!current || Number(current.version)!==DATA_SCHEMA_VERSION){
    await metaStore.setJSON("schema",{
      version:DATA_SCHEMA_VERSION,
      updatedAt:new Date().toISOString(),
      migrationPolicy:"read-normalize-write"
    });
  }
}
